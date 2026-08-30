const test = require('node:test');
const assert = require('node:assert');

const { CASES, getCase, publicCase } = require('../cases');
const { backtestCase } = require('../lib/backtest');
const { createTools } = require('../agent/tools');
const { verify } = require('../agent/verifier');
const { validateCase } = require('../agent/validator');

/**
 * Everything here runs offline: no database, no API key, no broker. The model
 * is replaced by a scripted stub, so the loop, the tools and the verifier can
 * be checked deterministically and for free.
 */

test('the eval set is balanced and labelled', () => {
  assert.equal(CASES.length, 16);
  assert.equal(CASES.filter((c) => c.truth === 'EDGE').length, 4);
  assert.equal(CASES.filter((c) => c.truth === 'NO_EDGE').length, 12);
});

test('case generation is deterministic', () => {
  const first = backtestCase({ caseId: 'planted-momentum-1', window: 'out_of_sample' });
  const second = backtestCase({ caseId: 'planted-momentum-1', window: 'out_of_sample' });
  assert.deepEqual(first, second);
});

test('nothing the agent can see leaks the answer', () => {
  const info = publicCase('cost-trap-1');
  const serialised = JSON.stringify(info);
  assert.ok(!serialised.includes('EDGE'), 'public case description must not carry the label');
  assert.ok(!Object.keys(info).includes('truth'));

  const tools = createTools('cost-trap-1');
  for (const name of ['describe_case', 'describe_strategy']) {
    assert.ok(!JSON.stringify(tools.call(name, {})).includes('NO_EDGE'));
  }
});

test('the ledger records what the agent actually measured', () => {
  const tools = createTools('random-walk-1');
  assert.equal(tools.ledger.length, 0);
  tools.call('run_backtest', { window: 'in_sample' });
  tools.call('sweep_parameter', { param: 'channelPeriod', values: [10, 20, 30], window: 'out_of_sample' });
  assert.equal(tools.ledger.length, 4);
  assert.equal(tools.ledger[0].window, 'in_sample');
});

test('a sweep is capped so one call cannot run hundreds of backtests', () => {
  const tools = createTools('random-walk-1');
  const out = tools.call('sweep_parameter', {
    param: 'channelPeriod', values: [5, 10, 15, 20, 25, 30, 35, 40, 45, 50], window: 'in_sample'
  });
  assert.equal(out.results.length, 8);
});

test('the verifier rejects a verdict with no out-of-sample evidence', () => {
  const check = verify({ verdict: 'EDGE', ledger: [], costModel: 'realistic' });
  assert.equal(check.supported, false);
  assert.match(check.reason, /out-of-sample/);
});

test('the verifier rejects an edge claim measured only at zero cost', () => {
  const ledger = [
    { window: 'out_of_sample', costModel: 'zero', netProfit: 900, trades: 60, returnPct: 9 }
  ];
  const check = verify({ verdict: 'EDGE', ledger, costModel: 'wide' });
  assert.equal(check.supported, false);
  assert.match(check.reason, /cost model/);
});

test('the verifier rejects an edge claim the cost-charged run does not support', () => {
  const ledger = [
    { window: 'out_of_sample', costModel: 'wide', netProfit: -400, trades: 70, returnPct: -4 }
  ];
  const check = verify({ verdict: 'EDGE', ledger, costModel: 'wide' });
  assert.equal(check.supported, false);
  assert.match(check.reason, /NO_EDGE/);
});

test('the verifier accepts a supported edge claim', () => {
  const ledger = [
    { window: 'out_of_sample', costModel: 'realistic', netProfit: 1200, trades: 60, returnPct: 12 }
  ];
  assert.equal(verify({ verdict: 'EDGE', ledger, costModel: 'realistic' }).supported, true);
});

test('a profitable run on too few trades is not enough', () => {
  const ledger = [
    { window: 'out_of_sample', costModel: 'realistic', netProfit: 1200, trades: 4, returnPct: 12 }
  ];
  assert.equal(verify({ verdict: 'EDGE', ledger, costModel: 'realistic' }).supported, false);
});

/** A stub that plays a fixed script of assistant turns. */
function stubClient(turns) {
  let index = 0;
  return {
    messages: {
      create: async () => {
        const turn = turns[Math.min(index, turns.length - 1)];
        index += 1;
        return { content: turn, stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } };
      }
    }
  };
}

test('an unsupported verdict is sent back once, and the retry is accepted', async () => {
  const client = stubClient([
    // First attempt: claims an edge having measured nothing.
    [{ type: 'tool_use', id: 't1', name: 'submit_verdict',
      input: { verdict: 'EDGE', confidence: 'high', reasoning: 'looks strong', evidence: [] } }],
    // After rejection: actually runs the out-of-sample backtest.
    [{ type: 'tool_use', id: 't2', name: 'run_backtest',
      input: { window: 'out_of_sample' } }],
    // Then submits the answer the evidence supports.
    [{ type: 'tool_use', id: 't3', name: 'submit_verdict',
      input: { verdict: 'NO_EDGE', confidence: 'high', reasoning: 'negative after costs', evidence: ['oos'] } }]
  ]);

  const result = await validateCase({
    caseId: 'cost-trap-1', client, logger: { log: () => {} }
  });

  assert.equal(result.revisions, 1);
  assert.equal(result.verdict, 'NO_EDGE');
  assert.equal(result.verifierSupported, true);
  assert.equal(getCase('cost-trap-1').truth, 'NO_EDGE');
});

test('an agent that never gathers evidence still terminates', async () => {
  const client = stubClient([
    [{ type: 'tool_use', id: 'a', name: 'submit_verdict',
      input: { verdict: 'EDGE', confidence: 'high', reasoning: 'vibes', evidence: [] } }]
  ]);

  const result = await validateCase({
    caseId: 'random-walk-1', client, logger: { log: () => {} }
  });

  assert.equal(result.verdict, 'EDGE');
  assert.equal(result.verifierSupported, false, 'the claim must be marked unsupported');
});
