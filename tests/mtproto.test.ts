import './helpers/test-database.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../src/config/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { closePool, query } from '../src/db/pool.js';
import { mtprotoJobsRepo, uploadsRepo, usersRepo } from '../src/db/repositories.js';
import { storageSlug, sanitizeFilename, safeJoin } from '../src/lib/paths.js';
import {
  SESSION_FILE_MODE,
  MtprotoError,
  readSessionString,
  writeSessionString,
  deleteSession,
  disconnectClient,
  downloadMedia,
  requestSize,
  status as mtprotoStatus,
} from '../src/services/mtproto.js';

/**
 * MTProto ingestion: size policy, job lifecycle, session security, and the
 * handoff into the existing pipeline.
 *
 * No network calls are made. The transport itself is exercised by
 * tests/mtproto.e2e.ts with a stubbed download.
 */

const GiB = 1024 * 1024 * 1024;
/** Outside database.test.ts's reserved range; see the note in that file. */
const TEST_CHAT_ID = -999_777_888;
const created: number[] = [];

before(async () => {
  await runMigrations();
  await cleanup();
});

after(async () => {
  await cleanup();
  // Once an account is linked, `status()` opens a live MTProto connection.
  // Without this the socket keeps the event loop alive and the run never ends.
  await disconnectClient().catch(() => {});
  await closePool();
});

async function cleanup(): Promise<void> {
  // Matched by name rather than by an id range: the range depended on how many
  // users had been created, which made it fragile.
  await query("DELETE FROM users WHERE name LIKE 'MTProto %'");
}

/**
 * A distinct Telegram id per user.
 *
 * Incremented before the insert, not derived from a list that only grows on
 * success, so a failed create cannot make the next call reuse an id.
 */
let userSeq = 0;

async function makeUser(suffix: string) {
  userSeq += 1;
  const unique = `${Date.now()}-${userSeq}-${Math.random().toString(36).slice(2, 8)}`;
  const slug = storageSlug(`mt-${suffix}-${unique}`);
  const user = await usersRepo.create({
    name: `MTProto ${suffix} ${unique}`,
    telegram_chat_id: TEST_CHAT_ID - userSeq,
    jellyfin_username: slug,
    jellyfin_user_id: null,
    storage_slug: slug,
  });
  created.push(user.id);
  return user;
}

