-- `watched` is deliberately separate from `enabled`.
--   enabled = may be traded. Earned by passing a backtest.
--   watched = evaluated and shown on the scanner. Never traded.
-- Conflating them would let a symbol reach the order path just because
-- someone wanted to look at it.
ALTER TABLE symbols
  ADD COLUMN watched TINYINT(1) NOT NULL DEFAULT 0 AFTER enabled,
  ADD KEY idx_symbols_watched (watched);

-- Anything already tradeable is worth watching too.
UPDATE symbols SET watched = 1 WHERE enabled = 1;
