-- Live progress for the dashboard.
--
-- The Telegram message is edited in place and rate-limited; the dashboard has
-- no such constraint, so the worker publishes every state change here and the
-- dashboard reads it. These columns describe the CURRENT stage only and mean
-- nothing once an upload reaches a terminal status.

ALTER TABLE uploads
  ADD COLUMN IF NOT EXISTS progress_stage TEXT,
  ADD COLUMN IF NOT EXISTS progress_percent REAL,
  -- False when the percentage is pipeline position rather than a byte count,
  -- so the dashboard can label it honestly instead of implying a transfer.
  ADD COLUMN IF NOT EXISTS progress_byte_accurate BOOLEAN,
  ADD COLUMN IF NOT EXISTS progress_bytes_per_sec REAL,
  ADD COLUMN IF NOT EXISTS progress_eta_sec REAL,
  ADD COLUMN IF NOT EXISTS progress_part INTEGER,
  ADD COLUMN IF NOT EXISTS progress_part_count INTEGER,
  ADD COLUMN IF NOT EXISTS progress_updated_at TIMESTAMPTZ;
