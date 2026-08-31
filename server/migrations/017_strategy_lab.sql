-- Which strategy, on which symbol, on which timeframe, has earned the right
-- to trade - and the evidence it earned it with.
--
-- Until now `strategies.status` carried promotion for the strategy as a
-- whole, which cannot express the thing that actually matters: measured over
-- a year, smart-money on BTCUSD H1 reaches a profit factor of 1.40 while the
-- same strategy on M5 reaches 0.43. Promotion is a property of the
-- COMBINATION, never of the strategy.

CREATE TABLE IF NOT EXISTS strategy_promotions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  strategy_id   INT UNSIGNED NOT NULL,
  symbol_id     INT UNSIGNED NOT NULL,
  timeframe     VARCHAR(4) NOT NULL,
  -- The parameters the evidence was produced with. A promotion that does not
  -- pin these promotes a number rather than a strategy: the same code with a
  -- different stop multiple is a different bet.
  params        JSON NOT NULL,
  study_id      BIGINT UNSIGNED NULL,
  -- Copied from the study so a promotion stays readable after its study is
  -- pruned, and so the claim can be audited without a join.
  validate_pf   DECIMAL(10,4) NULL,
  holdout_pf    DECIMAL(10,4) NULL,
  trials        INT UNSIGNED NOT NULL DEFAULT 1,
  promoted_at   DATETIME NOT NULL,
  promoted_by   VARCHAR(64) NOT NULL DEFAULT 'system',
  -- Revocation rather than deletion: a combination that stopped working is
  -- evidence in its own right, and losing it would let the same one be
  -- promoted again next month with nobody the wiser.
  revoked_at    DATETIME NULL,
  revoked_note  VARCHAR(255) NULL,
  UNIQUE KEY uq_promotion (strategy_id, symbol_id, timeframe),
  KEY idx_promotion_active (revoked_at),
  CONSTRAINT fk_promotion_strategy FOREIGN KEY (strategy_id) REFERENCES strategies (id),
  CONSTRAINT fk_promotion_symbol FOREIGN KEY (symbol_id) REFERENCES symbols (id)
) ENGINE = InnoDB;

-- A parameter search and everything needed to judge whether to believe it.
--
-- `trials` is the column that earns this table its place. A profit factor of
-- 1.4 found on the fourth candidate and the same number found on the four
-- hundredth are different claims, and nothing in the metrics distinguishes
-- them: at four hundred trials, several candidates clear any threshold by
-- chance alone. Without the count there is no way to tell a discovery from a
-- lottery win, and the screen would report both as a pass.
CREATE TABLE IF NOT EXISTS strategy_studies (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  strategy_id    INT UNSIGNED NOT NULL,
  symbol_id      INT UNSIGNED NOT NULL,
  timeframe      VARCHAR(4) NOT NULL,
  started_at     DATETIME NOT NULL,
  finished_at    DATETIME NULL,
  iterations     INT UNSIGNED NOT NULL DEFAULT 0,
  trials         INT UNSIGNED NOT NULL DEFAULT 0,
  best_params    JSON NULL,
  -- The three windows, kept apart on purpose. Reading them side by side is
  -- how a reader sees a candidate that was tuned into the optimise window and
  -- fell apart the moment it met data it had not been fitted to.
  optimise       JSON NULL,
  validate       JSON NULL,
  holdout        JSON NULL,
  robustness     JSON NULL,
  validate_passed TINYINT(1) NOT NULL DEFAULT 0,
  holdout_passed  TINYINT(1) NOT NULL DEFAULT 0,
  promotable      TINYINT(1) NOT NULL DEFAULT 0,
  note           VARCHAR(512) NULL,
  KEY idx_study_combo (strategy_id, symbol_id, timeframe),
  KEY idx_study_promotable (promotable),
  CONSTRAINT fk_study_strategy FOREIGN KEY (strategy_id) REFERENCES strategies (id),
  CONSTRAINT fk_study_symbol FOREIGN KEY (symbol_id) REFERENCES symbols (id)
) ENGINE = InnoDB;
