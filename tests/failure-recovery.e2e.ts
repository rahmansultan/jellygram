// All imported before anything that reads configuration: the tests' own
// database and media tree, a queue this suite's jobs can actually be claimed
// from, and the worker that claims them.
import './helpers/small-disk-reserve.js';
import './helpers/test-database.js';
import './helpers/test-media-root.js';
import './helpers/queue-live.js';
import './helpers/test-worker.js';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stdout } from 'node:process';
import { execFileSync } from 'node:child_process';
import { config } from '../src/config/index.js';
import { closePool, query } from '../src/db/pool.js';
import { jobsRepo, uploadsRepo, usersRepo } from '../src/db/repositories.js';
import { storageSlug } from '../src/lib/paths.js';
import { mediaGid } from '../src/services/storage.js';
import type { UploadRow } from '../src/db/types.js';

/**
 * Failure recovery, against the live worker.
 *
 *   npm run test:recovery
 *
 * Proves three things the production incident exposed:
 *   1. a failure records WHICH STAGE failed, a code, and whether it is
 *      retryable — not just a prose message;
 *   2. a retry after the cause is fixed actually completes;
 *   3. the file the worker files is group-readable by Jellyfin, which requires
 *      setgid inheritance because the worker cannot call chown.
 *
 * Requires jellygram-worker to be running.
 */

// This suite owns this chat-id range; see the note in tests/database.test.ts.
const TEST_CHAT_ID = -999_555_000;

let checks = 0;
let failures = 0;
let skipped = 0;

function check(ok: boolean, label: string, detail = ''): void {
  checks += 1;
  if (!ok) failures += 1;
  stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
}

function say(text = ''): void {
  stdout.write(`${text}\n`);
}

/**
 * Reported, never counted as a pass or a failure.
 *
 * The group-ownership section below can only be evaluated on a host where
 * MEDIA_GROUP resolves — a machine with Jellyfin installed, or one where the
 * group was created by hand. A CI runner has neither, and asserting there
 * turned "this host cannot answer the question" into "this code is broken".
 * `tests/storage-ownership.test.ts` already skips the same condition; this
 * matches it.
 */
function skip(label: string, why: string): void {
  skipped += 1;
  stdout.write(`  SKIP  ${label}\n        ${why}\n`);
}

async function waitForStatus(id: number, wanted: string[], timeoutMs: number): Promise<UploadRow> {
  const deadline = Date.now() + timeoutMs;
  let row: UploadRow | null = null;
  while (Date.now() < deadline) {
    row = await uploadsRepo.byId(id);
    if (row && wanted.includes(row.status)) return row;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`upload ${id} stayed in ${row?.status ?? 'unknown'}, wanted one of ${wanted.join('/')}`);
}

