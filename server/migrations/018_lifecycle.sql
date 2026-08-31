-- The stages a combination moves through before it is allowed to trade.
--
--   research   the lab searches parameters here. Every strategy starts and
--              returns here, and it is the ONLY stage where searching happens.
--   backtest   the lab found parameters that cleared validate and holdout. A
--              confirmation run follows: those exact numbers, fixed, walked
--              forward across the whole period with no search at all.
--   enabled    confirmation passed. The scanner generates signals for this
--              combination, with these parameters, and nothing else.
--   demoted    live results fell below the threshold. Back to research, with
--              the reason kept.
--
-- Stage lives on strategy_promotions rather than in a second table because a
-- promotion row already holds everything a stage needs to be judged against:
-- the pinned parameters, the study behind them, and the two profit factors
-- that earned it. Splitting them would let a stage disagree with its own
-- evidence.
--
-- "research" has no row. A combination that has never left research is the
-- overwhelming majority - 214 of 216 studied so far - and writing a row for
-- each would make the table mostly a list of things that did not happen.

ALTER TABLE strategy_promotions
  ADD COLUMN stage ENUM('backtest', 'enabled', 'demoted') NOT NULL DEFAULT 'backtest'
    AFTER timeframe,
  -- The confirmation run: fixed parameters, no search, whole period. Distinct
  -- from study_id, which points at the search that chose the parameters and is
  -- therefore selected-for by construction.
  ADD COLUMN confirmation_run_id BIGINT UNSIGNED NULL AFTER study_id,
  -- Live performance, refreshed as trades close, so a demotion decision never
  -- depends on recomputing history at the moment it is made.
  ADD COLUMN live_trades INT UNSIGNED NOT NULL DEFAULT 0 AFTER trials,
  ADD COLUMN live_pf DECIMAL(10,4) NULL AFTER live_trades,
  ADD COLUMN demoted_at DATETIME NULL AFTER promoted_by,
  ADD COLUMN demote_reason VARCHAR(255) NULL AFTER demoted_at,
  ADD KEY idx_promotion_stage (stage);

-- Every transition, append-only.
--
-- Without this, "why is this trading?" has no answer a month later: the
-- promotion row shows the current stage and nothing about how it got there,
-- so a combination that was demoted, re-studied and re-enabled looks
-- identical to one that sailed through first time.
CREATE TABLE IF NOT EXISTS strategy_lifecycle_events (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  strategy_id  INT UNSIGNED NOT NULL,
  symbol_id    INT UNSIGNED NOT NULL,
  timeframe    VARCHAR(4) NOT NULL,
  from_stage   VARCHAR(16) NULL,
  to_stage     VARCHAR(16) NOT NULL,
  reason       VARCHAR(512) NULL,
  study_id     BIGINT UNSIGNED NULL,
  run_id       BIGINT UNSIGNED NULL,
  actor        VARCHAR(64) NOT NULL DEFAULT 'system',
  occurred_at  DATETIME NOT NULL,
  KEY idx_lifecycle_combo (strategy_id, symbol_id, timeframe),
  KEY idx_lifecycle_time (occurred_at),
  CONSTRAINT fk_lifecycle_strategy FOREIGN KEY (strategy_id) REFERENCES strategies (id),
  CONSTRAINT fk_lifecycle_symbol FOREIGN KEY (symbol_id) REFERENCES symbols (id)
) ENGINE = InnoDB;
