-- A multi-part session now records the size its sender declared.
--
-- Two things needed it. Quota: a session has no uploads row until assembly,
-- so several sessions could each pass the /begin check and together land far
-- over the limit. Rejoining: /begin found an open session by filename alone,
-- so a re-run with a same-named file of a different size either wedged on
-- "part beyond the declared total" or, worse, assembled new parts with stale
-- ones into a corrupt file.
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS expected_bytes BIGINT;

-- Indexes that migration 009 made redundant. Each single-column index below
-- is the leading column of a composite added there, so the planner can never
-- prefer it, and every write was paying to maintain both.
DROP INDEX IF EXISTS uploads_user_id_idx;
DROP INDEX IF EXISTS uploads_status_idx;
DROP INDEX IF EXISTS media_user_id_idx;
DROP INDEX IF EXISTS upload_sessions_user_idx;
DROP INDEX IF EXISTS mtproto_jobs_user_idx;
