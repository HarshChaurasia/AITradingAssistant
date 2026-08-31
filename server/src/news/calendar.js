const { query } = require('../db/pool');

/**
 * The economic calendar.
 *
 * The news_blackout risk gate has existed since the beginning and has never
 * once blocked a trade, because nothing ever populated news_events. It has
 * been reporting "no high impact news within 15 minutes" for every signal
 * ever assessed - true only in the sense that an empty table contains no
 * events. A gate reading an empty table is indistinguishable from a gate that
 * works, which is the worst kind of safety feature.
 *
 * The MetaTrader5 Python package has no calendar API - checked, the same way
 * the session functions turned out to be MQL5-only - so the data comes from
 * the ForexFactory weekly feed, which is public, keyless and returns the
 * currency codes this system already uses.
 */

const FEED_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

const IMPACT = {
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
  holiday: 'LOW'
};

function toMysqlUtc(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Normalise one feed row.
 *
 * Returns null rather than a partial row for anything unusable. A calendar
 * entry with no time is not an event this system can reason about, and
 * storing it with a guessed timestamp would put a blackout window in the
 * wrong place.
 */
function normaliseEvent(raw) {
  const eventTime = toMysqlUtc(raw.date);
  if (!eventTime || !raw.title) return null;

  // The feed's "country" is already a currency code for everything except
  // "All", which marks summits and G20-style meetings that belong to no single
  // currency. Those are kept with a null currency so they show on the screen
  // without silently widening a blackout for every pair.
  const currency = !raw.country || raw.country === 'All' ? null : String(raw.country).slice(0, 8);

  return {
    eventTime,
    currency,
    title: String(raw.title).slice(0, 255),
    impact: IMPACT[String(raw.impact || '').toLowerCase()] || 'LOW',
    forecast: raw.forecast || null,
    previous: raw.previous || null
  };
}

/**
 * Fetch the week's calendar and store it.
 *
 * Upserts on (event_time, title): the feed republishes the same week many
 * times as forecasts firm up, and a re-fetch must not create a second copy of
 * every event.
 */
async function syncCalendar({
  fetchImpl = globalThis.fetch,
  url = FEED_URL,
  logger = console
} = {}) {
  let payload;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      return { ok: false, reason: `calendar feed returned ${response.status}`, stored: 0 };
    }
    payload = await response.json();
  } catch (error) {
    // A calendar outage must never break a scheduler tick. The gate then sees
    // whatever is already stored, which is the honest fallback.
    logger.error(`calendar sync failed: ${error.message}`);
    return { ok: false, reason: error.message, stored: 0 };
  }

  if (!Array.isArray(payload)) {
    return { ok: false, reason: 'the calendar feed was not a list of events', stored: 0 };
  }

  let stored = 0;
  let skipped = 0;

  for (const raw of payload) {
    const event = normaliseEvent(raw);
    if (!event) { skipped += 1; continue; }

    await query(
      `INSERT INTO news_events (event_time, currency, title, source, impact, url)
       VALUES (?, ?, ?, 'forexfactory', ?, NULL)
       ON DUPLICATE KEY UPDATE
         currency = VALUES(currency), impact = VALUES(impact), source = VALUES(source)`,
      [event.eventTime, event.currency, event.title, event.impact]
    );
    stored += 1;
  }

  return { ok: true, received: payload.length, stored, skipped };
}

/**
 * Events near an instant, for one or both of a symbol's currencies.
 *
 * `withinMinutes` is deliberately a parameter rather than a constant: how far
 * an event reaches depends on the timeframe being traded, and a fifteen-minute
 * window around a rate decision means something very different to an M5 scalp
 * than to a signal on a four-hour bar.
 */
async function eventsNear({ currencies, at = new Date(), withinMinutes = 60, minImpact = 'HIGH' }) {
  const list = (currencies || []).filter(Boolean);
  const windowMs = withinMinutes * 60 * 1000;
  const from = new Date(at.getTime() - windowMs);
  const to = new Date(at.getTime() + windowMs);

  const impacts = minImpact === 'HIGH' ? ['HIGH'] : ['HIGH', 'MEDIUM'];
  const params = [
    from.toISOString().slice(0, 19).replace('T', ' '),
    to.toISOString().slice(0, 19).replace('T', ' '),
    ...impacts
  ];

  // Currency-less events (summits, G20) are excluded from the gate on purpose:
  // they belong to no pair, and letting them match everything would blackout
  // the entire book for a scheduled photo opportunity.
  let currencyClause = '';
  if (list.length > 0) {
    currencyClause = `AND currency IN (${list.map(() => '?').join(',')})`;
    params.push(...list);
  } else {
    currencyClause = 'AND 1 = 0';
  }

  return query(
    `SELECT title, currency, event_time, impact
       FROM news_events
      WHERE event_time BETWEEN ? AND ?
        AND impact IN (${impacts.map(() => '?').join(',')})
        ${currencyClause}
      ORDER BY event_time
      LIMIT 20`,
    params
  );
}

/**
 * Upcoming events, for the dashboard.
 */
async function upcoming({ hours = 48, minImpact = 'MEDIUM' } = {}) {
  const impacts = minImpact === 'HIGH' ? ['HIGH'] : ['HIGH', 'MEDIUM'];
  const safeHours = Math.min(Math.max(Number.parseInt(hours, 10) || 48, 1), 720);

  return query(
    `SELECT title, currency, event_time, impact
       FROM news_events
      WHERE event_time BETWEEN DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 HOUR)
                           AND DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${safeHours} HOUR)
        AND impact IN (${impacts.map(() => '?').join(',')})
      ORDER BY event_time
      LIMIT 100`,
    impacts
  );
}

module.exports = { syncCalendar, eventsNear, upcoming, normaliseEvent, FEED_URL };
