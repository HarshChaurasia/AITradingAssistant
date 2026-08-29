-- A trade row is written BEFORE the order is sent, so a crash between send
-- and response leaves evidence rather than an untracked position. PENDING is
-- that pre-send state.
ALTER TABLE trades
  MODIFY COLUMN status ENUM('PENDING','OPEN','CLOSED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  MODIFY COLUMN lot DECIMAL(20,8) NOT NULL,
  ADD COLUMN requested_price DECIMAL(18,8) NULL AFTER entry_price,
  ADD COLUMN retcode         INT          NULL AFTER broker_ticket,
  ADD COLUMN broker_comment  VARCHAR(255) NULL AFTER retcode,
  ADD COLUMN exit_reason     VARCHAR(32)  NULL AFTER close_price,
  ADD COLUMN last_synced_at  DATETIME     NULL AFTER closed_at;
