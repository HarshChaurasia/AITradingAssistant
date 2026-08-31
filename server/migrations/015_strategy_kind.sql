-- Scalps and swing strategies are different animals and are judged
-- differently: a scalp holds for minutes, takes many more trades, and lives or
-- dies on spread rather than on direction. Pooling them in one table on one
-- screen makes both harder to read - a scalp's 200 trades drown a swing
-- strategy's 20 in any average that covers both.
ALTER TABLE strategies
  ADD COLUMN kind ENUM('swing','scalp') NOT NULL DEFAULT 'swing' AFTER version;
