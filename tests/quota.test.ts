import './helpers/test-database.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePool, query } from '../src/db/pool.js';
import { uploadsRepo, usersRepo } from '../src/db/repositories.js';
import { storageSlug } from '../src/lib/paths.js';
import { checkQuota, quotaStatus } from '../src/services/quota.js';
import type { UserRow } from '../src/db/types.js';

/**
 * Per-user storage quotas.
 *
 * `quota_bytes` was stored, editable in the dashboard, and enforced nowhere —
 * an administrator could set a limit and reasonably believe it applied. These
 * tests pin the behaviour that makes it real, including the concurrency case
 * that a naive "sum the filed media" check gets wrong.
 */

// This suite owns this chat-id range; see the note in tests/database.test.ts.
const TEST_CHAT_ID = -999_333_000;
const GiB = 1024 ** 3;

let seq = 0;

async function makeUser(quotaBytes: number | null): Promise<UserRow> {
  seq += 1;
  const user = await usersRepo.create({
    name: `Quota ${process.pid}-${seq}`,
    telegram_chat_id: TEST_CHAT_ID - seq,
    jellyfin_username: `quota-${process.pid}-${seq}`,
    jellyfin_user_id: null,
    storage_slug: storageSlug(`quota-${process.pid}-${seq}`),
    quota_bytes: quotaBytes,
  });
  return user;
}

/** Filed media counts against the quota. */
async function addMedia(user: UserRow, bytes: number): Promise<void> {
  await query(
    `INSERT INTO media (user_id, upload_id, title, year, type, path, file_size)
     VALUES ($1, NULL, $2, 2020, 'movie', $3, $4)`,
    [user.id, `Quota Fixture ${seq}`, `/nonexistent/quota-${user.id}-${Math.random()}.mkv`, bytes],
  );
}

/** An accepted-but-unfiled upload also counts, which is what makes it safe. */
async function addInFlight(user: UserRow, bytes: number): Promise<void> {
  await uploadsRepo.createDirect({
    user_id: user.id,
    telegram_chat_id: user.telegram_chat_id,
    original_filename: 'InFlight.mkv',
    safe_filename: 'InFlight.mkv',
    extension: 'mkv',
    file_size: bytes,
    local_source_path: `/nonexistent/inflight-${user.id}-${Math.random()}.mkv`,
  });
}

test.after(async () => {
  await query(`DELETE FROM media WHERE user_id IN (SELECT id FROM users WHERE name LIKE 'Quota %')`);
  await query(`DELETE FROM uploads WHERE user_id IN (SELECT id FROM users WHERE name LIKE 'Quota %')`);
  await query(`DELETE FROM users WHERE name LIKE 'Quota %'`);
  await closePool();
});

test('a user with no quota set is unlimited', async () => {
  const user = await makeUser(null);
  await addMedia(user, 500 * GiB);

  const status = await quotaStatus(user);
  assert.equal(status.quotaBytes, null);
  assert.equal(status.remainingBytes, null, 'unlimited has no remaining figure to report');
  assert.equal(status.percentUsed, null);

  const decision = await checkQuota(user, 100 * GiB);
  assert.equal(decision.ok, true, 'no quota means nothing to exceed');
});

test('an upload that fits is accepted', async () => {
  const user = await makeUser(10 * GiB);
  await addMedia(user, 4 * GiB);

  const decision = await checkQuota(user, 5 * GiB);
  assert.equal(decision.ok, true);
  assert.equal(decision.status.usedBytes, 4 * GiB);
  assert.equal(decision.status.remainingBytes, 6 * GiB);
  assert.equal(Math.round(decision.status.percentUsed ?? 0), 40);
});

test('an upload that would exceed the quota is refused with a useful reason', async () => {
  const user = await makeUser(10 * GiB);
  await addMedia(user, 8 * GiB);

  const decision = await checkQuota(user, 5 * GiB);
  assert.equal(decision.ok, false);
  assert.ok(decision.reason, 'a refusal must explain itself');
  assert.match(decision.reason!, /quota is full/i);
  // The numbers a user needs to act: what they have, what the limit is, and
  // how much they must free.
  assert.match(decision.reason!, /8\.0 GiB/, 'shows what is used');
  assert.match(decision.reason!, /10\.0 GiB/, 'shows the limit');
  assert.match(decision.reason!, /3\.0 GiB/, 'shows the shortfall');
});

test('uploads already in flight are charged against the quota', async () => {
  // The concurrency case: two uploads that each fit on their own must not both
  // be accepted when together they exceed the limit. Counting only filed media
  // would let exactly that through.
  const user = await makeUser(10 * GiB);
  await addMedia(user, 2 * GiB);
  await addInFlight(user, 6 * GiB);

  const status = await quotaStatus(user);
  assert.equal(status.usedBytes, 2 * GiB);
  assert.equal(status.reservedBytes, 6 * GiB, 'the in-flight upload is reserved');
  assert.equal(status.remainingBytes, 2 * GiB);

  const second = await checkQuota(user, 5 * GiB);
  assert.equal(second.ok, false, 'the second concurrent upload is refused');
  assert.match(second.reason!, /in flight/, 'and the reason says why');
});

test('a terminal upload stops being reserved', async () => {
  const user = await makeUser(10 * GiB);
  const upload = await uploadsRepo.createDirect({
    user_id: user.id,
    telegram_chat_id: user.telegram_chat_id,
    original_filename: 'Done.mkv',
    safe_filename: 'Done.mkv',
    extension: 'mkv',
    file_size: 9 * GiB,
    local_source_path: '/nonexistent/done.mkv',
  });

  assert.equal((await quotaStatus(user)).reservedBytes, 9 * GiB);

  // Once it fails, the space it was holding is released again.
  await uploadsRepo.setStatus(upload.id, 'FAILED', { completed_at: new Date() });
  assert.equal((await quotaStatus(user)).reservedBytes, 0, 'a failed upload reserves nothing');
  assert.equal((await checkQuota(user, 8 * GiB)).ok, true);
});

test('a zero or negative quota is treated as unlimited, not as a total block', async () => {
  // Guards the obvious misconfiguration: `quota_bytes = 0` should not silently
  // stop a user uploading anything at all.
  const user = await makeUser(0);
  const decision = await checkQuota(user, 1 * GiB);
  assert.equal(decision.ok, true);
  assert.equal(decision.status.quotaBytes, null);
});

test('an exactly-fitting upload is allowed', async () => {
  const user = await makeUser(10 * GiB);
  await addMedia(user, 6 * GiB);
  assert.equal((await checkQuota(user, 4 * GiB)).ok, true, 'the boundary is inclusive');
  assert.equal((await checkQuota(user, 4 * GiB + 1)).ok, false, 'one byte over is not');
});
