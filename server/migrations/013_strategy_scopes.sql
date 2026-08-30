-- Which symbols and timeframes a strategy is allowed to run on.
--
-- `strategies.enabled` was a single on/off, so enabling one ran it against
-- every enabled symbol on every traded timeframe. With nine strategies, five
-- symbols and five timeframes that is 225 combinations firing at once - and
-- because they read the same candles, a real move fires most of them
-- together. Measured: seven near-identical long positions opened inside ten
-- minutes and lost 8,716 between them.
--
-- A scope narrows a strategy to the combinations it has actually earned. A
-- strategy with NO scope rows keeps the old behaviour and runs everywhere,
-- so nothing changes until someone deliberately narrows it.
CREATE TABLE strategy_scopes (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  strategy_id INT UNSIGNED NOT NULL,
  -- NULL means "any symbol", so a strategy can be scoped to a timeframe
  -- without naming every instrument.
  symbol_id   INT UNSIGNED NULL,
  -- NULL means "any timeframe", for the same reason.
  timeframe   VARCHAR(4)   NULL,
  created_at  DATETIME     NOT NULL,
  UNIQUE KEY uq_strategy_scope (strategy_id, symbol_id, timeframe),
  KEY idx_strategy_scopes_strategy (strategy_id),
  CONSTRAINT fk_strategy_scopes_strategy FOREIGN KEY (strategy_id) REFERENCES strategies(id) ON DELETE CASCADE,
  CONSTRAINT fk_strategy_scopes_symbol   FOREIGN KEY (symbol_id)   REFERENCES symbols(id)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
