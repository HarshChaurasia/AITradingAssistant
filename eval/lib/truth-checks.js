/**
 * What must be measurably true of a case before its ground-truth label is
 * allowed to stand.
 *
 * Shared by find-seeds.js, which searches for series that satisfy these, and
 * by verify-cases.js, which re-proves them on every run. One definition, so
 * the set can never drift from the property it claims to test.
 */

const CHECKS = {
  'random-walk': {
    truth: 'NO_EDGE',
    describe: 'no out-of-sample edge after costs',
    holds: (m) => m.oosReal.returnPct <= 1.0 && m.oosReal.trades >= 20,
    detail: (m) => `out-of-sample after costs ${m.oosReal.returnPct}% <= 1% over ${m.oosReal.trades} trades (>= 20)`
  },
  'planted-momentum': {
    truth: 'EDGE',
    describe: 'a real edge that survives costs out-of-sample',
    // Capped as well as floored. An edge of several hundred percent would be
    // obvious from the equity curve alone, and a case nobody can get wrong
    // measures nothing. The band keeps these cases genuinely arguable.
    holds: (m) => m.oosReal.returnPct >= 8.0 && m.oosReal.returnPct <= 80.0 && m.oosReal.trades >= 20,
    detail: (m) => `out-of-sample after costs ${m.oosReal.returnPct}% in [8%, 80%] over ${m.oosReal.trades} trades (>= 20)`
  },
  'cost-trap': {
    truth: 'NO_EDGE',
    describe: 'profitable before costs, unprofitable after them',
    holds: (m) => m.oosZero.returnPct >= 5.0 && m.oosReal.returnPct < 0 && m.oosReal.trades >= 20,
    detail: (m) => `zero-cost ${m.oosZero.returnPct}% >= 5% and after-cost ${m.oosReal.returnPct}% < 0 over ${m.oosReal.trades} trades`
  },
  'overfit-trap': {
    truth: 'NO_EDGE',
    describe: 'strong in-sample, nothing out-of-sample',
    holds: (m) => m.isReal.returnPct >= 20 && m.oosReal.returnPct <= 1.0 && m.oosReal.trades >= 20,
    detail: (m) => `in-sample ${m.isReal.returnPct}% >= 20% and out-of-sample ${m.oosReal.returnPct}% <= 1% over ${m.oosReal.trades} trades`
  }
};

module.exports = { CHECKS };
