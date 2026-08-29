-- Real broker data exceeds the original DECIMAL(10,4) lot columns in both
-- directions. On MetaQuotes-Demo, max_lot reaches 1e11 (overflow) while
-- min_lot and lot_step go down to 1e-8, which DECIMAL(10,4) rounds to ZERO.
-- A stored min_lot of 0 would silently disable the below-minimum rejection
-- that stops a small account from being over-risked, so this is a correctness
-- fix, not just a capacity one.
ALTER TABLE symbols
  MODIFY COLUMN min_lot  DECIMAL(20,8) NOT NULL,
  MODIFY COLUMN lot_step DECIMAL(20,8) NOT NULL,
  MODIFY COLUMN max_lot  DECIMAL(20,8) NOT NULL;
