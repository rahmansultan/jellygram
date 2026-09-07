-- ============================================================================
-- 002_multipart: multi-part uploads
--
-- Telegram's Bot API cannot deliver a single file above its per-file ceiling
-- (20 MB public, 2000 MB with a local Bot API server). To land a file larger
-- than that, the sender splits it locally and sends the pieces; the server
-- collects them into a session, reassembles the original bytes, and hands the
-- result to the existing single-file pipeline unchanged.
-- ============================================================================

CREATE TABLE upload_sessions (
  id                    BIGSERIAL   PRIMARY KEY,
  user_id               BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  telegram_chat_id      BIGINT      NOT NULL,

  -- The original name with the part suffix stripped: `Movie.mkv.part1` -> `Movie.mkv`.
  base_filename         TEXT        NOT NULL,
  safe_base_filename    TEXT        NOT NULL,
  extension             TEXT        NOT NULL,

  -- Known upfront only when the sender used a `partNofM` style name; otherwise
  -- the session is finalised by /finish or by the idle timeout.
  expected_parts        INT,
  received_parts        INT         NOT NULL DEFAULT 0,
  received_bytes        BIGINT      NOT NULL DEFAULT 0,

  assembled_path        TEXT,
  assembled_size        BIGINT,
  assembled_sha256      TEXT,

  -- The `uploads` row created at handoff, so the session and the resulting
  -- media stay linked for the dashboard.
  upload_id             BIGINT      REFERENCES uploads (id) ON DELETE SET NULL,

  progress_message_id   BIGINT,
  status                TEXT        NOT NULL DEFAULT 'COLLECTING',
  error_message         TEXT,
  cancel_requested      BOOLEAN     NOT NULL DEFAULT FALSE,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_part_at          TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,

  CONSTRAINT upload_sessions_status_check CHECK (status IN (
    'COLLECTING','READY','ASSEMBLING','VERIFYING','HANDOFF',
    'COMPLETED','FAILED','CANCELLED','EXPIRED'
  )),
  CONSTRAINT upload_sessions_parts_check CHECK (expected_parts IS NULL OR expected_parts > 0)
);

-- One open session per user per base filename. Finished sessions may repeat,
-- so the constraint only covers the states that are still collecting.
CREATE UNIQUE INDEX upload_sessions_open_key
  ON upload_sessions (user_id, lower(safe_base_filename))
  WHERE status IN ('COLLECTING','READY','ASSEMBLING','VERIFYING','HANDOFF');

CREATE INDEX upload_sessions_user_idx    ON upload_sessions (user_id);
CREATE INDEX upload_sessions_status_idx  ON upload_sessions (status);
CREATE INDEX upload_sessions_created_idx ON upload_sessions (created_at DESC);

CREATE TABLE upload_parts (
  id                      BIGSERIAL   PRIMARY KEY,
  session_id              BIGINT      NOT NULL REFERENCES upload_sessions (id) ON DELETE CASCADE,

  -- 1-based, in the order the bytes must be concatenated.
  part_number             INT         NOT NULL,
  original_filename       TEXT        NOT NULL,

  telegram_file_id        TEXT        NOT NULL,
  telegram_file_unique_id TEXT,
  telegram_message_id     BIGINT,

  file_size               BIGINT      NOT NULL DEFAULT 0,
  bytes_downloaded        BIGINT      NOT NULL DEFAULT 0,
  stored_path             TEXT,
  checksum_sha256         TEXT,

  status                  TEXT        NOT NULL DEFAULT 'PENDING',
  error_message           TEXT,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at            TIMESTAMPTZ,

  CONSTRAINT upload_parts_status_check CHECK (status IN (
    'PENDING','DOWNLOADING','READY','FAILED'
  )),
  CONSTRAINT upload_parts_number_check CHECK (part_number > 0)
);

-- Out-of-order arrival is fine; a repeated part number is not a second part.
CREATE UNIQUE INDEX upload_parts_session_number_key ON upload_parts (session_id, part_number);
CREATE INDEX upload_parts_session_idx ON upload_parts (session_id);
CREATE INDEX upload_parts_status_idx  ON upload_parts (status);

-- The pipeline normally fetches its bytes from Telegram. When this is set the
-- bytes are already on disk (an assembled multi-part upload), and the download
-- stage takes the local file instead.
ALTER TABLE uploads ADD COLUMN local_source_path TEXT;

-- Links an upload back to the session it was assembled from, for the dashboard.
ALTER TABLE uploads ADD COLUMN session_id BIGINT REFERENCES upload_sessions (id) ON DELETE SET NULL;
CREATE INDEX uploads_session_idx ON uploads (session_id);

CREATE TRIGGER upload_sessions_touch BEFORE UPDATE ON upload_sessions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER upload_parts_touch BEFORE UPDATE ON upload_parts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
