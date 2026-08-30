/**
 * Deterministic pseudo-randomness.
 *
 * Every case in the eval set is generated from a fixed integer seed, so a judge
 * running `npm run eval:cases` on a clean clone gets byte-identical price
 * series to the ones the reported results were produced from. Math.random()
 * would make the eval set unreproducible, which would make every number in the
 * report unverifiable.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller. Returns one standard normal per call. */
function gaussianFrom(rnd) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

module.exports = { mulberry32, gaussianFrom };
