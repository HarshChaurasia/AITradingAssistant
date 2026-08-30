-- Stop a signal from being executed more than once.
--
-- Nothing enforced this. A signal stayed 'approved' until an order filled, so
-- a send that FAILED left it approved and the next scheduler tick tried again
-- - and again. One EURUSD H4 signal was retried 278 times over four and a
-- half hours, writing a CANCELLED trade row every minute, until the market
-- hours gate finally refused it. Nothing in the system objected, because
-- nothing was watching.
--
-- 'executing' is the claim. A worker moves a signal into it with a
-- conditional UPDATE, and only the worker whose UPDATE actually matched a row
-- goes on to send the order. Two schedulers, a manual run and a Trade-now
-- click can now all race for the same signal and exactly one of them wins.
ALTER TABLE signals
  MODIFY COLUMN status
    ENUM('new','approved','executing','rejected','expired','executed')
    NOT NULL DEFAULT 'new';

-- Attempt counting, so a signal that cannot be sent gives up instead of
-- retrying for ever. Kept on the row rather than in memory: the whole point
-- is that it survives a restart.
ALTER TABLE signals
  ADD COLUMN send_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER auto_approved;
