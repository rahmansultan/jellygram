-- ============================================================================
-- 004_mtproto: forwarded-media ingestion over MTProto
--
-- Telegram's Bot API cannot fetch a file above 2000 MB. When a user forwards
-- media larger than that to the bot, the bot records what it saw here and an
-- MTProto client — authenticated as the owner's own Telegram account — locates
-- the original message and streams the file straight to this server.
--
-- The result is handed to the existing pipeline exactly like every other
-- ingestion route; nothing downstream changes.
-- ============================================================================

CREATE TABLE mtproto_jobs (
  id                      BIGSERIAL   PRIMARY KEY,
  user_id                 BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- The bot's own view of the forwarded message, used to reply with progress.
  telegram_chat_id        BIGINT      NOT NULL,
  bot_message_id          BIGINT,
  progress_message_id     BIGINT,

  -- Where the media originally came from, as far as the Bot API disclosed it.
  -- A channel forward carries an exact chat and message id; a forward from a
  -- private chat carries neither, so the job is resolved by searching the
  -- owner's own dialog with the bot instead.
  origin_kind             TEXT        NOT NULL DEFAULT 'unknown'
                          CHECK (origin_kind IN ('channel','user','chat','hidden','unknown')),
  origin_chat             TEXT,
  origin_message_id       BIGINT,
  origin_title            TEXT,

  -- What we are looking for, and what we expect to receive.
  file_name               TEXT        NOT NULL,
  file_size               BIGINT      NOT NULL,
  mime_type               TEXT,
  telegram_file_unique_id TEXT,
  caption                 TEXT,

  status                  TEXT        NOT NULL DEFAULT 'PENDING',
  bytes_downloaded        BIGINT      NOT NULL DEFAULT 0,
  speed_bps               BIGINT,
  sha256                  TEXT,
  temp_path               TEXT,

  -- Set once the download is complete and the file enters the shared pipeline.
  upload_id               BIGINT      REFERENCES uploads (id) ON DELETE SET NULL,

  attempts                INT         NOT NULL DEFAULT 0,
  error_message           TEXT,
  cancel_requested        BOOLEAN     NOT NULL DEFAULT FALSE,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,

  CONSTRAINT mtproto_jobs_status_check CHECK (status IN (
    'PENDING','LOCATING','DOWNLOADING','VERIFYING','HANDOFF',
    'COMPLETED','FAILED','CANCELLED','UNAVAILABLE'
  )),
  CONSTRAINT mtproto_jobs_size_check CHECK (file_size >= 0)
);

CREATE INDEX mtproto_jobs_user_idx    ON mtproto_jobs (user_id);
CREATE INDEX mtproto_jobs_status_idx  ON mtproto_jobs (status);
CREATE INDEX mtproto_jobs_created_idx ON mtproto_jobs (created_at DESC);

-- One in-flight job per forwarded message, so a double-tap on forward cannot
-- start the same 5 GB download twice.
CREATE UNIQUE INDEX mtproto_jobs_active_message_key
  ON mtproto_jobs (user_id, bot_message_id)
  WHERE bot_message_id IS NOT NULL
    AND status IN ('PENDING','LOCATING','DOWNLOADING','VERIFYING','HANDOFF');

-- MTProto joins the existing ingestion sources.
ALTER TABLE uploads DROP CONSTRAINT uploads_source_check;
ALTER TABLE uploads ADD CONSTRAINT uploads_source_check
  CHECK (source IN ('telegram', 'direct', 'mtproto'));

ALTER TABLE uploads ADD COLUMN mtproto_job_id BIGINT REFERENCES mtproto_jobs (id) ON DELETE SET NULL;
CREATE INDEX uploads_mtproto_job_idx ON uploads (mtproto_job_id);

CREATE TRIGGER mtproto_jobs_touch BEFORE UPDATE ON mtproto_jobs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
