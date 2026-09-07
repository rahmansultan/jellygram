// Imported first, before anything that reads configuration: these tests point a
// deleter and a directory-creator at `config.storage.mediaRoot`, and without
// this that root is the owner's real film library.
import './helpers/test-database.js';
import './helpers/test-media-root.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { closePool, query } from '../src/db/pool.js';
import {
  mtprotoJobsRepo,
  sessionsRepo,
  uploadsRepo,
  usersRepo,
} from '../src/db/repositories.js';
import { reapDownloadTmp } from '../src/services/reaper.js';
import { storageSlug } from '../src/lib/paths.js';

/**
 * The staging-directory reaper: what it deletes, and everything it must not.
 *
 * Files are created for real under the media root rather than mocked, because
 * two of the guarantees under test — that a symlink is never followed, and
 * that `Dirent.isFile` is lstat-based — only hold against a real filesystem.
 */

/**
 * Chat ids are the isolation key between test files, which `node --test` runs
 * in parallel against one database. This file owns a bounded range and must
 * never delete outside it; see the note at the top of tests/database.test.ts.
 */
const TEST_CHAT_ID_BASE = -999_555_000;
const TEST_CHAT_ID_FLOOR = -999_555_999;

const GRACE_MS = 60 * 60 * 1000;
/** A clock far enough ahead that every file made during a test is reapable. */
const LATER = () => Date.now() + 10 * GRACE_MS;

let nextChatId = TEST_CHAT_ID_BASE;

before(async () => {
  await runMigrations();
  await cleanup();
});

after(async () => {
  await cleanup();
  await closePool();
});

async function cleanup(): Promise<void> {
  // Uploads, sessions and MTProto jobs all cascade from users.
  await query('DELETE FROM users WHERE telegram_chat_id BETWEEN $1 AND $2', [
    TEST_CHAT_ID_FLOOR,
    TEST_CHAT_ID_BASE,
  ]);
}

async function makeUser(suffix: string) {
  nextChatId -= 1;
  assert.ok(nextChatId >= TEST_CHAT_ID_FLOOR, 'ran out of reserved chat ids');
  const unique = `reap-${suffix}-${process.pid}-${Date.now()}`;
  return usersRepo.create({
    name: `Reaper ${suffix}`,
    telegram_chat_id: nextChatId,
    jellyfin_username: unique,
    jellyfin_user_id: null,
    storage_slug: storageSlug(unique),
  });
}

