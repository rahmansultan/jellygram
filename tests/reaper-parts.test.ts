// Imported first, before anything that reads configuration: these tests point a
// deleter and a directory-creator at `config.storage.mediaRoot`, and without
// this that root is the owner's real film library.
import './helpers/test-database.js';
import './helpers/test-media-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config/index.js';
import { closePool, query } from '../src/db/pool.js';
import { sessionsRepo, usersRepo } from '../src/db/repositories.js';
import { storageSlug } from '../src/lib/paths.js';
import { reapParts } from '../src/services/reaper.js';
import type { SessionStatus } from '../src/db/types.js';

/**
 * The parts backstop.
 *
 * Assembly already removes a session's parts inline when it completes, is
 * cancelled, or expires. Two cases it cannot cover are what this exists for: a
 * session that failed permanently and was never retried, and a directory whose
 * session row has gone. Everything else — above all a session still collecting
 * or waiting to be retried — must survive untouched.
 */

// This suite owns this chat-id range; see the note in tests/database.test.ts.
const TEST_CHAT_ID = -999_444_000;
const HOUR = 60 * 60 * 1000;

let seq = 0;

async function makeSession(status: SessionStatus): Promise<number> {
  seq += 1;
  const user = await usersRepo.create({
    name: `Parts ${process.pid}-${seq}`,
    telegram_chat_id: TEST_CHAT_ID - seq,
    jellyfin_username: `parts-${process.pid}-${seq}`,
    jellyfin_user_id: null,
    storage_slug: storageSlug(`parts-${process.pid}-${seq}`),
  });
  const session = await sessionsRepo.findOrCreate({
    user_id: user.id,
    telegram_chat_id: user.telegram_chat_id,
    base_filename: 'Parts.Test.2021.mkv',
    safe_base_filename: `Parts.Test.${process.pid}-${seq}.mkv`,
    extension: 'mkv',
    expected_parts: 2,
  });
  if (status !== 'COLLECTING') {
    await sessionsRepo.setStatus(session.id, status, { completed_at: new Date() });
  }
  return session.id;
}

/** A parts directory in an isolated root, so nothing real is ever in scope. */
async function partsRoot(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'jellygram-parts-'));
}

async function makePartsDir(root: string, sessionId: number, bytes = 2 * 1024 * 1024): Promise<string> {
  const dir = path.join(root, `session-${sessionId}`);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'part-0001'), Buffer.alloc(bytes));
  return dir;
}

const exists = (p: string): Promise<boolean> =>
  fsp.access(p).then(
    () => true,
    () => false,
  );

test.after(async () => {
  await query(`DELETE FROM upload_sessions WHERE user_id IN (SELECT id FROM users WHERE name LIKE 'Parts %')`);
  await query(`DELETE FROM users WHERE name LIKE 'Parts %'`);
  await closePool();
});

test('a session still collecting keeps its parts, however old they are', async (t) => {
  const root = await partsRoot();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const id = await makeSession('COLLECTING');
  const dir = await makePartsDir(root, id);

  // Nine days later — well past every retention window.
  const result = await reapParts({ dir: root, graceMs: HOUR, now: Date.now() + 9 * 24 * HOUR });

  assert.equal(result.removed, 0, 'a live session must never lose its parts');
  assert.ok(await exists(dir));
});

test('a retryable failure parks in READY and keeps its parts', async (t) => {
  const root = await partsRoot();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  // A retryable assembly failure sets READY precisely so the parts survive.
  const id = await makeSession('READY');
  const dir = await makePartsDir(root, id);

  const result = await reapParts({ dir: root, graceMs: HOUR, now: Date.now() + 9 * 24 * HOUR });

  assert.equal(result.removed, 0, 'a retryable session must keep its parts for the retry');
  assert.ok(await exists(dir));
});

test('a permanently failed session keeps its parts until the retention window passes', async (t) => {
  const root = await partsRoot();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const id = await makeSession('FAILED');
  const dir = await makePartsDir(root, id);
  const retention = config.multipart.failedRetentionHours * HOUR;

  // Inside the window: the retry affordance is deliberately preserved.
  const early = await reapParts({ dir: root, graceMs: HOUR, now: Date.now() + retention / 2 });
  assert.equal(early.removed, 0, 'a retry must still be possible inside the window');
  assert.ok(await exists(dir));

  // Past it: the parts are no longer worth the disk.
  const late = await reapParts({ dir: root, graceMs: HOUR, now: Date.now() + retention + 2 * HOUR });
  assert.equal(late.removed, 1);
  assert.ok(late.bytes >= 2 * 1024 * 1024, 'the freed bytes are reported');
  assert.equal(await exists(dir), false);
});

test('a directory whose session no longer exists is reaped after the ordinary grace', async (t) => {
  const root = await partsRoot();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  // No row was ever created for this id: exactly the orphans found on disk.
  const dir = await makePartsDir(root, 999_000_001);

  const fresh = await reapParts({ dir: root, graceMs: 4 * HOUR, now: Date.now() });
  assert.equal(fresh.removed, 0, 'still inside the grace period');

  const aged = await reapParts({ dir: root, graceMs: HOUR, now: Date.now() + 5 * HOUR });
  assert.equal(aged.removed, 1);
  assert.equal(await exists(dir), false);
});

test('anything not named session-<digits> is left alone', async (t) => {
  const root = await partsRoot();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const strangers = ['important-data', 'session-', 'session-abc', 'session-12-backup', '.hidden'];
  for (const name of strangers) {
    await fsp.mkdir(path.join(root, name), { recursive: true });
    await fsp.writeFile(path.join(root, name, 'file'), 'x');
  }
  await fsp.writeFile(path.join(root, 'loose-file'), 'x');

  const result = await reapParts({ dir: root, graceMs: HOUR, now: Date.now() + 9 * 24 * HOUR });

  assert.equal(result.removed, 0, 'only directories this system named are ever candidates');
  for (const name of strangers) assert.ok(await exists(path.join(root, name)), name);
  assert.ok(await exists(path.join(root, 'loose-file')));
});

test('a symlink is skipped rather than followed out of the parts root', async (t) => {
  const root = await partsRoot();
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'jellygram-outside-'));
  t.after(() => Promise.all([
    fsp.rm(root, { recursive: true, force: true }),
    fsp.rm(outside, { recursive: true, force: true }),
  ]));

  await fsp.writeFile(path.join(outside, 'precious.mkv'), 'real media');
  // A symlink named like a session directory is the obvious attack shape.
  await fsp.symlink(outside, path.join(root, 'session-999000002'));

  const result = await reapParts({ dir: root, graceMs: HOUR, now: Date.now() + 9 * 24 * HOUR });

  assert.equal(result.removed, 0);
  assert.ok(await exists(path.join(outside, 'precious.mkv')), 'the link target must be untouched');
});

test('it refuses to run against a directory that contains the media library', async () => {
  // A misconfigured parts directory pointing at the media root would put the
  // whole library in scope; the sweep must decline entirely.
  const result = await reapParts({ dir: config.storage.mediaRoot, graceMs: HOUR });
  assert.equal(result.removed, 0);
  assert.equal(result.failed, 0);
});
