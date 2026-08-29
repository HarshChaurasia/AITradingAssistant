const { query } = require('../db/pool');

const DEFAULT_RISK_SETTINGS = {
  riskPctPerTrade: 1.0,
  dailyLossCapPct: 5.0,
  maxConcurrentPositions: 2,
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
