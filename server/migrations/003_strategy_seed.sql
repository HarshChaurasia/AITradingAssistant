-- Backtest runs record which window they describe, so an out-of-sample verdict
-- is never confused with the in-sample fit it was tuned on.
ALTER TABLE backtest_runs
  ADD COLUMN sample ENUM('full','in','out') NOT NULL DEFAULT 'full' AFTER timeframe,
  ADD COLUMN parent_run_id BIGINT UNSIGNED NULL AFTER sample,
  ADD KEY idx_runs_parent (parent_run_id);

INSERT INTO strategies (name, version, params, status, enabled, created_at) VALUES
  ('trend-breakout', '1.0.0', JSON_OBJECT(
      'channelPeriod', 20, 'fastEma', 20, 'slowEma', 50,
      'atrPeriod', 14, 'atrStopMultiple', 2.0, 'atrTargetMultiple', 3.0),
   'draft', 0, UTC_TIMESTAMP()),
  ('mean-reversion', '1.0.0', JSON_OBJECT(
      'rsiPeriod', 14, 'oversold', 30, 'overbought', 70, 'trendEma', 100,
      'atrPeriod', 14, 'atrStopMultiple', 1.5, 'atrTargetMultiple', 2.0),
   'draft', 0, UTC_TIMESTAMP())
ON DUPLICATE KEY UPDATE params = VALUES(params);
