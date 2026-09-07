-- ============================================================================
-- 003_upload_tokens: credentials for the local uploader client
--
-- The uploader sends files straight to this server rather than through
-- Telegram, so it needs to prove which user it is uploading for. Each media
-- user gets one high-entropy token; only its SHA-256 is stored, so reading the
-- database does not yield a usable credential.
-- ============================================================================

ALTER TABLE users ADD COLUMN upload_token_hash TEXT;
ALTER TABLE users ADD COLUMN upload_token_created_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN upload_token_last_used_at TIMESTAMPTZ;

CREATE UNIQUE INDEX users_upload_token_hash_key
  ON users (upload_token_hash)
  WHERE upload_token_hash IS NOT NULL;

-- How a session's parts arrived. Telegram parts are fetched by the worker;
-- direct parts are already on disk when the request completes, so they never
-- need a download job.
ALTER TABLE upload_sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'telegram';
ALTER TABLE upload_sessions
  ADD CONSTRAINT upload_sessions_source_check CHECK (source IN ('telegram', 'direct'));

ALTER TABLE uploads ADD COLUMN source TEXT NOT NULL DEFAULT 'telegram';
ALTER TABLE uploads
  ADD CONSTRAINT uploads_source_check CHECK (source IN ('telegram', 'direct'));

-- A direct part carries no Telegram file id.
ALTER TABLE upload_parts ALTER COLUMN telegram_file_id DROP NOT NULL;
