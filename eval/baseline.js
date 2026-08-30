const Anthropic = require('@anthropic-ai/sdk');

const { getCase, publicCase, candlesFor } = require('./cases');
const { STRATEGY_NOTES } = require('./agent/tools');
const { loadStrategy } = require('./lib/backtest');

/**
 * The baseline: one direct prompt with basic instructions.
 *
 * This is what someone does before building anything - describe the strategy
 * and the price history to a capable model and ask it to judge. It is given
 * the same question, the same case, the same strategy rules and the same cost
 * model as the agent. What it does not have is the ability to measure: no
 * backtest, no out-of-sample split it can actually run, no way to charge
 * costs and see what survives.
 *
 * The comparison is deliberately not rigged. The baseline sees a downsampled
 * price series rather than 3000 raw candles because a fair baseline is the
 * best version of the simple approach, and pasting 3000 OHLC rows into a
 * prompt is a worse way to convey the shape of a series, not a better one.
 */

const DEFAULT_MODEL = process.env.EVAL_MODEL || 'claude-opus-5';
const SAMPLE_POINTS = 200;

function downsample(candles, points) {
  const step = Math.max(1, Math.floor(candles.length / points));
  const out = [];
  for (let i = 0; i < candles.length; i += step) {
    out.push(Number(candles[i].close.toFixed(5)));
  }
  return out;
}

function buildPrompt(caseId) {
  const testCase = getCase(caseId);
  const info = publicCase(caseId);
  const strategy = loadStrategy(testCase.strategy);
  const closes = downsample(candlesFor(caseId), SAMPLE_POINTS);

  return `Does this strategy have an edge on this instrument after costs?

Strategy: ${strategy.name}
Rules: ${STRATEGY_NOTES[strategy.name]}
Parameters: ${JSON.stringify(strategy.defaultParams)}

Instrument: ${info.symbol}, ${info.timeframe}, ${info.bars} bars.
Contract size 100000, minimum lot 0.01.

Costs charged on every trade:
${JSON.stringify(info.costModel)}
(commission is per lot per side)

Closing prices, sampled evenly across the full history (${closes.length} points):
${JSON.stringify(closes)}

Answer with JSON only, no other text:
{"verdict": "EDGE" | "NO_EDGE", "confidence": "low" | "medium" | "high", "reasoning": "<a few sentences>"}

EDGE means you would tell someone their money is more likely to grow than shrink trading this. NO_EDGE means it is not.`;
}

function parseVerdict(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed.verdict !== 'EDGE' && parsed.verdict !== 'NO_EDGE') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function baselineCase({
  caseId,
  client = null,
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = DEFAULT_MODEL
} = {}) {
  const anthropic = client || new Anthropic({ apiKey });
  const prompt = buildPrompt(caseId);

  const response = await anthropic.messages.create({
    model,
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }]
  });

  if (response.stop_reason === 'refusal') {
    return {
      caseId, verdict: null, confidence: null,
      reasoning: 'the model declined to answer',
      backtestsRun: 0,
      usage: { input_tokens: response.usage?.input_tokens || 0, output_tokens: response.usage?.output_tokens || 0 },
      model,
      trajectory: [{ role: 'user', content: prompt }, { role: 'system', event: 'refusal' }]
    };
  }

  const text = (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  const parsed = parseVerdict(text);

  return {
    caseId,
    verdict: parsed?.verdict || null,
    confidence: parsed?.confidence || null,
    reasoning: parsed?.reasoning || text.slice(0, 400),
    backtestsRun: 0,
    usage: {
      input_tokens: response.usage?.input_tokens || 0,
      output_tokens: response.usage?.output_tokens || 0
    },
    model,
    trajectory: [
      { role: 'user', content: prompt },
      { role: 'assistant', content: text }
    ]
  };
}

module.exports = { baselineCase, buildPrompt, DEFAULT_MODEL };
