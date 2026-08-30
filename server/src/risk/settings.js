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
  consecutiveLossLimit: 3,
  newsBlackoutMinutes: 15,
  // Position notional as a multiple of equity. A correct 1% risk on a very
  // tight stop can still imply an enormous position - measured: a $9 stop on
  // ETH produced 147 lots, about $363,000 of notional on a $133,000 account.
  maxNotionalMultiple: 5
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
