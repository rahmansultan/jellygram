-- A file the system declined to identify is not a failure.
--
-- Low-confidence identification parks the file in the quarantine directory and
-- deliberately does not guess. That was recorded as FAILED, which inflated the
-- failure count with items where nothing went wrong and left an administrator
-- no way to list the things actually waiting on them. NEEDS_REVIEW says what
-- happened: the file is safe, and a human has to decide what it is.

ALTER TABLE uploads DROP CONSTRAINT IF EXISTS uploads_status_check;

ALTER TABLE uploads ADD CONSTRAINT uploads_status_check CHECK (status IN (
  'RECEIVED',
  'QUEUED',
  'DOWNLOADING',
  'PROCESSING',
  'ORGANIZING',
  'JELLYFIN_SCAN',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'DUPLICATE',
  'NEEDS_REVIEW'
));

-- Existing rows are left alone: reclassifying past failures would be guessing
-- at history. Only new quarantines use the new status.
CREATE INDEX IF NOT EXISTS uploads_needs_review_idx
  ON uploads (updated_at DESC)
  WHERE status = 'NEEDS_REVIEW';
