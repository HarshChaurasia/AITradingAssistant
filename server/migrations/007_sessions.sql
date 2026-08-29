-- Only the SHA-256 of the session token is stored. A stolen database dump
-- then contains no usable sessions, which a plaintext token table would.
CREATE TABLE sessions (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id    INT UNSIGNED NOT NULL,
  token_hash CHAR(64)     NOT NULL,
  created_at DATETIME     NOT NULL,
  expires_at DATETIME     NOT NULL,
  UNIQUE KEY uq_sessions_token (token_hash),
  KEY idx_sessions_expiry (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
