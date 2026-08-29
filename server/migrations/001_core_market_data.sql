CREATE TABLE symbols (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  broker_symbol   VARCHAR(32)     NOT NULL,
  description     VARCHAR(160)    NULL,
  digits          TINYINT UNSIGNED NOT NULL,
  point           DECIMAL(18,10)  NOT NULL,
  contract_size   DECIMAL(18,4)   NOT NULL,
  tick_size       DECIMAL(18,10)  NOT NULL,
  tick_value      DECIMAL(18,10)  NOT NULL,
  min_lot         DECIMAL(10,4)   NOT NULL,
  lot_step        DECIMAL(10,4)   NOT NULL,
  max_lot         DECIMAL(10,4)   NOT NULL,
  spread_points   INT UNSIGNED    NULL,
  currency_profit CHAR(8)         NULL,
  currency_margin CHAR(8)         NULL,
  enabled         TINYINT(1)      NOT NULL DEFAULT 0,
  synced_at       DATETIME        NOT NULL,
  UNIQUE KEY uq_symbols_broker_symbol (broker_symbol),
  KEY idx_symbols_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE candles (
  symbol_id   INT UNSIGNED    NOT NULL,
  timeframe   VARCHAR(4)      NOT NULL,
  open_time   DATETIME        NOT NULL COMMENT 'UTC, broker offset already removed',
  open        DECIMAL(18,8)   NOT NULL,
  high        DECIMAL(18,8)   NOT NULL,
  low         DECIMAL(18,8)   NOT NULL,
  close       DECIMAL(18,8)   NOT NULL,
  tick_volume BIGINT UNSIGNED NOT NULL DEFAULT 0,
  real_volume BIGINT UNSIGNED NOT NULL DEFAULT 0,
  spread      INT UNSIGNED    NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol_id, timeframe, open_time),
  CONSTRAINT fk_candles_symbol FOREIGN KEY (symbol_id)
    REFERENCES symbols(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
