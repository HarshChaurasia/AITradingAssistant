-- A scalp closed by its time stop had nowhere to be recorded.
--
-- The engine gained a maxHoldBars exit, but backtest_trades.exit_reason is an
-- ENUM that predates it, so MySQL truncated the value and the whole run
-- failed with "Data truncated for column 'exit_reason'". Every scalp backtest
-- errored - visible only as "30 could not run" on the screen, because the
-- insert happens after the simulation and takes the run down with it.
ALTER TABLE backtest_trades
  MODIFY COLUMN exit_reason ENUM('SL','TP','TIME','SIGNAL','END') NOT NULL;
