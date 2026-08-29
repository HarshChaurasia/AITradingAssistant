-- A signal stores the risk decision that produced it, so a past decision can
-- be audited later without re-running anything: by then the balance, open
-- position count and news window that shaped it are all gone.
ALTER TABLE signals
  ADD COLUMN lot           DECIMAL(20,8) NULL AFTER tp,
  ADD COLUMN decision      JSON          NULL AFTER features,
  ADD COLUMN auto_approved TINYINT(1)    NOT NULL DEFAULT 0 AFTER status,
  ADD COLUMN decided_at    DATETIME      NULL AFTER auto_approved,
  ADD COLUMN decided_by    VARCHAR(32)   NULL AFTER decided_at;
