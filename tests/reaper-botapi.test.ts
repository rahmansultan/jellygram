// Imported first, before anything that reads configuration.
//
// `test-database.js` was missing here, and its absence is exactly the failure
// the helper exists to prevent: `reapBotApiData` reads the live upload, session
// and MTProto tables to decide what is still in use, so without the redirect
// this file queried the operator's real database. It never wrote to it, but it
// did make the result depend on what happened to be queued at the time — and
// on a checkout whose main database has no schema yet, which is what
// `npm run test:all` produces, it failed outright with
// `relation "uploads" does not exist`.
import './helpers/test-database.js';
// And this one points a deleter and a directory-creator at
// `config.storage.mediaRoot`, which would otherwise be the operator's real
// film library.
import './helpers/test-media-root.js';
// The reaper's Bot API branch only runs in local mode, which is off by
// default. Without this the whole file skipped itself on a fresh clone — a
// suite that reports "ok … # SKIP" for the only tests covering a deleter is
// worse than one that reports nothing, because it looks like coverage.
import './helpers/local-botapi-mode.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config/index.js';
import { reapBotApiData } from '../src/services/reaper.js';

/**
 * The local Bot API server keeps every file it fetches. Upload 539 aborted
 * after the server had already downloaded 1.8 GiB, and that copy would have
 * stayed on disk forever.
 */

const HOUR = 60 * 60 * 1000;

async function fixture(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'jellygram-botapi-'));
  const bot = path.join(root, '1234567890:AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPPQQR');
  await fsp.mkdir(path.join(bot, 'documents'), { recursive: true });
  await fsp.mkdir(path.join(bot, '.tmp'), { recursive: true });
  return root;
}

test('an uncollected download older than the grace period is removed', async (t) => {
  const root = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const bot = (await fsp.readdir(root))[0]!;
  const stale = path.join(root, bot, 'documents', 'file_0.mkv');
  await fsp.writeFile(stale, 'x'.repeat(1024));

  const result = await reapBotApiData({ dir: root, graceMs: HOUR, now: Date.now() + 4 * HOUR });

  assert.equal(result.removed, 1);
  assert.equal(result.bytes, 1024);
  await assert.rejects(() => fsp.access(stale));
});

test('a download the server is still fetching is never touched', async (t) => {
  const root = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const bot = (await fsp.readdir(root))[0]!;
  const fresh = path.join(root, bot, 'documents', 'file_1.mkv');
  await fsp.writeFile(fresh, 'x');
  // In-progress downloads live under --temp-dir and must be invisible to this.
  const inProgress = path.join(root, bot, '.tmp', 'partial.bin');
  await fsp.writeFile(inProgress, 'x');

  const result = await reapBotApiData({ dir: root, graceMs: 4 * HOUR, now: Date.now() });

  assert.equal(result.removed, 0, 'nothing past the grace period yet');
  await fsp.access(fresh);
  await fsp.access(inProgress);
});

test('the temp directory is skipped even when its contents are old', async (t) => {
  const root = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const bot = (await fsp.readdir(root))[0]!;
  const partial = path.join(root, bot, '.tmp', 'partial.bin');
  await fsp.writeFile(partial, 'x');

  const result = await reapBotApiData({ dir: root, graceMs: HOUR, now: Date.now() + 9 * HOUR });

  assert.equal(result.removed, 0, 'an in-progress download must survive any age');
  await fsp.access(partial);
});

test('it refuses to run against a directory containing the media tree', async (t) => {
  // Pointing it at the media root would put the library itself in scope.
  const result = await reapBotApiData({ dir: config.storage.mediaRoot, graceMs: HOUR });
  assert.equal(result.removed, 0);
  assert.equal(result.failed, 0);
});