/** A scratch staging directory under the real media root. */
async function scratchDir(label: string, t: { after: (fn: () => unknown) => void }) {
  const dir = path.join(
    config.storage.mediaRoot,
    `.test-reaper-${label}-${process.pid}-${Date.now()}`,
  );
  await fsp.mkdir(dir, { recursive: true });
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeFile(dir: string, name: string, contents = 'payload'): Promise<string> {
  const full = path.join(dir, name);
  await fsp.writeFile(full, contents);
  return full;
}

async function present(target: string): Promise<boolean> {
  try {
    await fsp.lstat(target);
    return true;
  } catch {
    return false;
  }
}

test('removes orphaned files and reports the count and bytes freed', async (t) => {
  const dir = await scratchDir('orphans', t);
  const a = await writeFile(dir, '12-1700000000000-movie.mkv', 'x'.repeat(100));
  const b = await writeFile(dir, 'direct-3-1700000000000-other.mp4', 'y'.repeat(50));

  const result = await reapDownloadTmp({ dir, graceMs: GRACE_MS, now: LATER() });

  assert.equal(result.removed, 2);
  assert.equal(result.bytes, 150);
  assert.equal(result.failed, 0);
  assert.equal(await present(a), false);
  assert.equal(await present(b), false);
});

test('keeps a file that has not yet outlived the grace period', async (t) => {
  const dir = await scratchDir('grace', t);
  // Written just now, so an in-flight download looks exactly like this.
  const fresh = await writeFile(dir, '99-1700000000000-in-flight.mkv');

  const result = await reapDownloadTmp({ dir, graceMs: GRACE_MS });

  assert.equal(result.removed, 0);
  assert.equal(result.kept, 1);
  assert.equal(await present(fresh), true);
});

test('keeps a file a non-terminal upload still points at', async (t) => {
  const dir = await scratchDir('upload-live', t);
  const user = await makeUser('live');
  const live = await writeFile(dir, 'direct-live.mkv');

  await uploadsRepo.createDirect({
    user_id: user.id,
    telegram_chat_id: user.telegram_chat_id,
    original_filename: 'live.mkv',
    safe_filename: 'live.mkv',
    extension: 'mkv',
    file_size: 7,
    local_source_path: live,
  });

  const result = await reapDownloadTmp({ dir, graceMs: GRACE_MS, now: LATER() });

  assert.equal(result.removed, 0);
  assert.equal(await present(live), true);
});

test('removes a file once the upload that owned it reaches a terminal status', async (t) => {
  const dir = await scratchDir('upload-done', t);
  const user = await makeUser('done');
  const orphan = await writeFile(dir, 'direct-done.mkv');

  const upload = await uploadsRepo.createDirect({
    user_id: user.id,
    telegram_chat_id: user.telegram_chat_id,
    original_filename: 'done.mkv',
    safe_filename: 'done.mkv',
    extension: 'mkv',
    file_size: 7,
    local_source_path: orphan,
  });

  // A cancelled upload keeps its local_source_path, so the status is the only
  // thing separating this from the test above.
  await uploadsRepo.setStatus(upload.id, 'CANCELLED');

  const result = await reapDownloadTmp({ dir, graceMs: GRACE_MS, now: LATER() });

  assert.equal(result.removed, 1);
  assert.equal(await present(orphan), false);
});

test('keeps the assembled output of an active multi-part session', async (t) => {
  const dir = await scratchDir('session', t);
  const user = await makeUser('session');
  const assembled = await writeFile(dir, 'assembled-1-1700000000000-film.mkv');
  const abandoned = await writeFile(dir, 'assembled-2-1700000000000-old.mkv');

  const live = await sessionsRepo.findOrCreate({
    user_id: user.id,
    telegram_chat_id: user.telegram_chat_id,
    base_filename: 'film.mkv',
    safe_base_filename: `film-${process.pid}.mkv`,
    extension: 'mkv',
    expected_parts: 2,
  });
  await sessionsRepo.patch(live.id, { assembled_path: assembled });
  await sessionsRepo.setStatus(live.id, 'HANDOFF');

  const dead = await sessionsRepo.findOrCreate({
    user_id: user.id,
    telegram_chat_id: user.telegram_chat_id,
    base_filename: 'old.mkv',
    safe_base_filename: `old-${process.pid}.mkv`,
    extension: 'mkv',
    expected_parts: 2,
  });
  await sessionsRepo.patch(dead.id, { assembled_path: abandoned });
  await sessionsRepo.setStatus(dead.id, 'FAILED');

  const result = await reapDownloadTmp({ dir, graceMs: GRACE_MS, now: LATER() });

  assert.equal(result.removed, 1);
  assert.equal(await present(assembled), true, 'the live session still needs its output');
  assert.equal(await present(abandoned), false, 'the failed session does not');
});

test('keeps the temp file of an active MTProto job', async (t) => {
  const dir = await scratchDir('mtproto', t);
  const user = await makeUser('mtproto');
  const temp = await writeFile(dir, 'mtproto-1-1700000000000-show.mkv');

  const job = await mtprotoJobsRepo.create({
    user_id: user.id,
    telegram_chat_id: user.telegram_chat_id,
    bot_message_id: 1,
    progress_message_id: null,
    origin_kind: 'channel',
    origin_chat: 'somewhere',
    origin_message_id: 1,
    origin_title: null,
    file_name: 'show.mkv',
    file_size: 7,
    mime_type: 'video/x-matroska',
    telegram_file_unique_id: null,
    caption: null,
  });
  await mtprotoJobsRepo.patch(job.id, { temp_path: temp });
  await mtprotoJobsRepo.setStatus(job.id, 'VERIFYING');

  let result = await reapDownloadTmp({ dir, graceMs: GRACE_MS, now: LATER() });
  assert.equal(result.removed, 0);
  assert.equal(await present(temp), true);

  // Once the job gives up, nothing owns the file any more.
  await mtprotoJobsRepo.setStatus(job.id, 'FAILED');
  result = await reapDownloadTmp({ dir, graceMs: GRACE_MS, now: LATER() });
  assert.equal(result.removed, 1);
  assert.equal(await present(temp), false);
});

test('never deletes or follows a symlink, and never recurses', async (t) => {
  const dir = await scratchDir('symlink', t);

  // The target sits outside the staging directory: following the link and
  // unlinking through it would destroy a file the reaper has no claim on.
  const outside = await scratchDir('symlink-target', t);
  const target = await writeFile(outside, 'precious.mkv');
  await fsp.symlink(target, path.join(dir, 'looks-like-an-orphan.mkv'));

  // A directory below the staging directory is nobody's scratch file either.
  const subdir = path.join(dir, 'nested');
  await fsp.mkdir(subdir);
  const buried = await writeFile(subdir, 'buried.mkv');

  const result = await reapDownloadTmp({ dir, graceMs: GRACE_MS, now: LATER() });

  assert.equal(result.removed, 0);
  assert.equal(result.kept, 2, 'the symlink and the directory were both examined and skipped');
  assert.equal(await present(target), true, 'the symlink target survives');
  assert.equal(await present(path.join(dir, 'looks-like-an-orphan.mkv')), true);
  assert.equal(await present(buried), true, 'the reaper does not recurse');
});

test('refuses to reap a directory that contains quarantine or the library', async () => {
  // The misconfiguration this guards against is DOWNLOAD_TMP_DIR=MEDIA_ROOT,
  // which would otherwise put the whole library in reach.
  const result = await reapDownloadTmp({
    dir: config.storage.mediaRoot,
    graceMs: GRACE_MS,
    now: LATER(),
  });

  assert.deepEqual(result, { removed: 0, bytes: 0, kept: 0, failed: 0 });
});

test('a missing staging directory is not an error', async () => {
  const result = await reapDownloadTmp({
    dir: path.join(config.storage.mediaRoot, `.test-reaper-absent-${process.pid}-${Date.now()}`),
    graceMs: GRACE_MS,
    now: LATER(),
  });

  assert.equal(result.removed, 0);
  assert.equal(result.failed, 0);
});
