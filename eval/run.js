const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'server', '.env') });

const { CASES, getCase } = require('./cases');
const { validateCase } = require('./agent/validator');
const { baselineCase } = require('./baseline');
const { writeReport } = require('./lib/report');

/**
 * Runs the baseline and the agent over the same cases and scores both.
 *
 *   node eval/run.js                     both arms, all 16 cases
 *   node eval/run.js --mode agent        one arm
 *   node eval/run.js --cases cost-trap   one archetype
 *
 * Both arms get the identical case list, the identical question and the same
 * model. The only difference between them is the one being measured: whether
 * the model can run backtests, and whether its verdict has to survive a
 * verifier.
 */

// Anthropic list prices, USD per million tokens.
const PRICING = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 }
};

const CONCURRENCY = 4;

function parseArgs(argv) {
  const args = { mode: 'both', cases: null, model: null };
  for (let i = 2; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=');
    const value = inline !== undefined ? inline : argv[i + 1];
    if (flag === '--mode') { args.mode = value; if (inline === undefined) i += 1; }
    else if (flag === '--cases') { args.cases = value; if (inline === undefined) i += 1; }
    else if (flag === '--model') { args.model = value; if (inline === undefined) i += 1; }
  }
  return args;
}

function selectCases(filter) {
  if (!filter) return CASES.map((c) => c.id);
  const wanted = filter.split(',').map((s) => s.trim());
  const ids = CASES
    .filter((c) => wanted.includes(c.id) || wanted.includes(c.archetype))
    .map((c) => c.id);
  if (ids.length === 0) throw new Error(`no cases matched: ${filter}`);
  return ids;
}

/** Small fixed-size pool. Order of results is preserved. */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function costOf(usage, model) {
  const price = PRICING[model];
  if (!price) return null;
  return (usage.input_tokens / 1e6) * price.input + (usage.output_tokens / 1e6) * price.output;
}

function score(results) {
  const rows = results.map((r) => {
    const truth = getCase(r.caseId).truth;
    return { ...r, truth, correct: r.verdict === truth };
  });

  const answered = rows.filter((r) => r.verdict !== null);
  const noEdgeCases = rows.filter((r) => r.truth === 'NO_EDGE');
  const edgeCases = rows.filter((r) => r.truth === 'EDGE');

  // The error that costs money: calling a strategy tradeable when it is not.
  const falseEdges = noEdgeCases.filter((r) => r.verdict === 'EDGE');
  const missedEdges = edgeCases.filter((r) => r.verdict === 'NO_EDGE');

  const byArchetype = {};
  for (const row of rows) {
    const { archetype } = getCase(row.caseId);
    byArchetype[archetype] = byArchetype[archetype] || { total: 0, correct: 0 };
    byArchetype[archetype].total += 1;
    if (row.correct) byArchetype[archetype].correct += 1;
  }

  const usage = rows.reduce((acc, r) => ({
    input_tokens: acc.input_tokens + (r.usage?.input_tokens || 0),
    output_tokens: acc.output_tokens + (r.usage?.output_tokens || 0)
  }), { input_tokens: 0, output_tokens: 0 });

  const model = rows[0]?.model;
  const cost = costOf(usage, model);

  return {
    rows,
    total: rows.length,
    answered: answered.length,
    correct: rows.filter((r) => r.correct).length,
    accuracyPct: Number(((rows.filter((r) => r.correct).length / rows.length) * 100).toFixed(1)),
    falseEdges: falseEdges.length,
    falseEdgePct: noEdgeCases.length
      ? Number(((falseEdges.length / noEdgeCases.length) * 100).toFixed(1)) : 0,
    missedEdges: missedEdges.length,
    missedEdgePct: edgeCases.length
      ? Number(((missedEdges.length / edgeCases.length) * 100).toFixed(1)) : 0,
    byArchetype,
    usage,
    costUsd: cost === null ? null : Number(cost.toFixed(4)),
    costPerCaseUsd: cost === null ? null : Number((cost / rows.length).toFixed(4)),
    backtestsRun: rows.reduce((n, r) => n + (r.backtestsRun || 0), 0)
  };
}

function saveTrajectories(mode, results) {
  const dir = path.join(__dirname, 'results', 'trajectories', mode);
  fs.mkdirSync(dir, { recursive: true });
  for (const result of results) {
    fs.writeFileSync(
      path.join(dir, `${result.caseId}.json`),
      `${JSON.stringify({
        caseId: result.caseId,
        mode,
        model: result.model,
        verdict: result.verdict,
        truth: getCase(result.caseId).truth,
        trajectory: result.trajectory
      }, null, 2)}\n`
    );
  }
}

async function runArm(mode, caseIds, model) {
  const label = mode === 'agent' ? 'agent' : 'baseline';
  console.log(`\n=== ${label} (${caseIds.length} cases, ${model || 'default model'}) ===`);

  const started = Date.now();
  const results = await mapPool(caseIds, CONCURRENCY, async (caseId) => {
    const opts = model ? { caseId, model } : { caseId };
    const result = mode === 'agent' ? await validateCase(opts) : await baselineCase(opts);
    const truth = getCase(caseId).truth;
    const mark = result.verdict === truth ? 'ok  ' : 'MISS';
    console.log(
      `  ${mark} ${caseId.padEnd(19)} said ${String(result.verdict).padEnd(8)} `
      + `truth ${truth.padEnd(8)}`
      + (mode === 'agent' ? ` (${result.backtestsRun} backtests, ${result.revisions} revision)` : '')
    );
    return result;
  });

  const summary = score(results);
  summary.mode = label;
  summary.model = model || results[0]?.model;
  summary.wallClockSeconds = Number(((Date.now() - started) / 1000).toFixed(1));

  saveTrajectories(label, results);
  return summary;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      'No ANTHROPIC_API_KEY found. Put it in server/.env or export it, then re-run.
'
      + 'To check the harness itself without spending anything, run: npm run eval:test'
    );
    process.exit(1);
  }

  const caseIds = selectCases(args.cases);
  const arms = args.mode === 'both' ? ['baseline', 'agent'] : [args.mode];

  const summaries = {};
  for (const arm of arms) {
    summaries[arm] = await runArm(arm, caseIds, args.model);
  }

  const dir = path.join(__dirname, 'results');
  fs.mkdirSync(dir, { recursive: true });

  const payload = {
    ranAt: new Date().toISOString(),
    cases: caseIds,
    summaries
  };
  fs.writeFileSync(path.join(dir, 'latest.json'), `${JSON.stringify(payload, null, 2)}\n`);

  const report = writeReport(payload);
  fs.writeFileSync(path.join(dir, 'latest.md'), report);
  console.log(`\n${report}`);
  console.log(`results: eval/results/latest.json, eval/results/latest.md`);
  console.log('trajectories: eval/results/trajectories/<arm>/<case>.json');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
