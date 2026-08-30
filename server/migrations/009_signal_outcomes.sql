-- What happened AFTER a signal we did not take.
--
-- Every rejected signal is a decision, and a decision nobody grades is a
-- decision nobody learns from. This table replays each one against the
-- candles that arrived later and records whether the refusal saved money or
-- cost it. It stores judgement, never intent: nothing here has ever been an
-- order, and no row in it can become one.
CREATE TABLE signal_outcomes (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  signal_id      BIGINT UNSIGNED NOT NULL,
  evaluated_at   DATETIME        NOT NULL,
  -- The bar the replay reached its conclusion on, so a re-run can be checked.
  resolved_at    DATETIME        NULL,
  bars_examined  INT UNSIGNED    NOT NULL DEFAULT 0,
  -- 'tp'   the target came first
  -- 'sl'   the stop came first
  -- 'open' neither was reached within the window
  -- 'no_data' not enough candles have arrived yet to say
  outcome        ENUM('tp','sl','open','no_data') NOT NULL,
  -- What one lot would have made or lost, in price terms. Deliberately not in
  -- account currency: the position was never sized, so any money figure would
  -- be an invention.
  price_move     DECIMAL(18,8)   NULL,
  r_multiple     DECIMAL(10,4)   NULL,
  -- The grade. 'costly' means refusing it lost us a winner; 'correct' means
  -- refusing it avoided a loser.
  verdict        ENUM('costly','correct','undecided') NOT NULL,
  detail         VARCHAR(512)    NULL,
  UNIQUE KEY uq_signal_outcomes_signal (signal_id),
  KEY idx_signal_outcomes_verdict (verdict),
  CONSTRAINT fk_signal_outcomes_signal FOREIGN KEY (signal_id) REFERENCES signals(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
