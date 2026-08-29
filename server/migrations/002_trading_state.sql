CREATE TABLE strategies (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(64)  NOT NULL,
  version     VARCHAR(16)  NOT NULL,
  params      JSON         NOT NULL,
  status      ENUM('draft','backtested','demo','live') NOT NULL DEFAULT 'draft',
  enabled     TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL,
  UNIQUE KEY uq_strategies_name_version (name, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE signals (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  strategy_id  INT UNSIGNED    NOT NULL,
  symbol_id    INT UNSIGNED    NOT NULL,
  timeframe    VARCHAR(4)      NOT NULL,
  mode         ENUM('backtest','demo','live') NOT NULL,
  generated_at DATETIME        NOT NULL,
  bar_time     DATETIME        NOT NULL,
  side         ENUM('BUY','SELL') NOT NULL,
  entry        DECIMAL(18,8)   NOT NULL,
  sl           DECIMAL(18,8)   NOT NULL,
  tp           DECIMAL(18,8)   NULL,
  confidence   DECIMAL(5,2)    NULL,
  reason       VARCHAR(512)    NULL,
  features     JSON            NULL,
  status       ENUM('new','approved','rejected','expired','executed') NOT NULL DEFAULT 'new',
  KEY idx_signals_status (status, mode),
  KEY idx_signals_symbol_time (symbol_id, bar_time),
  UNIQUE KEY uq_signals_dedupe (strategy_id, symbol_id, timeframe, bar_time, mode),
  CONSTRAINT fk_signals_strategy FOREIGN KEY (strategy_id) REFERENCES strategies(id),
  CONSTRAINT fk_signals_symbol   FOREIGN KEY (symbol_id)   REFERENCES symbols(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE trades (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  signal_id     BIGINT UNSIGNED NULL,
  symbol_id     INT UNSIGNED    NOT NULL,
  mode          ENUM('backtest','demo','live') NOT NULL,
  broker_ticket BIGINT UNSIGNED NULL,
  side          ENUM('BUY','SELL') NOT NULL,
  lot           DECIMAL(10,4)   NOT NULL,
  entry_price   DECIMAL(18,8)   NOT NULL,
  sl            DECIMAL(18,8)   NOT NULL,
  tp            DECIMAL(18,8)   NULL,
  close_price   DECIMAL(18,8)   NULL,
  opened_at     DATETIME        NOT NULL,
  closed_at     DATETIME        NULL,
  pnl           DECIMAL(18,4)   NULL,
  commission    DECIMAL(18,4)   NOT NULL DEFAULT 0,
  swap          DECIMAL(18,4)   NOT NULL DEFAULT 0,
  status        ENUM('OPEN','CLOSED','CANCELLED') NOT NULL DEFAULT 'OPEN',
  KEY idx_trades_mode_status (mode, status),
  UNIQUE KEY uq_trades_ticket (mode, broker_ticket),
  CONSTRAINT fk_trades_symbol FOREIGN KEY (symbol_id) REFERENCES symbols(id),
  CONSTRAINT fk_trades_signal FOREIGN KEY (signal_id) REFERENCES signals(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE backtest_runs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  strategy_id INT UNSIGNED    NOT NULL,
  symbol_id   INT UNSIGNED    NOT NULL,
  timeframe   VARCHAR(4)      NOT NULL,
  from_time   DATETIME        NOT NULL,
  to_time     DATETIME        NOT NULL,
  params      JSON            NOT NULL,
  metrics     JSON            NULL,
  passed      TINYINT(1)      NOT NULL DEFAULT 0,
  created_at  DATETIME        NOT NULL,
  CONSTRAINT fk_runs_strategy FOREIGN KEY (strategy_id) REFERENCES strategies(id),
  CONSTRAINT fk_runs_symbol   FOREIGN KEY (symbol_id)   REFERENCES symbols(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE backtest_trades (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id      BIGINT UNSIGNED NOT NULL,
  side        ENUM('BUY','SELL') NOT NULL,
  lot         DECIMAL(10,4)   NOT NULL,
  entry_time  DATETIME        NOT NULL,
  entry_price DECIMAL(18,8)   NOT NULL,
  exit_time   DATETIME        NOT NULL,
  exit_price  DECIMAL(18,8)   NOT NULL,
  sl          DECIMAL(18,8)   NOT NULL,
  tp          DECIMAL(18,8)   NULL,
  pnl         DECIMAL(18,4)   NOT NULL,
  exit_reason ENUM('SL','TP','SIGNAL','END') NOT NULL,
  KEY idx_backtest_trades_run (run_id),
  CONSTRAINT fk_bt_trades_run FOREIGN KEY (run_id) REFERENCES backtest_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE risk_state (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  trading_day        DATE         NOT NULL,
  mode               ENUM('backtest','demo','live') NOT NULL,
  realized_pnl       DECIMAL(18,4) NOT NULL DEFAULT 0,
  trades_count       INT UNSIGNED  NOT NULL DEFAULT 0,
  consecutive_losses INT UNSIGNED  NOT NULL DEFAULT 0,
  kill_switch        TINYINT(1)    NOT NULL DEFAULT 0,
  kill_switch_reason VARCHAR(255)  NULL,
  updated_at         DATETIME      NOT NULL,
  UNIQUE KEY uq_risk_day_mode (trading_day, mode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE news_events (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_time DATETIME     NOT NULL,
  currency   CHAR(8)      NULL,
  title      VARCHAR(255) NOT NULL,
  source     VARCHAR(64)  NULL,
  impact     ENUM('LOW','MEDIUM','HIGH') NOT NULL DEFAULT 'LOW',
  url        VARCHAR(512) NULL,
  KEY idx_news_time (event_time),
  UNIQUE KEY uq_news_dedupe (event_time, title)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE equity_snapshots (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  mode         ENUM('backtest','demo','live') NOT NULL,
  captured_at  DATETIME      NOT NULL,
  balance      DECIMAL(18,4) NOT NULL,
  equity       DECIMAL(18,4) NOT NULL,
  margin_free  DECIMAL(18,4) NULL,
  KEY idx_equity_mode_time (mode, captured_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_log (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  logged_at  DATETIME     NOT NULL,
  actor      ENUM('system','user') NOT NULL,
  action     VARCHAR(64)  NOT NULL,
  payload    JSON         NULL,
  KEY idx_audit_time (logged_at),
  KEY idx_audit_action (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(64)  NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    DATETIME     NOT NULL,
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE settings (
  setting_key   VARCHAR(64) NOT NULL PRIMARY KEY,
  setting_value JSON        NOT NULL,
  updated_at    DATETIME    NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO settings (setting_key, setting_value, updated_at) VALUES
  ('risk', JSON_OBJECT(
      'riskPctPerTrade', 1.0,
      'dailyLossCapPct', 5.0,
      'maxConcurrentPositions', 2,
      'consecutiveLossLimit', 3,
      'newsBlackoutMinutes', 15), UTC_TIMESTAMP()),
  ('backtestThresholds', JSON_OBJECT(
      'minProfitFactor', 1.3,
      'maxDrawdownPct', 15.0,
      'minTrades', 50), UTC_TIMESTAMP());
