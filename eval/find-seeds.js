const fs = require('fs');
const path = require('path');

const { ARCHETYPES, COSTS, seriesFor } = require('./cases');
const { backtestSeries } = require('./lib/backtest');
const { CHECKS } = require('./lib/truth-checks');

/**
 * Finds price series that measurably exhibit the property their label claims.
 *
 * Generating a random walk does not guarantee it hands the strategy nothing
 * out-of-sample; over 1500 bars, luck happens. Rather than assume the label
 * and grade the agent against an assumption, this searches seeds until it
 * finds series where the property is demonstrably true, and records them.
 *
 * Run this only to regenerate the eval set. Day to day, verify-cases.js
 * re-proves the recorded seeds still hold.
 *
 *   node eval/find-seeds.js [wanted-per-archetype] [max-seed]
 */

const WANTED = Number(process.argv[2] || 4);
const MAX_SEED = Number(process.argv[3] || 600);

function measure(archetype, seed) {
  const spec = ARCHETYPES[archetype];
  const candles = seriesFor(archetype, seed);
  const run = (window, costModel) => backtestSeries({
    candles, strategyName: spec.strategy, window, costs: COSTS[costModel]
  });
  return {
    isReal: run('in_sample', spec.costs),
    oosReal: run('out_of_sample', spec.costs),
    oosZero: run('out_of_sample', 'zero')
  };
}

function main() {
  const found = {};

  for (const archetype of Object.keys(ARCHETYPES)) {
    const check = CHECKS[archetype];
    const seeds = [];

    for (let seed = 1; seed <= MAX_SEED && seeds.length < WANTED; seed += 1) {
      const m = measure(archetype, seed);
      if (check.holds(m)) {
        seeds.push(seed);
        console.log(`${archetype.padEnd(18)} seed ${String(seed).padStart(4)}  ${check.detail(m)}`);
      }
    }

    if (seeds.length < WANTED) {
      console.error(`\n${archetype}: found only ${seeds.length}/${WANTED} seeds under ${MAX_SEED}.`);
      process.exit(1);
    }
    found[archetype] = seeds;
  }

  const out = path.join(__dirname, 'case-seeds.json');
  fs.writeFileSync(out, `${JSON.stringify(found, null, 2)}\n`);
  console.log(`\nwrote ${out}`);
}

main();
