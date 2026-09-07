-- ============================================================================
-- 001_initial: core schema
-- ============================================================================

-- Administrators of the web dashboard. Separate from `users` (media owners)
-- and entirely separate from Jellyfin accounts.
CREATE TABLE admins (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX admins_username_lower_key ON admins (lower(username));

-- Server-side session store. Only the SHA-256 of the session token is stored,
-- so a database leak does not hand out live sessions.
CREATE TABLE admin_sessions (
  id            BIGSERIAL PRIMARY KEY,
  token_hash    TEXT        NOT NULL UNIQUE,
  admin_id      BIGINT      NOT NULL REFERENCES admins (id) ON DELETE CASCADE,
  csrf_token    TEXT        NOT NULL,
  user_agent    TEXT,
  ip_address    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX admin_sessions_admin_id_idx ON admin_sessions (admin_id);
CREATE INDEX admin_sessions_expires_at_idx ON admin_sessions (expires_at);

-- Media owners: the Telegram <-> Jellyfin identity mapping.
CREATE TABLE users (
  id                 BIGSERIAL   PRIMARY KEY,
  name               TEXT        NOT NULL,
  telegram_chat_id   BIGINT      NOT NULL,
  jellyfin_username  TEXT        NOT NULL,
  jellyfin_user_id   TEXT,
  -- Directory segment under MOVIES_ROOT / TV_ROOT. Derived from the Jellyfin
  -- username, sanitised once on write so nothing downstream has to trust it.
  storage_slug       TEXT        NOT NULL,
  active             BOOLEAN     NOT NULL DEFAULT TRUE,
  upload_enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  quota_bytes        BIGINT,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_telegram_chat_id_key ON users (telegram_chat_id);
CREATE UNIQUE INDEX users_jellyfin_username_lower_key ON users (lower(jellyfin_username));
CREATE UNIQUE INDEX users_storage_slug_key ON users (storage_slug);
CREATE INDEX users_active_idx ON users (active);

-- The Jellyfin libraries this application manages on a user's behalf.
CREATE TABLE user_libraries (
  id            BIGSERIAL   PRIMARY KEY,
  user_id       BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  media_type    TEXT        NOT NULL CHECK (media_type IN ('movie', 'tv')),
  library_name  TEXT        NOT NULL,
  library_path  TEXT        NOT NULL,
  jellyfin_item_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_libraries_user_type_key ON user_libraries (user_id, media_type);
CREATE UNIQUE INDEX user_libraries_name_key ON user_libraries (library_name);

CREATE TABLE uploads (
  id                 BIGSERIAL   PRIMARY KEY,
  user_id            BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  telegram_chat_id   BIGINT      NOT NULL,
  telegram_message_id BIGINT,
  progress_message_id BIGINT,
  telegram_file_id   TEXT,
  telegram_file_unique_id TEXT,
  original_filename  TEXT        NOT NULL,
  safe_filename      TEXT        NOT NULL,
  extension          TEXT        NOT NULL,
  mime_type          TEXT,
  stored_path        TEXT,
  file_size          BIGINT      NOT NULL DEFAULT 0,
  bytes_downloaded   BIGINT      NOT NULL DEFAULT 0,
  checksum_sha256    TEXT,
  media_type         TEXT        CHECK (media_type IN ('movie', 'tv', 'unknown')),
  detected_title     TEXT,
  detected_year      INT,
  detected_season    INT,
  detected_episode   INT,
  status             TEXT        NOT NULL DEFAULT 'RECEIVED',
  error_message      TEXT,
  cancel_requested   BOOLEAN     NOT NULL DEFAULT FALSE,
  duration_ms        BIGINT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ,
  CONSTRAINT uploads_status_check CHECK (status IN (
    'RECEIVED','QUEUED','DOWNLOADING','PROCESSING','ORGANIZING',
    'JELLYFIN_SCAN','COMPLETED','FAILED','CANCELLED','DUPLICATE'
  ))
);
CREATE INDEX uploads_user_id_idx        ON uploads (user_id);
CREATE INDEX uploads_status_idx         ON uploads (status);
CREATE INDEX uploads_created_at_idx     ON uploads (created_at DESC);
CREATE INDEX uploads_file_unique_id_idx ON uploads (telegram_file_unique_id);

CREATE TABLE media (
  id               BIGSERIAL   PRIMARY KEY,
  user_id          BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  upload_id        BIGINT      REFERENCES uploads (id) ON DELETE SET NULL,
  title            TEXT        NOT NULL,
  original_title   TEXT,
  year             INT,
  type             TEXT        NOT NULL CHECK (type IN ('movie', 'tv')),
  season           INT,
  episode          INT,
  episode_title    TEXT,
  path             TEXT        NOT NULL,
  file_size        BIGINT      NOT NULL DEFAULT 0,
  checksum_sha256  TEXT,
  tmdb_id          INT,
  overview         TEXT,
  poster_path      TEXT,
  jellyfin_item_id TEXT,
  jellyfin_verified BOOLEAN    NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX media_path_key ON media (path);
CREATE INDEX media_user_id_idx ON media (user_id);
CREATE INDEX media_type_idx    ON media (type);
CREATE INDEX media_user_checksum_idx ON media (user_id, checksum_sha256);
-- Duplicate detection for movies: one title/year per user.
CREATE UNIQUE INDEX media_user_movie_key
  ON media (user_id, lower(title), COALESCE(year, 0))
  WHERE type = 'movie';
-- Duplicate detection for episodes: one show/season/episode per user.
CREATE UNIQUE INDEX media_user_episode_key
  ON media (user_id, lower(title), season, episode)
  WHERE type = 'tv';

-- Durable job queue. Postgres-backed rather than Redis-backed: this server has
-- 3 GB of RAM, no Redis installed, and the queue depth is measured in files
-- per day. `SELECT ... FOR UPDATE SKIP LOCKED` gives us safe multi-worker
-- claiming without another daemon.
CREATE TABLE jobs (
  id            BIGSERIAL   PRIMARY KEY,
  type          TEXT        NOT NULL,
  upload_id     BIGINT      REFERENCES uploads (id) ON DELETE CASCADE,
  payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','active','completed','failed','cancelled')),
  priority      INT         NOT NULL DEFAULT 100,
  attempts      INT         NOT NULL DEFAULT 0,
  max_attempts  INT         NOT NULL DEFAULT 3,
  progress      NUMERIC(5,2) NOT NULL DEFAULT 0,
  last_error    TEXT,
  locked_by     TEXT,
  locked_at     TIMESTAMPTZ,
  run_after     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX jobs_claim_idx  ON jobs (status, run_after, priority, id);
CREATE INDEX jobs_upload_idx ON jobs (upload_id);

CREATE TABLE settings (
  key         TEXT        PRIMARY KEY,
  value       JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT      REFERENCES admins (id) ON DELETE SET NULL
);

CREATE TABLE audit_logs (
  id          BIGSERIAL   PRIMARY KEY,
  actor_type  TEXT        NOT NULL CHECK (actor_type IN ('admin','system','telegram')),
  actor_id    TEXT,
  action      TEXT        NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  detail      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_action_idx     ON audit_logs (action);
CREATE INDEX audit_logs_entity_idx     ON audit_logs (entity_type, entity_id);

-- Keep updated_at honest without every call site remembering to set it.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_touch          BEFORE UPDATE ON users          FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER uploads_touch        BEFORE UPDATE ON uploads        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER media_touch          BEFORE UPDATE ON media          FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER jobs_touch           BEFORE UPDATE ON jobs           FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER admins_touch         BEFORE UPDATE ON admins         FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER user_libraries_touch BEFORE UPDATE ON user_libraries FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
