-- Backup history, so backup health is visible in the dashboard rather than
-- only discoverable by looking at the filesystem.
--
-- Rows are small and pruned with the files they describe; this table records
-- that a backup was attempted and whether it worked, never its contents.

CREATE TABLE IF NOT EXISTS backups (
  id           BIGSERIAL PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'RUNNING',
  path         TEXT,
  size_bytes   BIGINT,
  duration_ms  INTEGER,
  error_message TEXT,
  CONSTRAINT backups_status_check CHECK (status IN ('RUNNING','COMPLETED','FAILED'))
);

CREATE INDEX IF NOT EXISTS backups_started_idx ON backups (started_at DESC);