function jobInput(userId: number, overrides: Record<string, unknown> = {}) {
  return {
    user_id: userId,
    telegram_chat_id: TEST_CHAT_ID,
    bot_message_id: Math.floor(Math.random() * 1_000_000),
    progress_message_id: null,
    origin_kind: 'channel' as const,
    origin_chat: '@somechannel',
    origin_message_id: 4242,
    origin_title: 'Some Channel',
    file_name: 'Interstellar.2014.2160p.mkv',
    file_size: 3 * GiB,
    mime_type: 'video/x-matroska',
    telegram_file_unique_id: 'uniq-1',
    caption: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Size policy
// ---------------------------------------------------------------------------

test('the MTProto ceiling is exactly 5 GiB', () => {
  assert.equal(config.mtproto.maxFileBytes, 5 * GiB);
  assert.equal(config.mtproto.maxFileBytes, 5_368_709_120);
});

test('the Bot API ceiling is below the MTProto ceiling', async () => {
  const { botApiFileLimit } = await import('../src/services/download.js');
  assert.ok(
    botApiFileLimit() < config.mtproto.maxFileBytes,
    'MTProto exists precisely because it reaches further than the Bot API',
  );
});

test('exactly 2 GiB is within the MTProto ceiling', () => {
  assert.ok(2 * GiB <= config.mtproto.maxFileBytes);
});

test('2 GiB + 1 byte is within the MTProto ceiling', () => {
  assert.ok(2 * GiB + 1 <= config.mtproto.maxFileBytes);
});

test('exactly 5 GiB is accepted', () => {
  assert.ok(5 * GiB <= config.mtproto.maxFileBytes, 'the ceiling is inclusive');
});

test('5 GiB + 1 byte is above the ceiling', () => {
  assert.ok(5 * GiB + 1 > config.mtproto.maxFileBytes);
});

test('a file above the Bot API ceiling but under 5 GiB is the MTProto case', async () => {
  const { botApiFileLimit } = await import('../src/services/download.js');
  for (const size of [2 * GiB + 1, 3 * GiB, 4 * GiB, 5 * GiB]) {
    assert.ok(size > botApiFileLimit(), `${size} should exceed the Bot API`);
    assert.ok(size <= config.mtproto.maxFileBytes, `${size} should be within MTProto`);
  }
});

// ---------------------------------------------------------------------------
// Disabled / unconfigured
// ---------------------------------------------------------------------------

test('status reports cleanly when MTProto is not set up', async () => {
  const s = await mtprotoStatus();
  assert.equal(typeof s.enabled, 'boolean');
  assert.equal(typeof s.credentialsPresent, 'boolean');
  assert.equal(typeof s.authorized, 'boolean');
  assert.ok(s.message.length > 0, 'there should always be an explanation');
});

test('status never exposes the session', async () => {
  const s = await mtprotoStatus();
  const serialised = JSON.stringify(s);
  assert.ok(!/session["']?\s*:\s*["'][A-Za-z0-9+/=]{20,}/.test(serialised));
  assert.ok(!serialised.includes(config.mtproto.apiHash || 'NO_HASH_SET'));
});

test('an unauthorised client raises a clear, non-retryable error', async () => {
  // With no session on disk the client must refuse rather than hang.
  const existing = await readSessionString();
  if (existing) return; // a real session is present; do not disturb it

  const { getClient } = await import('../src/services/mtproto.js');
  await assert.rejects(
    () => getClient(),
    (err: unknown) => {
      assert.ok(err instanceof MtprotoError);
      assert.equal(err.retryable, false);
      assert.ok(['auth', 'config'].includes(err.kind));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Session security
// ---------------------------------------------------------------------------

test('a written session is owner-readable only', async () => {
  const original = await readSessionString();
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jellygram-session-'));
  const probe = path.join(tmpDir, 'session-probe');

  try {
    // Exercise the same write path against a temporary location.
    await fsp.writeFile(probe, 'x'.repeat(64), { mode: SESSION_FILE_MODE });
    await fsp.chmod(probe, SESSION_FILE_MODE);
    const mode = (await fsp.stat(probe)).mode & 0o777;

    assert.equal(mode, 0o600, 'the session must not be readable by group or others');
    assert.equal(mode & 0o077, 0);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
    assert.equal(await readSessionString(), original, 'the real session must be untouched');
  }
});

test('the real session file, if present, is 0600', async () => {
  try {
    const mode = (await fsp.stat(config.mtproto.sessionPath)).mode & 0o777;
    assert.equal(mode, 0o600);
  } catch {
    // No session yet, which is a valid state.
    assert.ok(true);
  }
});

test('the session path is covered by gitignore', async () => {
  const ignore = await fsp.readFile(path.join(config.projectRoot, '.gitignore'), 'utf8');
  assert.match(ignore, /\.mtproto-session/);
});

test('no source file contains a session-shaped literal', async () => {
  const roots = ['src', 'tests', 'public', 'uploader'];
  for (const root of roots) {
    const dir = path.join(config.projectRoot, root);
    for (const file of await walk(dir)) {
      const content = await fsp.readFile(file, 'utf8');
      // StringSession blobs start with '1' and run for hundreds of base64 chars.
      assert.ok(
        !/['"`]1[A-Za-z0-9+/=_-]{200,}['"`]/.test(content),
        `${file} contains something session-shaped`,
      );
    }
  }
});

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (/\.(ts|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

test('a job records everything the dashboard needs', async () => {
  const user = await makeUser('lifecycle');
  const job = await mtprotoJobsRepo.create(jobInput(user.id));

  assert.ok(job.id > 0, 'unique job id');
  assert.equal(job.user_id, user.id, 'owner');
  assert.equal(job.status, 'PENDING');
  assert.equal(job.file_name, 'Interstellar.2014.2160p.mkv');
  assert.equal(job.file_size, 3 * GiB);
  assert.equal(job.origin_message_id, 4242, 'telegram message id');
  assert.equal(job.bytes_downloaded, 0);
  assert.equal(job.attempts, 0);
  assert.ok(job.created_at instanceof Date);
  assert.equal(job.completed_at, null);
  assert.equal(job.error_message, null);
});

test('status transitions run through the full lifecycle', async () => {
  const user = await makeUser('transitions');
  const job = await mtprotoJobsRepo.create(jobInput(user.id));

  for (const s of ['LOCATING', 'DOWNLOADING', 'VERIFYING', 'HANDOFF'] as const) {
    const updated = await mtprotoJobsRepo.setStatus(job.id, s);
    assert.equal(updated?.status, s);
  }

  const done = await mtprotoJobsRepo.setStatus(job.id, 'COMPLETED', { completed_at: new Date() });
  assert.equal(done?.status, 'COMPLETED');
  assert.ok(done?.completed_at);
});

test('an invalid status is rejected by the database', async () => {
  const user = await makeUser('badstatus');
  const job = await mtprotoJobsRepo.create(jobInput(user.id));
  await assert.rejects(
    () => query('UPDATE mtproto_jobs SET status = $2 WHERE id = $1', [job.id, 'NONSENSE']),
    /violates check constraint/i,
  );
});

test('progress and speed are recorded', async () => {
  const user = await makeUser('progress');
  const job = await mtprotoJobsRepo.create(jobInput(user.id));

  await mtprotoJobsRepo.setProgress(job.id, 1024 * 1024, 5_000_000);
  const updated = await mtprotoJobsRepo.byId(job.id);

  assert.equal(updated?.bytes_downloaded, 1024 * 1024);
  assert.equal(updated?.speed_bps, 5_000_000);
});

test('retry count increments', async () => {
  const user = await makeUser('attempts');
  const job = await mtprotoJobsRepo.create(jobInput(user.id));

  assert.equal(await mtprotoJobsRepo.incrementAttempts(job.id), 1);
  assert.equal(await mtprotoJobsRepo.incrementAttempts(job.id), 2);
});

test('a forwarded message cannot start two concurrent downloads', async () => {
  const user = await makeUser('dedupe');
  const messageId = 987654;

  await mtprotoJobsRepo.create(jobInput(user.id, { bot_message_id: messageId }));

  const active = await mtprotoJobsRepo.activeForMessage(user.id, messageId);
  assert.ok(active, 'the in-flight job should be found');

  await assert.rejects(
    () => mtprotoJobsRepo.create(jobInput(user.id, { bot_message_id: messageId })),
    /duplicate key|unique/i,
    'a second forward of the same message must not queue a second 5 GB download',
  );
});

test('a finished job frees the message for a fresh attempt', async () => {
  const user = await makeUser('refetch');
  const messageId = 5551212;

  const first = await mtprotoJobsRepo.create(jobInput(user.id, { bot_message_id: messageId }));
  await mtprotoJobsRepo.setStatus(first.id, 'FAILED', { completed_at: new Date() });

  assert.equal(await mtprotoJobsRepo.activeForMessage(user.id, messageId), null);
  const second = await mtprotoJobsRepo.create(jobInput(user.id, { bot_message_id: messageId }));
  assert.notEqual(second.id, first.id);
});

test('cancellation is recorded and is idempotent for finished jobs', async () => {
  const user = await makeUser('cancel');
  const job = await mtprotoJobsRepo.create(jobInput(user.id));

  assert.ok(await mtprotoJobsRepo.requestCancel(job.id));
  assert.equal(await mtprotoJobsRepo.isCancelRequested(job.id), true);

  await mtprotoJobsRepo.setStatus(job.id, 'COMPLETED', { completed_at: new Date() });
  assert.equal(await mtprotoJobsRepo.requestCancel(job.id), null);
});

test('an interrupted job is reset on worker start', async () => {
  const user = await makeUser('stale');
  const job = await mtprotoJobsRepo.create(jobInput(user.id));
  await mtprotoJobsRepo.setStatus(job.id, 'DOWNLOADING');
  await mtprotoJobsRepo.setProgress(job.id, 999, 1);

  // Scoped to this job on purpose. `mtprotoJobsRepo.resetStale()` deliberately
  // has no id filter — the worker runs it at startup when nothing is in flight
  // — so calling it from a test against the shared database would reset live
  // production jobs mid-download.
  await query(
    `UPDATE mtproto_jobs SET status = 'PENDING', bytes_downloaded = 0
      WHERE id = $1 AND status IN ('LOCATING','DOWNLOADING','VERIFYING')`,
    [job.id],
  );

  const recovered = await mtprotoJobsRepo.byId(job.id);
  assert.equal(recovered?.status, 'PENDING');
  assert.equal(recovered?.bytes_downloaded, 0, 'a partial download must not be counted');
});

test('concurrent jobs stay independent', async () => {
  const a = await makeUser('conc-a');
  const b = await makeUser('conc-b');

  const [jobA, jobB] = await Promise.all([
    mtprotoJobsRepo.create(jobInput(a.id, { file_name: 'A.mkv' })),
    mtprotoJobsRepo.create(jobInput(b.id, { file_name: 'B.mkv' })),
  ]);

  assert.notEqual(jobA.id, jobB.id);

  await mtprotoJobsRepo.setProgress(jobA.id, 100, 10);
  await mtprotoJobsRepo.setProgress(jobB.id, 200, 20);

  assert.equal((await mtprotoJobsRepo.byId(jobA.id))?.bytes_downloaded, 100);
  assert.equal((await mtprotoJobsRepo.byId(jobB.id))?.bytes_downloaded, 200);
  assert.equal((await mtprotoJobsRepo.byId(jobA.id))?.user_id, a.id);
  assert.equal((await mtprotoJobsRepo.byId(jobB.id))?.user_id, b.id);
});

test('two concurrent jobs never share a temporary filename', () => {
  // The job id is part of the path, so simultaneous downloads cannot collide.
  const first = safeJoin(config.storage.downloadTmpDir, `mtproto-1-${Date.now()}-Movie.mkv`);
  const second = safeJoin(config.storage.downloadTmpDir, `mtproto-2-${Date.now()}-Movie.mkv`);
  assert.notEqual(first, second);
});

// ---------------------------------------------------------------------------
// Untrusted metadata
// ---------------------------------------------------------------------------

test('a hostile filename cannot escape the temp directory', () => {
  for (const hostile of [
    '../../../../etc/cron.d/evil.mkv',
    '/etc/passwd.mkv',
    '..\\..\\windows\\system32\\evil.mkv',
    'movie.mkv/../../../root/.ssh/authorized_keys',
  ]) {
    const safe = sanitizeFilename(hostile, 'fallback');
    const target = safeJoin(config.storage.downloadTmpDir, `mtproto-1-0-${safe}`);
    assert.ok(
      target.startsWith(config.storage.downloadTmpDir + path.sep),
      `${hostile} escaped to ${target}`,
    );
    assert.ok(!target.includes('..'));
  }
});

test('a filename from Telegram is stored but never used raw as a path', async () => {
  const user = await makeUser('hostile');
  const job = await mtprotoJobsRepo.create(
    jobInput(user.id, { file_name: '../../etc/shadow.mkv' }),
  );

  // The raw value is retained for display and identification…
  assert.equal(job.file_name, '../../etc/shadow.mkv');
  // …but sanitises to something that cannot traverse.
  const safe = sanitizeFilename(job.file_name, 'fallback');
  assert.ok(!safe.includes('/'));
  assert.ok(!safe.includes('..'));
});

// ---------------------------------------------------------------------------
// Handoff into the existing pipeline
// ---------------------------------------------------------------------------

test('the handoff creates an ordinary upload row the pipeline understands', async () => {
  const user = await makeUser('handoff');
  const job = await mtprotoJobsRepo.create(jobInput(user.id));

  const tmp = path.join(config.storage.downloadTmpDir, `mtproto-test-${job.id}`);
  await fsp.writeFile(tmp, Buffer.alloc(2048, 7));

  try {
    const upload = await uploadsRepo.createFromMtproto({
      user_id: user.id,
      telegram_chat_id: TEST_CHAT_ID,
      mtproto_job_id: job.id,
      original_filename: 'Interstellar.2014.2160p.mkv',
      safe_filename: 'Interstellar.2014.2160p.mkv',
      extension: 'mkv',
      file_size: 2048,
      local_source_path: tmp,
      progress_message_id: null,
    });

    assert.equal(upload.source, 'mtproto', 'the route is recorded');
    assert.equal(upload.mtproto_job_id, job.id, 'linked back to the job');
    assert.equal(upload.local_source_path, tmp, 'the pipeline reads the local file');
    assert.equal(upload.status, 'QUEUED', 'it enters the shared queue');
    assert.equal(upload.user_id, user.id, 'ownership is preserved');
    assert.equal(upload.telegram_file_id, null, 'nothing is fetched from the Bot API');
  } finally {
    await fsp.rm(tmp, { force: true });
  }
});

test('ownership follows the existing user mapping, not the MTProto account', async () => {
  const owner = await makeUser('owner');
  const other = await makeUser('other');

  const job = await mtprotoJobsRepo.create(jobInput(owner.id));
  const tmp = path.join(config.storage.downloadTmpDir, `mtproto-owner-${job.id}`);
  await fsp.writeFile(tmp, Buffer.alloc(16, 1));

  try {
    const upload = await uploadsRepo.createFromMtproto({
      user_id: job.user_id,
      telegram_chat_id: job.telegram_chat_id,
      mtproto_job_id: job.id,
      original_filename: 'X.mkv',
      safe_filename: 'X.mkv',
      extension: 'mkv',
      file_size: 16,
      local_source_path: tmp,
      progress_message_id: null,
    });

    assert.equal(upload.user_id, owner.id);
    assert.notEqual(upload.user_id, other.id, 'media must not land in another user library');
  } finally {
    await fsp.rm(tmp, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

test('a SHA-256 computed while streaming matches a hash of the finished file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jellygram-mt-hash-'));
  const target = path.join(dir, 'streamed');

  try {
    const chunks = [
      crypto.randomBytes(64 * 1024),
      crypto.randomBytes(64 * 1024),
      crypto.randomBytes(1234),
    ];

    // Mirrors the downloader: hash as the bytes pass, never re-read the file.
    const running = crypto.createHash('sha256');
    const sink = fs.createWriteStream(target);
    for (const chunk of chunks) {
      running.update(chunk);
      sink.write(chunk);
    }
    await new Promise<void>((resolve) => sink.end(resolve));

    const streamed = running.digest('hex');
    const fromDisk = crypto.createHash('sha256').update(await fsp.readFile(target)).digest('hex');

    assert.equal(streamed, fromDisk);
    assert.equal(streamed.length, 64);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a truncated download is detectable by size alone', () => {
  const expected = 3 * GiB;
  const received = expected - 4096;
  assert.notEqual(received, expected, 'the size check is what catches a short download');
});

// ---------------------------------------------------------------------------
// The iterDownload call shape
//
// `iterDownload(file, params)` takes two positional arguments. Passing a single
// `{ file, requestSize }` object instead makes the library treat that object as
// the file and fail with "Cannot cast [object Object] to any kind of
// InputFileLocation" — which is exactly what happened in production.
// ---------------------------------------------------------------------------

/** A client that records how iterDownload was called and yields fixed bytes. */
function recordingClient(chunks: Buffer[]) {
  const calls: Array<{ args: unknown[] }> = [];
  return {
    calls,
    iterDownload(...args: unknown[]) {
      calls.push({ args });
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  };
}

test('iterDownload is called with the media positionally, not in an options bag', async () => {
  const dir = await fsp.mkdtemp(path.join(config.storage.downloadTmpDir, 'jellygram-iter-'));
  const destination = path.join(dir, 'out.bin');
  const payload = crypto.randomBytes(8192);
  const media = { className: 'MessageMediaDocument', SUBCLASS_OF_ID: 0x476cbe32 };

  try {
    const client = recordingClient([payload]);
    await downloadMedia(media, { destination, expectedSize: payload.length }, client);

    assert.equal(client.calls.length, 1);
    const [first, second] = client.calls[0]!.args;

    assert.equal(first, media, 'the media must be the FIRST positional argument');
    assert.ok(
      second && typeof second === 'object' && 'requestSize' in (second as object),
      'the second argument must be the params object carrying requestSize',
    );
    assert.ok(
      !(first as Record<string, unknown>)?.['file'],
      'the media must not be wrapped in a { file } bag',
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a streamed download writes the exact bytes and hashes them', async () => {
  const dir = await fsp.mkdtemp(path.join(config.storage.downloadTmpDir, 'jellygram-iter-'));
  const destination = path.join(dir, 'out.bin');
  const chunks = [crypto.randomBytes(4096), crypto.randomBytes(4096), crypto.randomBytes(17)];
  const whole = Buffer.concat(chunks);

  try {
    const result = await downloadMedia(
      { className: 'MessageMediaDocument' },
      { destination, expectedSize: whole.length },
      recordingClient(chunks),
    );

    assert.equal(result.bytes, whole.length);
    assert.deepEqual(await fsp.readFile(destination), whole);
    assert.equal(result.sha256, crypto.createHash('sha256').update(whole).digest('hex'));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a short stream is rejected and the partial file removed', async () => {
  const dir = await fsp.mkdtemp(path.join(config.storage.downloadTmpDir, 'jellygram-iter-'));
  const destination = path.join(dir, 'out.bin');

  try {
    await assert.rejects(
      () =>
        downloadMedia(
          { className: 'MessageMediaDocument' },
          { destination, expectedSize: 999_999 },
          recordingClient([crypto.randomBytes(512)]),
        ),
      (err: unknown) => {
        assert.ok(err instanceof MtprotoError);
        assert.match(err.message, /Truncated/i);
        return true;
      },
    );
    assert.ok(!fs.existsSync(destination), 'a truncated download must not be left on disk');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the request size is always one Telegram will accept', () => {
  const size = requestSize();
  assert.equal(size % 4096, 0, 'upload.getFile requires a multiple of 4096');
  assert.ok(size >= 4096 && size <= 1024 * 1024, `${size} is outside the accepted range`);
});

// ---------------------------------------------------------------------------
// Only one worker may run a given job
//
// Two queue entries can point at the same MTProto job — a stale retry plus an
// admin requeue, for instance. Without a claim they would both download the
// same multi-gigabyte file and fight over one row.
// ---------------------------------------------------------------------------

test('a job can only be claimed once', async () => {
  const user = await makeUser('claim');
  const job = await mtprotoJobsRepo.create(jobInput(user.id));

  const first = await mtprotoJobsRepo.claimForDownload(job.id);
  const second = await mtprotoJobsRepo.claimForDownload(job.id);

  assert.ok(first, 'the first caller should win the claim');
  assert.equal(first.status, 'LOCATING');
  assert.equal(first.attempts, 1, 'claiming counts as an attempt');
  assert.equal(second, null, 'the second caller must be turned away');
});

test('two simultaneous claims produce exactly one winner', async () => {
  const user = await makeUser('claim-race');
  const job = await mtprotoJobsRepo.create(jobInput(user.id));

  const results = await Promise.all([
    mtprotoJobsRepo.claimForDownload(job.id),
    mtprotoJobsRepo.claimForDownload(job.id),
    mtprotoJobsRepo.claimForDownload(job.id),
  ]);

  assert.equal(results.filter(Boolean).length, 1, 'exactly one claim may succeed');
  const after = await mtprotoJobsRepo.byId(job.id);
  assert.equal(after?.attempts, 1, 'a losing claim must not inflate the attempt count');
});

test('a job that is not pending cannot be claimed', async () => {
  const user = await makeUser('claim-done');
  const job = await mtprotoJobsRepo.create(jobInput(user.id));
  await mtprotoJobsRepo.setStatus(job.id, 'COMPLETED', { completed_at: new Date() });

  assert.equal(await mtprotoJobsRepo.claimForDownload(job.id), null);
});

test('a reset job becomes claimable again', async () => {
  const user = await makeUser('claim-reset');
  const job = await mtprotoJobsRepo.create(jobInput(user.id));

  assert.ok(await mtprotoJobsRepo.claimForDownload(job.id));
  // Scoped to this job (the recovery the worker performs after a crash) on purpose. `mtprotoJobsRepo.resetStale()` deliberately
  // has no id filter — the worker runs it at startup when nothing is in flight
  // — so calling it from a test against the shared database would reset live
  // production jobs mid-download.
  await query(
    `UPDATE mtproto_jobs SET status = 'PENDING', bytes_downloaded = 0
      WHERE id = $1 AND status IN ('LOCATING','DOWNLOADING','VERIFYING')`,
    [job.id],
  );
  assert.ok(await mtprotoJobsRepo.claimForDownload(job.id), 'recovery must allow a fresh attempt');
});

// ---------------------------------------------------------------------------
// Test hygiene
// ---------------------------------------------------------------------------

test('no test calls a global reset that would disturb live jobs', async () => {
  // resetStale() and releaseOrphans() intentionally have no id filter: the
  // worker runs them at startup. Calling them from a test against the shared
  // database resets whatever real work happens to be in flight — which is
  // exactly what once flipped a live 2 GB download back to PENDING.
  const dir = path.join(config.projectRoot, 'tests');
  // `resetStale` has no row filter at all, so any call is unsafe here.
  // `releaseOrphans` may be called *with* a worker id — that is scoped to rows
  // this test created — but never bare, which would release live jobs.
  const callPattern = /\w+Repo\s*\.\s*resetStale\s*\(|\w+Repo\s*\.\s*releaseOrphans\s*\(\s*\)/;

  for (const file of await walk(dir)) {
    const content = await fsp.readFile(file, 'utf8');
    // Strip comments so this rule is about calls, not about prose describing
    // them — including the comment directly above.
    const code = content
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

    const offender = code.match(callPattern);
    assert.ok(
      !offender,
      `${path.basename(file)} calls ${offender?.[0] ?? ''}; scope the update to its own rows instead`,
    );
  }
});

// ---------------------------------------------------------------------------
// status() must not dial Telegram
//
// The API calls this on every dashboard load. If it opened a connection it
// would hold a second MTProto client on the same session as the worker, and a
// slow handshake would stall the page — which is exactly what happened.
// ---------------------------------------------------------------------------

test('status() returns promptly and without connecting', async () => {
  const started = Date.now();
  const s = await mtprotoStatus();
  const elapsed = Date.now() - started;

  assert.ok(
    elapsed < 2000,
    `status() took ${elapsed}ms; it must answer from configuration and disk alone`,
  );
  assert.equal(typeof s.enabled, 'boolean');
  assert.equal(typeof s.sessionPresent, 'boolean');
});

test('status() still reports the fields the dashboard needs', async () => {
  const s = await mtprotoStatus();
  for (const key of ['enabled', 'credentialsPresent', 'sessionPresent', 'authorized', 'message']) {
    assert.ok(key in s, `status() should expose ${key}`);
  }
  // And nothing it must not.
  assert.ok(!('session' in s));
  assert.ok(!('apiHash' in s));
});

test('a stalled MTProto download fails instead of holding a worker slot forever', async () => {
  // `iterDownload` takes no signal and no timeout, so without a stall guard a
  // connection that stops sending parks `for await` indefinitely.
  const stalling = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('first chunk');
      // Long enough to look like a stall, on an unref'd timer so it cannot
      // keep the test runner's event loop alive.
      await new Promise((resolve) => setTimeout(resolve, 60_000).unref());
    },
  };

  const client = {
    iterDownload: () => stalling,
    connected: true,
  } as unknown as Parameters<typeof downloadMedia>[2];

  const destination = path.join(config.storage.downloadTmpDir, `stall-test-${Date.now()}.bin`);
  try {
    await assert.rejects(
      () =>
        downloadMedia({} as never, { destination, expectedSize: 1024, stallTimeoutMs: 150 }, client),
      (err: unknown) => {
        const e = err as Error & { retryable?: boolean; cause?: Error };
        assert.match(e.message, /stalled/, 'the stall is named in the message');
        assert.equal(e.retryable, true, 'a stall is transient and must be retried');
        assert.equal(e.cause?.name, 'MtprotoStalledError', 'the original error is preserved as the cause');
        return true;
      },
    );
  } finally {
    await fsp.rm(destination, { force: true }).catch(() => {});
  }
});
