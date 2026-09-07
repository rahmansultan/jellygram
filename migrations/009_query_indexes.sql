-- ---------------------------------------------------------------------------
-- Indexes the lists actually need.
--
-- Measured against a scratch database seeded to 200k uploads and 80k media
-- rows, which is the only way any of this is visible: production holds a few
-- hundred rows, where every plan is fast and every missing index looks fine.
-- ---------------------------------------------------------------------------

-- The uploads list reports whether Jellyfin can see each row, joining the
-- media row that came from the upload. Without this the planner had no choice
-- but a sequential scan of media *per upload row scanned* — 10,025 scans of
-- 80,000 rows for one deep page, 18 million buffer hits, 29 seconds.
CREATE INDEX IF NOT EXISTS media_upload_idx ON media (upload_id);

-- Every list is "the newest first, for this user" or "the newest first, with
-- this status". A single-column index on the filter still leaves the whole
-- matching set to be sorted; the composites let the index supply the order.
CREATE INDEX IF NOT EXISTS uploads_user_created_idx   ON uploads (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS uploads_status_created_idx ON uploads (status, created_at DESC);

-- Media is browsed newest-first, filtered by owner and type.
CREATE INDEX IF NOT EXISTS media_created_idx      ON media (created_at DESC);
CREATE INDEX IF NOT EXISTS media_user_type_idx    ON media (user_id, type, created_at DESC);

-- The activity page filters by actor and reads newest-first.
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs (actor_type, created_at DESC);

-- Session and fetch lists, same shape as uploads.
CREATE INDEX IF NOT EXISTS upload_sessions_user_created_idx ON upload_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mtproto_jobs_user_created_idx    ON mtproto_jobs (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Substring search.
--
-- `ILIKE '%term%'` cannot use a btree index at all, so searching a filename
-- reads every row. Trigram indexes make it an index scan. This is deliberately
-- best-effort: pg_trgm is a trusted extension on PostgreSQL 13 and later, but a
-- deployment that cannot install it should still start — the searches merely
-- stay linear, which is exactly what they were before.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm unavailable (%); text search stays sequential', SQLERRM;
    RETURN;
  END;

  CREATE INDEX IF NOT EXISTS uploads_filename_trgm_idx
    ON uploads USING gin (original_filename gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS uploads_title_trgm_idx
    ON uploads USING gin (detected_title gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS media_title_trgm_idx
    ON media USING gin (title gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS upload_sessions_filename_trgm_idx
    ON upload_sessions USING gin (base_filename gin_trgm_ops);
END
$$;
