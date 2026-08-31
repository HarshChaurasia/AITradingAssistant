const { query } = require('../db/pool');

const DEFAULT_RISK_SETTINGS = {
  riskPctPerTrade: 1.0,
  dailyLossCapPct: 5.0,
  maxConcurrentPositions: 2,
  // Positions in ONE instrument. Six strategies over five timeframes read the
  // same candles, so a real move fires most of them at once and arrives as
  // several near-identical orders seconds apart - measured: three BTCUSD buys
  // and two ETHUSD buys within two seconds, same stop, same target.
  //
  // Deliberately generous by default. Independent strategies agreeing is a
  // legitimate reason to be in a trade more than once, and that is the
  // operator's call to make - but it is one idea at several times the size,
  // so the dial exists and the account cap above still bounds the total.
  maxPositionsPerSymbol: 10,
  // Positions in one instrument facing the SAME WAY.
  //
  // The measured cost of not having this: of 50 closed trades, 29 arrived in
  // bursts of three or more within ten minutes, and those 29 lost 20,518
  // between them - 64% of everything lost. One move fires five strategies,
  // they all buy, and they all stop out together. The per-trade risk cap held
  // perfectly and the account still fell 6.5% in ten minutes, because the
  // positions were not independent.
  //
  // A hedge is not correlated exposure, so this counts direction rather than
  // instrument: being long and short BTCUSD at once is a different statement
  // from being long it five times.
  maxSameDirectionPerSymbol: 1,
  consecutiveLossLimit: 3,
  // The base blackout either side of a high-impact event, in minutes. It is a
  // FLOOR, not the whole story: the window also scales with the timeframe
  // being traded, because a signal on a four-hour bar is a claim about the
  // next several hours and an event inside that horizon matters far more to it
  // than to an M5 scalp that will be closed in twenty minutes.
  newsBlackoutMinutes: 15,
  // How much of the bar the blackout covers. 1.0 means an H4 signal is blocked
  // for four hours either side of a rate decision.
  newsBlackoutBarFraction: 1.0,
  // ...but never longer than this, or a D1 strategy would spend most of a busy
  // week refusing to trade at all.
  newsBlackoutMaxMinutes: 240,
  // Medium-impact events are reported but do not block. Blocking on them
  // silences the book for most of a normal week.
  newsBlackoutMinImpact: 'HIGH',
  // Position notional as a multiple of equity. A correct 1% risk on a very
  // tight stop can still imply an enormous position - measured: a $9 stop on
  // ETH produced 147 lots, about $363,000 of notional on a $133,000 account.
  maxNotionalMultiple: 5,
  /**
   * Refuse any signal whose strategy/symbol/timeframe combination has not
   * passed a backtest.
   *
   * OFF by default, and that default is not timidity. Switching it on with an
   * empty promotion table halts every trade on the account - correct
   * behaviour, and a terrible surprise. Turn it on once the lab has promoted
   * something, which is also the first moment it can do anything but stop
   * trading entirely.
   */
  requirePromotedCombination: false
};

async function loadRiskSettings() {
  const rows = await query('SELECT setting_value FROM settings WHERE setting_key = ?', ['risk']);
  return rows.length ? { ...DEFAULT_RISK_SETTINGS, ...rows[0].setting_value } : { ...DEFAULT_RISK_SETTINGS };
}

async function saveRiskSettings(patch) {
  const merged = { ...(await loadRiskSettings()), ...(patch || {}) };
  await query(
    `INSERT INTO settings (setting_key, setting_value, updated_at)
     VALUES ('risk', CAST(? AS JSON), UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = UTC_TIMESTAMP()`,
    [JSON.stringify(merged)]
  );
  return merged;
}

module.exports = { loadRiskSettings, saveRiskSettings, DEFAULT_RISK_SETTINGS };
