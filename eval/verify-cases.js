const { CASES } = require('./cases');
const { backtestCase } = require('./lib/backtest');
const { CHECKS } = require('./lib/truth-checks');

/**
 * Proves the eval set's ground truth before the eval set is used to grade
 * anything.
 *
 * A label like "this case has no edge" is an assumption about the generator
 * until it is measured. If a random walk happened to hand the strategy a lucky
 * +9% out-of-sample, an agent that read the evidence correctly and said "no
 * edge" would be marked WRONG by its own label, and the whole comparison would
 * be noise dressed up as a result.
 *
 * Run this before trusting any number in the report.
 */

function measure(caseId) {
  return {
    isReal: backtestCase({ caseId, window: 'in_sample' }),
    oosReal: backtestCase({ caseId, window: 'out_of_sample' }),
    oosZero: backtestCase({ caseId, window: 'out_of_sample', costModel: 'zero' })
  };
}

function main() {
  let failures = 0;

  console.log('case                truth     IS %      OOS %   OOS 0-cost %  trades   label holds');
  console.log('-'.repeat(92));

  for (const testCase of CASES) {
    const m = measure(testCase.id);
    const check = CHECKS[testCase.archetype];
    const ok = check.holds(m);
    if (!ok) failures += 1;

    console.log(
      `${testCase.id.padEnd(19)} ${testCase.truth.padEnd(9)}`
      + `${String(m.isReal.returnPct).padStart(8)}`
      + `${String(m.oosReal.returnPct).padStart(11)}`
      + `${String(m.oosZero.returnPct).padStart(14)}`
      + `${String(m.oosReal.trades).padStart(8)}   `
      + `${ok ? 'yes' : `NO - needs ${check.detail(m)}`}`
    );
  }

  console.log('-'.repeat(92));
  if (failures > 0) {
    console.error(`\n${failures} of ${CASES.length} cases do not support their label.`);
    console.error('Re-run node eval/find-seeds.js to rebuild the set.');
    process.exit(1);
  }

  const edge = CASES.filter((c) => c.truth === 'EDGE').length;
  console.log(`\nAll ${CASES.length} cases support their ground-truth label `
    + `(${edge} EDGE, ${CASES.length - edge} NO_EDGE).`);
}

main();