/** A tiny but genuinely playable MKV, so identification behaves normally. */
async function makeVideo(target: string): Promise<number> {
  const ffmpeg = ['/usr/lib/jellyfin-ffmpeg/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg'].find((p) => {
    try {
      execFileSync(p, ['-version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });
  if (!ffmpeg) throw new Error('ffmpeg not available');
  execFileSync(
    ffmpeg,
    ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=5', '-c:v', 'libx264', target],
    { stdio: 'ignore' },
  );
  return (await fsp.stat(target)).size;
}

async function main(): Promise<void> {
  say();
  say('Failure recovery end-to-end');
  say('===========================');

  // A previous run killed before its cleanup (a missing ffmpeg, say) would
  // otherwise leave a user and a media directory behind for good.
  const { rows: stale } = await query<{ id: number; storage_slug: string }>(
    `SELECT id, storage_slug FROM users WHERE name LIKE 'Recovery %'`,
  );
  for (const row of stale) {
    await query('DELETE FROM media WHERE user_id = $1', [row.id]);
    await query('DELETE FROM jobs WHERE upload_id IN (SELECT id FROM uploads WHERE user_id = $1)', [row.id]);
    await query('DELETE FROM uploads WHERE user_id = $1', [row.id]);
    await query('DELETE FROM users WHERE id = $1', [row.id]);
    for (const root of [config.storage.moviesRoot, config.storage.tvRoot]) {
      await fsp.rm(path.join(root, row.storage_slug), { recursive: true, force: true }).catch(() => {});
    }
  }
  if (stale.length > 0) say(`(cleaned up ${stale.length} leftover user(s) from an earlier run)`);

  const suffix = `${process.pid}`;
  const user = await usersRepo.create({
    name: `Recovery ${suffix}`,
    telegram_chat_id: TEST_CHAT_ID - Number(suffix.slice(-4)),
    jellyfin_username: `recovery-${suffix}`,
    jellyfin_user_id: null,
    storage_slug: storageSlug(`recovery-${suffix}`),
  });

  const source = path.join(config.storage.downloadTmpDir, `recovery-${suffix}-Recovery.Test.2021.1080p.mkv`);
  // Held outside the staging directory until step 2: ffmpeg infers the
  // container from the extension, so the holding path must end in .mkv too.
  const staged = path.join(os.tmpdir(), `jellygram-recovery-${suffix}.mkv`);
  const size = await makeVideo(staged);

  // --- 1. a failure that a retry CAN fix -----------------------------------
  say();
  say('1. A recoverable failure is recorded with structured detail');

  const upload = await uploadsRepo.createDirect({
    user_id: user.id,
    telegram_chat_id: user.telegram_chat_id,
    original_filename: 'Recovery.Test.2021.1080p.mkv',
    safe_filename: 'Recovery.Test.2021.1080p.mkv',
    extension: 'mkv',
    file_size: size,
    // The source is deliberately absent, so the download stage fails.
    local_source_path: source,
  });
  await jobsRepo.enqueue({ type: 'process-upload', upload_id: upload.id });

  const failed = await waitForStatus(upload.id, ['FAILED'], 180_000);
  check(failed.status === 'FAILED', 'the upload failed as expected');
  check(Boolean(failed.error_message), 'a message was recorded', failed.error_message ?? '');
  check(
    failed.error_stage !== null,
    'the STAGE that failed was recorded',
    `stage=${failed.error_stage}`,
  );
  check(failed.error_code !== null, 'an error code was recorded', `code=${failed.error_code}`);
  check(failed.error_retryable !== null, 'retryability was recorded', `retryable=${failed.error_retryable}`);
  check(failed.error_at !== null, 'the failure time was recorded');
  check(failed.attempts > 0, 'the attempt count was recorded', `attempts=${failed.attempts}`);

  // --- 2. fix the cause and retry ------------------------------------------
  say();
  say('2. Once the cause is fixed, a retry completes');
  await fsp.copyFile(staged, source);
  await jobsRepo.retryUpload(upload.id);

  const done = await waitForStatus(upload.id, ['COMPLETED', 'FAILED', 'DUPLICATE'], 300_000);
  check(done.status === 'COMPLETED', 'the retry completed', `status=${done.status} ${done.error_message ?? ''}`);
  check(Boolean(done.stored_path), 'the file was filed into the library');
  check(done.error_stage === null, 'the stale failure detail was cleared on success');

  // --- 3. Jellyfin can actually read what the worker wrote ------------------
  say();
  say('3. The filed media is group-readable by Jellyfin');
  const gid = await mediaGid();
  if (done.stored_path && gid !== null) {
    const st = await fsp.stat(done.stored_path);
    check(st.gid === gid, 'the file carries the media group', `gid=${st.gid} expected=${gid}`);
    const dir = await fsp.stat(path.dirname(done.stored_path));
    check(dir.gid === gid, 'its directory carries the media group', `gid=${dir.gid}`);
    check((dir.mode & 0o2000) !== 0, 'its directory is setgid, so future files inherit');
    check((st.mode & 0o040) !== 0, 'the group can read the file');
  } else if (!done.stored_path) {
    check(false, 'stored_path and media group are available');
  } else {
    skip(
      'the filed media carries the media group',
      `MEDIA_GROUP does not resolve on this host, so ownership inheritance cannot be checked`,
    );
  }

  // --- cleanup --------------------------------------------------------------
  if (done.stored_path) {
    await fsp.rm(path.dirname(done.stored_path), { recursive: true, force: true }).catch(() => {});
  }
  await fsp.rm(source, { force: true }).catch(() => {});
  await fsp.rm(staged, { force: true }).catch(() => {});
  await query('DELETE FROM media WHERE user_id = $1', [user.id]);
  await query('DELETE FROM jobs WHERE upload_id = $1', [upload.id]);
  await query('DELETE FROM uploads WHERE user_id = $1', [user.id]);
  await query('DELETE FROM users WHERE id = $1', [user.id]);
  for (const root of [config.storage.moviesRoot, config.storage.tvRoot]) {
    await fsp.rm(path.join(root, user.storage_slug), { recursive: true, force: true }).catch(() => {});
  }

  say();
  say('='.repeat(27));
  const tail = skipped ? ` (${skipped} skipped)` : '';
  if (failures === 0) say(`ALL CHECKS PASSED (${checks})${tail}`);
  else say(`${failures} CHECK(S) FAILED of ${checks}${tail}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    say(`\nFailed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
