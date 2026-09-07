-- Structured failure information for uploads.
--
-- Until now a failed upload recorded only `error_message`, so an administrator
-- could not tell which stage failed, whether the failure was retryable, or what
-- the underlying error code was. The generic "Upload failed" the user sees is
-- deliberate; the admin side must not be equally blind.

ALTER TABLE uploads
  ADD COLUMN IF NOT EXISTS error_stage TEXT,
  ADD COLUMN IF NOT EXISTS error_code TEXT,
  ADD COLUMN IF NOT EXISTS error_retryable BOOLEAN,
  ADD COLUMN IF NOT EXISTS error_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;

-- Failed uploads are the ones an admin goes looking for.
CREATE INDEX IF NOT EXISTS uploads_failed_idx
  ON uploads (updated_at DESC)
  WHERE status = 'FAILED';
