-- The broker's own weekly trading calendar, per symbol.
--
-- Without this the system has no way to know that EURUSD is shut on a Sunday
-- while BTCUSD is not, so it generates weekend signals for instruments that
-- cannot be traded and the broker rejects the orders. Guessing from a
-- hardcoded "forex closes at the weekend" rule would be wrong in both
-- directions: crypto trades through it, and plenty of instruments close early
-- on a Friday or take a daily break.
--
-- `sessions` is a JSON array of seven entries indexed by the MT5 day-of-week
-- enum (0 = Sunday), each a list of [from, to] pairs in SECONDS FROM MIDNIGHT
-- IN BROKER TIME. An empty list means the symbol does not trade that day.
ALTER TABLE symbols
  -- ENUM_SYMBOL_TRADE_MODE: 0 disabled, 1 long only, 2 short only,
  -- 3 close only, 4 full. Anything below 4 is not freely tradeable.
  ADD COLUMN trade_mode         TINYINT UNSIGNED NULL AFTER watched,
  ADD COLUMN sessions           JSON             NULL AFTER trade_mode,
  -- NULL here means "never fetched", which is a different statement from
  -- "fetched and the broker said this symbol never trades". The gate treats
  -- them differently, so the distinction has to survive in the schema.
  ADD COLUMN sessions_synced_at DATETIME         NULL AFTER sessions;
