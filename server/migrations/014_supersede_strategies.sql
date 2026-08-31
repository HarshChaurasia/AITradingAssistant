-- Retire a strategy version without deleting it.
--
-- Bumping a version writes a new row, and the old one cannot simply be
-- removed: every signal and backtest run ever produced by it points at that
-- id, and the history is the only evidence of what the parameters were when
-- those trades were taken.
--
-- So it is marked instead. Listings show the shipped version only - two rows
-- named trend-breakout in a dropdown is an invitation to run the wrong one -
-- while analytics still groups by NAME, so a strategy's record survives its
-- own retuning.
ALTER TABLE strategies
  ADD COLUMN superseded_at DATETIME NULL AFTER enabled;
