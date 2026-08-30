const { getCase } = require('../cases');

/**
 * Renders the comparison table the report is built from.
 *
 * Two things are deliberately given equal weight to accuracy. The false-edge
 * rate, because calling a dead strategy tradeable is the error that actually
 * costs the user money and accuracy alone hides it. And cost per case, because
 * an improvement nobody can afford to run is not an improvement.
 */

function pct(n) {
  return `${n}%`;
}

function delta(baseline, agent, { higherIsBetter = true } = {}) {
  const change = Number((agent - baseline).toFixed(1));
  if (change === 0) return 'no change';
  const sign = change > 0 ? '+' : '';
  const better = higherIsBetter ? change > 0 : change < 0;
  return `${sign}${change} ${better ? 'better' : 'worse'}`;
}

function comparisonTable(baseline, agent) {
  const rows = [
    ['Verdict accuracy', pct(baseline.accuracyPct), pct(agent.accuracyPct),
      delta(baseline.accuracyPct, agent.accuracyPct)],
    ['False "edge" rate (money-losing error)', pct(baseline.falseEdgePct), pct(agent.falseEdgePct),
      delta(baseline.falseEdgePct, agent.falseEdgePct, { higherIsBetter: false })],
    ['Missed real edges', pct(baseline.missedEdgePct), pct(agent.missedEdgePct),
      delta(baseline.missedEdgePct, agent.missedEdgePct, { higherIsBetter: false })],
    ['Backtests run', String(baseline.backtestsRun), String(agent.backtestsRun), '-'],
    ['Cost per case (USD)',
      baseline.costPerCaseUsd === null ? 'n/a' : `$${baseline.costPerCaseUsd}`,
      agent.costPerCaseUsd === null ? 'n/a' : `$${agent.costPerCaseUsd}`, '-'],
    ['Wall clock (s)', String(baseline.wallClockSeconds), String(agent.wallClockSeconds), '-']
  ];

  return [
    '| Metric | Simple baseline | Agent | Change |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.join(' | ')} |`)
  ].join('\n');
}

function archetypeTable(baseline, agent) {
  const names = Object.keys(agent.byArchetype);
  const rows = names.map((name) => {
    const b = baseline.byArchetype[name];
    const a = agent.byArchetype[name];
    return `| ${name} | ${b.correct}/${b.total} | ${a.correct}/${a.total} |`;
  });
  return ['| Case type | Baseline | Agent |', '| --- | --- | --- |', ...rows].join('\n');
}

function caseTable(summary) {
  const rows = summary.rows.map((r) => {
    const { archetype } = getCase(r.caseId);
    return `| ${r.caseId} | ${archetype} | ${r.truth} | ${r.verdict || 'no answer'} `
      + `| ${r.correct ? 'yes' : 'NO'} |`;
  });
  return ['| Case | Type | Truth | Verdict | Correct |', '| --- | --- | --- | --- | --- |', ...rows]
    .join('\n');
}

function writeReport({ ranAt, cases, summaries }) {
  const { baseline, agent } = summaries;
  const lines = [`# Evaluation results`, '', `Run ${ranAt} over ${cases.length} cases.`, ''];

  if (baseline && agent) {
    lines.push(`Model: ${agent.model} for both arms.`, '');
    lines.push(comparisonTable(baseline, agent), '');
    lines.push('## By case type', '', archetypeTable(baseline, agent), '');
    lines.push('## Agent, case by case', '', caseTable(agent), '');
    lines.push('## Baseline, case by case', '', caseTable(baseline), '');
  } else {
    const only = agent || baseline;
    lines.push(`Model: ${only.model}. Single arm: ${only.mode}.`, '');
    lines.push(`Accuracy ${pct(only.accuracyPct)}, false-edge rate ${pct(only.falseEdgePct)}, `
      + `cost per case ${only.costPerCaseUsd === null ? 'n/a' : `$${only.costPerCaseUsd}`}.`, '');
    lines.push(caseTable(only), '');
  }

  return lines.join('\n');
}

module.exports = { writeReport, comparisonTable };
