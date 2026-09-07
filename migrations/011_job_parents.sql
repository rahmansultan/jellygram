-- A job now names the session or MTProto fetch it belongs to, with a real
-- foreign key, so deleting that parent — a user removed with an upload in
-- flight — takes the job with it. Until now those jobs named their parent
-- only inside the JSON payload, so they survived every cascade: parked ones
-- inflated the dashboard's deferred count forever, and runnable ones were
-- claimed, found nothing, and failed.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS session_id BIGINT REFERENCES upload_sessions (id) ON DELETE CASCADE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS mtproto_job_id BIGINT REFERENCES mtproto_jobs (id) ON DELETE CASCADE;

-- Existing rows: adopt the parent the payload names where it still exists.
UPDATE jobs j SET session_id = (j.payload->>'sessionId')::bigint
 WHERE j.session_id IS NULL
   AND j.payload ? 'sessionId'
   AND (j.payload->>'sessionId') ~ '^[0-9]+$'
   AND EXISTS (SELECT 1 FROM upload_sessions s WHERE s.id = (j.payload->>'sessionId')::bigint);

UPDATE jobs j SET mtproto_job_id = (j.payload->>'mtprotoJobId')::bigint
 WHERE j.mtproto_job_id IS NULL
   AND j.payload ? 'mtprotoJobId'
   AND (j.payload->>'mtprotoJobId') ~ '^[0-9]+$'
   AND EXISTS (SELECT 1 FROM mtproto_jobs m WHERE m.id = (j.payload->>'mtprotoJobId')::bigint);

-- Pending jobs whose parent is already gone can never do anything.
DELETE FROM jobs j
 WHERE j.status = 'pending'
   AND ((j.payload ? 'sessionId' AND j.session_id IS NULL)
     OR (j.payload ? 'mtprotoJobId' AND j.mtproto_job_id IS NULL));

CREATE INDEX IF NOT EXISTS jobs_session_idx ON jobs (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_mtproto_job_idx ON jobs (mtproto_job_id) WHERE mtproto_job_id IS NOT NULL;
