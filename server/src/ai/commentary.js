const Anthropic = require('@anthropic-ai/sdk');

const { query } = require('../db/pool');
const { getCandles } = require('../market/candles');
const { ema, rsi, atr, donchian } = require('../indicators');

/**
 * Plain-English commentary on the current market state.
 *
 * STRICTLY ADVISORY. This is never called before an order, and its output is
 * never parsed into a decision. An LLM in the signal path makes the strategy
 * non-deterministic and therefore unbacktestable, which defeats the purpose of
 * the whole system. This is a reading aid for the operator.
 */

const MODEL = 'claude-opus-5';

async function marketCommentary({
  symbolId,
  timeframe = 'H1',
  apiKey = process.env.ANTHROPIC_API_KEY,
  client = null,
  logger = console
} = {}) {
  if (!apiKey && !client) {
    return { available: false, reason: 'commentary is not configured (set ANTHROPIC_API_KEY)' };
  }

  const symbolRows = await query('SELECT * FROM symbols WHERE id = ?', [symbolId]);
  if (symbolRows.length === 0) {
    return { available: false, reason: `unknown symbolId ${symbolId}` };
  }
  const symbol = symbolRows[0];

  const candles = await getCandles({ symbolId, timeframe, limit: 300 });
  if (candles.length < 120) {
    return { available: false, reason: `no candles stored for ${symbol.broker_symbol} ${timeframe}` };
  }

  const closes = candles.map((c) => c.close);
  const last = candles.length - 1;
  const channel = donchian(candles, 20);

  // Indicator values, not raw candles: a few numbers describe the state far
  // better than 300 rows of OHLC, at a fraction of the tokens.
  const snapshot = {
    symbol: symbol.broker_symbol,
    timeframe,
    lastClose: closes[last],
    ema20: ema(closes, 20)[last],
    ema50: ema(closes, 50)[last],
    ema100: ema(closes, 100)[last],
    rsi14: rsi(closes, 14)[last],
    atr14: atr(candles, 14)[last],
    donchianHigh20: channel.upper[last],
    donchianLow20: channel.lower[last],
    barsCovered: candles.length
  };

  const news = await query(
    `SELECT event_time, currency, title, impact
       FROM news_events
      WHERE impact IN ('HIGH','MEDIUM')
        AND event_time BETWEEN UTC_TIMESTAMP() AND DATE_ADD(UTC_TIMESTAMP(), INTERVAL 12 HOUR)
      ORDER BY event_time LIMIT 5`
  );

  const prompt =
    'You are helping a retail trader read the current market state. Be concise and neutral.\n\n' +
    "Indicator snapshot (all prices in the instrument's own units):\n" +
    `${JSON.stringify(snapshot, null, 2)}\n\n` +
    'Upcoming economic events in the next 12 hours:\n' +
    `${news.length ? JSON.stringify(news, null, 2) : 'none recorded'}\n\n` +
    'In at most 120 words: describe the trend, where price sits relative to the ' +
    '20-bar channel, whether volatility is high or low for this instrument, and ' +
    'any event risk worth noting. Do NOT give a buy or sell recommendation and ' +
    'do NOT suggest entry, stop or target levels - those are decided by a ' +
    'separate rules engine.';

  const anthropic = client || new Anthropic({ apiKey });

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      // Thinking is on by default on this model and its tokens count against
      // max_tokens, so leave headroom well above the 120-word answer.
      max_tokens: 4000,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: prompt }]
    });

    if (response.stop_reason === 'refusal') {
      return { available: false, reason: 'the model declined to answer' };
    }

    const text = (response.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    return { available: true, text, snapshot };
  } catch (error) {
    logger.error(`commentary failed: ${error.message}`);
    return { available: false, reason: error.message };
  }
}

module.exports = { marketCommentary };
