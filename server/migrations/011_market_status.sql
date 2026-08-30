-- Replace the weekly session calendar with a live market-status probe.
--
-- 010 stored a per-symbol weekly calendar read from symbol_info_session_trade.
-- That function is MQL5-only: it does not exist in the MetaTrader5 Python
-- package, so every fetch silently produced seven empty days and the gate
-- would have refused every symbol on every day of the week. Verified against
-- the live terminal before this shipped, which is the only reason it was
-- caught - the failure raised nothing and logged nothing.
--
-- The replacement asks the broker directly, with order_check, and caches the
-- answer here. It is a snapshot, not a calendar, so it carries the time it was
-- taken: a status nobody has refreshed is not evidence that a market is open.
ALTER TABLE symbols
  DROP COLUMN sessions,
  DROP COLUMN sessions_synced_at,
  ADD COLUMN market_open       TINYINT(1)   NULL AFTER trade_mode,
  ADD COLUMN market_reason     VARCHAR(255) NULL AFTER market_open,
  ADD COLUMN market_checked_at DATETIME     NULL AFTER market_reason,
  -- Seconds since the last quote when the probe ran. Kept for diagnosis: a
  -- market reported open with an hour-old tick is worth knowing about.
  ADD COLUMN tick_age_seconds  INT UNSIGNED NULL AFTER market_checked_at;
