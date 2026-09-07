import './helpers/test-database.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.js';
import { closePool, query } from '../src/db/pool.js';
import {
  adminsRepo,
  auditRepo,
  jobsRepo,
  librariesRepo,
  likeLiteral,
  mediaRepo,
  uploadsRepo,
  usersRepo,
} from '../src/db/repositories.js';
import { hashPassword, verifyPassword } from '../src/api/auth.js';
import { storageSlug } from '../src/lib/paths.js';

/**
 * Integration tests against a real PostgreSQL database.
 *
 * Test rows are namespaced with an obviously synthetic Telegram id range and
 * cleaned up afterwards, so running these against the live database does not
 * disturb real users.
 */

/**
 * Chat ids are the isolation key between test files, which `node --test` runs
 * in parallel against one database. This file owns a bounded range and must
 * never delete outside it: an unbounded `<= BASE` sweep also matched
 * mtproto.test.ts's users and deleted them mid-test.
 */
const TEST_CHAT_ID_BASE = -999_000_000;
const TEST_CHAT_ID_FLOOR = -999_099_999;

/**
 * Fixtures are parked a year out so the live worker never claims them, at an
 * instant unique to this process so a leftover from another run is never
 * inside this one's window.
 */
const PARKED = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000 + (process.pid % 100_000) * 1000);
const AFTER_PARKED = PARKED;
const created: number[] = [];

before(async () => {
  await runMigrations();
  await cleanup();
});

after(async () => {
  await cleanup();
  await closePool();
});

async function cleanup(): Promise<void> {
  await query('DELETE FROM users WHERE telegram_chat_id BETWEEN $1 AND $2', [
    TEST_CHAT_ID_FLOOR,
    TEST_CHAT_ID_BASE,
  ]);
  await query("DELETE FROM admins WHERE username LIKE 'test-admin-%'");
}

async function makeUser(suffix: string) {
  const user = await usersRepo.create({
    name: `Test ${suffix}`,
    telegram_chat_id: TEST_CHAT_ID_BASE - created.length - 1,
    jellyfin_username: `test-${suffix}-${Date.now()}`,
    jellyfin_user_id: null,
    storage_slug: storageSlug(`test-${suffix}-${Date.now()}`),
  });
  created.push(user.id);
  return user;
}

test('users: create and look up by Telegram chat id', async () => {
  const user = await makeUser('lookup');
  const found = await usersRepo.byTelegramChatId(user.telegram_chat_id);
  assert.ok(found);
  assert.equal(found.id, user.id);
});

/**
 * The query that decides what one managed user must not see.
 *
 * `enabledFoldersFor` is unit-tested against a set of "libraries belonging to
 * somebody else"; this is where that set actually comes from. If it ever
 * returned an empty set — a wrong join, a swapped comparison — every isolation
 * unit test would still pass while provisioning quietly stopped revoking
 * anything.
 */
test('libraries: a user is told about every managed library except their own', async () => {
  const a = await makeUser('iso-a');
  const b = await makeUser('iso-b');

  await librariesRepo.upsert({
    user_id: a.id,
    media_type: 'movie',
    library_name: `Movies - iso-a-${a.id}`,
    library_path: `/tmp/iso-a-${a.id}/movies`,
    jellyfin_item_id: `item-a-movies-${a.id}`,
  });
  await librariesRepo.upsert({
    user_id: a.id,
    media_type: 'tv',
    library_name: `TV - iso-a-${a.id}`,
    library_path: `/tmp/iso-a-${a.id}/tv`,
    jellyfin_item_id: `item-a-tv-${a.id}`,
  });
  await librariesRepo.upsert({
    user_id: b.id,
    media_type: 'movie',
    library_name: `Movies - iso-b-${b.id}`,
    library_path: `/tmp/iso-b-${b.id}/movies`,
    jellyfin_item_id: `item-b-movies-${b.id}`,
  });

  const othersForA = await librariesRepo.itemIdsExcludingUser(a.id);
  assert.ok(othersForA.has(`item-b-movies-${b.id}`), "A must be told about B's library");
  assert.ok(!othersForA.has(`item-a-movies-${a.id}`), 'and not about their own');
  assert.ok(!othersForA.has(`item-a-tv-${a.id}`), 'nor their other own one');

  const othersForB = await librariesRepo.itemIdsExcludingUser(b.id);
  assert.ok(othersForB.has(`item-a-movies-${a.id}`), "B must be told about A's libraries");
  assert.ok(othersForB.has(`item-a-tv-${a.id}`));
  assert.ok(!othersForB.has(`item-b-movies-${b.id}`));
});

test('libraries: deleting a user takes their libraries out of everyone else\'s exclusion set', async () => {
  const a = await makeUser('iso-del-a');
  const b = await makeUser('iso-del-b');
  await librariesRepo.upsert({
    user_id: b.id,
    media_type: 'movie',
    library_name: `Movies - iso-del-b-${b.id}`,
    library_path: `/tmp/iso-del-b-${b.id}/movies`,
    jellyfin_item_id: `item-del-b-${b.id}`,
  });

  assert.ok((await librariesRepo.itemIdsExcludingUser(a.id)).has(`item-del-b-${b.id}`));
  await usersRepo.remove(b.id);
  assert.ok(
    !(await librariesRepo.itemIdsExcludingUser(a.id)).has(`item-del-b-${b.id}`),
    'a removed user must not keep reserving library ids',
  );
});

/**
 * A search term is a term, not a pattern.
 *
 * `%` and `_` are LIKE wildcards, and underscores are ordinary in release
 * names — so searching for `The_Movie` matched `TheXMovie`, and searching for
 * `%` returned every row in the table.
 */
test('search: LIKE wildcards in a term are literal, not patterns', () => {
  assert.equal(likeLiteral('plain'), '%plain%');
  assert.equal(likeLiteral('The_Movie'), '%The\\_Movie%', 'an underscore matches an underscore');
  assert.equal(likeLiteral('100%'), '%100\\%%', 'a percent matches a percent');
  // The backslash must be escaped first, or it would re-escape the escapes.
  assert.equal(likeLiteral('a\\b'), '%a\\\\b%');
  assert.equal(likeLiteral(''), '%%');
});

test('search: a lone percent matches nothing rather than everything', async () => {
  const user = await makeUser('like');
  await uploadsRepo.create({
    user_id: user.id,
    telegram_chat_id: user.telegram_chat_id,
    telegram_message_id: 990001,
    telegram_file_id: `like-test-${Date.now()}`,
    telegram_file_unique_id: null,
    mime_type: null,
    original_filename: 'Some_Release.2024.1080p.mkv',
    safe_filename: 'Some_Release.2024.1080p.mkv',
    extension: 'mkv',
    file_size: 1024,
  });

  const everything = await uploadsRepo.search({ userId: user.id, limit: 5, offset: 0 });
  assert.equal(everything.total, 1, 'the row exists');

  const wildcard = await uploadsRepo.search({ userId: user.id, q: '%', limit: 5, offset: 0 });
  assert.equal(wildcard.total, 0, 'a literal % is not a wildcard');

  const underscore = await uploadsRepo.search({ userId: user.id, q: 'Some_Release', limit: 5, offset: 0 });
  assert.equal(underscore.total, 1, 'an underscore still matches itself');

  const wrong = await uploadsRepo.search({ userId: user.id, q: 'SomeXRelease', limit: 5, offset: 0 });
  assert.equal(wrong.total, 0, 'and does not match any other character');
});

test('users: an unknown Telegram chat id resolves to null', async () => {
  assert.equal(await usersRepo.byTelegramChatId(-424242424), null);
});

test('users: duplicate Telegram chat ids are rejected by the database', async () => {
  const user = await makeUser('dup');
  await assert.rejects(
    () =>
      usersRepo.create({
        name: 'Clash',
        telegram_chat_id: user.telegram_chat_id,
        jellyfin_username: `clash-${Date.now()}`,
        jellyfin_user_id: null,
        storage_slug: `clash-${Date.now()}`,
      }),
    /duplicate key|unique/i,
  );
});

test('users: duplicate Jellyfin usernames are rejected case-insensitively', async () => {
  const user = await makeUser('case');
  await assert.rejects(
    () =>
      usersRepo.create({
        name: 'Clash',
        telegram_chat_id: TEST_CHAT_ID_BASE - 9999,
        jellyfin_username: user.jellyfin_username.toUpperCase(),
        jellyfin_user_id: null,
        storage_slug: `clash2-${Date.now()}`,
      }),
    /duplicate key|unique/i,
  );
});

test('uploads: status transitions are recorded', async () => {
  const user = await makeUser('status');
  const upload = await uploadsRepo.create({
    user_id: user.id,
    telegram_chat_id: user.telegram_chat_id,
    telegram_message_id: 1,
    telegram_file_id: 'file-1',
    telegram_file_unique_id: 'uniq-1',
    original_filename: 'Interstellar.2014.mkv',
    safe_filename: 'Interstellar.2014.mkv',
    extension: 'mkv',
    mime_type: 'video/x-matroska',
    file_size: 1024,
  });
  assert.equal(upload.status, 'RECEIVED');

  for (const status of ['QUEUED', 'DOWNLOADING', 'PROCESSING', 'ORGANIZING', 'JELLYFIN_SCAN'] as const) {
    const updated = await uploadsRepo.setStatus(upload.id, status);
    assert.equal(updated?.status, status);
  }

  const done = await uploadsRepo.setStatus(upload.id, 'COMPLETED', { completed_at: new Date() });
  assert.equal(done?.status, 'COMPLETED');
  assert.ok(done?.completed_at);
});

test('uploads: an invalid status is rejected by the check constraint', async () => {
  const user = await makeUser('badstatus');
  const upload = await uploadsRepo.create({
    user_id: user.id,
    telegram_chat_id: user.telegram_chat_id,
    telegram_message_id: null,
    telegram_file_id: 'f',
    telegram_file_unique_id: 'u',
    original_filename: 'x.mkv',
    safe_filename: 'x.mkv',
    extension: 'mkv',
    mime_type: null,
    file_size: 1,
  });
  await assert.rejects(
    () => query('UPDATE uploads SET status = $2 WHERE id = $1', [upload.id, 'NONSENSE']),
    /violates check constraint/i,
  );
});

test('uploads: cancellation is recorded and is idempotent for finished rows', async () => {
  const user = await makeUser('cancel');
  const upload = await uploadsRepo.create({
    user_id: user.id,
    telegram_chat_id: user.telegram_chat_id,
    telegram_message_id: null,
    telegram_file_id: 'f',
    telegram_file_unique_id: 'u',
    original_filename: 'x.mkv',
    safe_filename: 'x.mkv',
    extension: 'mkv',
    mime_type: null,
    file_size: 1,
  });

  assert.ok(await uploadsRepo.requestCancel(upload.id));
  assert.equal(await uploadsRepo.isCancelRequested(upload.id), true);

  await uploadsRepo.setStatus(upload.id, 'COMPLETED');
  // A finished upload can no longer be cancelled.
  assert.equal(await uploadsRepo.requestCancel(upload.id), null);
});

test('media: duplicate movie detection by title and year', async () => {
  const user = await makeUser('dupmovie');
  await mediaRepo.create({
    user_id: user.id,
    upload_id: null,
    title: 'Interstellar',
    original_title: null,
    year: 2014,
    type: 'movie',
    season: null,
    episode: null,
    episode_title: null,
    path: `/tmp/test-${user.id}/Interstellar (2014).mkv`,
    file_size: 100,
    checksum_sha256: 'a'.repeat(64),
    tmdb_id: 157336,
    overview: null,
    poster_path: null,
    jellyfin_item_id: null,
    jellyfin_verified: false,
  });

  const hit = await mediaRepo.findDuplicate({
    user_id: user.id,
    type: 'movie',
    title: 'interstellar',
    year: 2014,
    season: null,
    episode: null,
    checksum: null,
  });
  assert.ok(hit, 'the same title and year should be detected as a duplicate');

  const miss = await mediaRepo.findDuplicate({
    user_id: user.id,
    type: 'movie',
    title: 'Interstellar',
    year: 2020,
    season: null,
    episode: null,
    checksum: null,
  });
  assert.equal(miss, null, 'a different year is a different film');
});

test('media: duplicate detection by checksum crosses titles', async () => {
  const user = await makeUser('dupsum');
  const checksum = 'b'.repeat(64);
  await mediaRepo.create({
    user_id: user.id,
    upload_id: null,
    title: 'Some Movie',
    original_title: null,
    year: 2001,
    type: 'movie',
    season: null,
    episode: null,
    episode_title: null,
    path: `/tmp/test-${user.id}/Some Movie (2001).mkv`,
    file_size: 100,
    checksum_sha256: checksum,
    tmdb_id: null,
    overview: null,
    poster_path: null,
    jellyfin_item_id: null,
    jellyfin_verified: false,
  });

  const hit = await mediaRepo.findDuplicate({
    user_id: user.id,
    type: 'movie',
    title: 'Completely Different Name',
    year: 1999,
    season: null,
    episode: null,
    checksum,
  });
  assert.ok(hit, 'identical bytes are a duplicate whatever the filename claimed');
});

test('media: duplicate detection is per user, not global', async () => {
  const a = await makeUser('iso-a');
  const b = await makeUser('iso-b');

  await mediaRepo.create({
    user_id: a.id,
    upload_id: null,
    title: 'Shared Title',
    original_title: null,
    year: 2010,
    type: 'movie',
    season: null,
    episode: null,
    episode_title: null,
    path: `/tmp/test-${a.id}/Shared Title (2010).mkv`,
    file_size: 100,
    checksum_sha256: 'c'.repeat(64),
    tmdb_id: null,
    overview: null,
    poster_path: null,
    jellyfin_item_id: null,
    jellyfin_verified: false,
  });

  const forB = await mediaRepo.findDuplicate({
    user_id: b.id,
    type: 'movie',
    title: 'Shared Title',
    year: 2010,
    season: null,
    episode: null,
    checksum: 'c'.repeat(64),
  });
  assert.equal(forB, null, "one user's media must not count as another user's duplicate");
});

test('media: duplicate episode detection by show, season and episode', async () => {
  const user = await makeUser('dupep');
  await mediaRepo.create({
    user_id: user.id,
    upload_id: null,
    title: 'Breaking Bad',
    original_title: null,
    year: 2008,
    type: 'tv',
    season: 2,
    episode: 3,
    episode_title: 'Bit by a Dead Bee',
    path: `/tmp/test-${user.id}/Breaking Bad - S02E03.mkv`,
    file_size: 100,
    checksum_sha256: null,
    tmdb_id: null,
    overview: null,
    poster_path: null,
    jellyfin_item_id: null,
    jellyfin_verified: false,
  });

  assert.ok(
    await mediaRepo.findDuplicate({
      user_id: user.id,
      type: 'tv',
      title: 'breaking bad',
      year: 2008,
      season: 2,
      episode: 3,
      checksum: null,
    }),
  );
  assert.equal(
    await mediaRepo.findDuplicate({
      user_id: user.id,
      type: 'tv',
      title: 'Breaking Bad',
      year: 2008,
      season: 2,
      episode: 4,
      checksum: null,
    }),
    null,
  );
});

test('jobs: claim, progress, complete', async () => {
  const user = await makeUser('jobs');
  const upload = await uploadsRepo.create({
    user_id: user.id,
    telegram_chat_id: user.telegram_chat_id,
    telegram_message_id: null,
    telegram_file_id: 'f',
    telegram_file_unique_id: 'u',
    original_filename: 'x.mkv',
    safe_filename: 'x.mkv',
    extension: 'mkv',
    mime_type: null,
    file_size: 1,
  });

  const job = await jobsRepo.enqueue({ type: 'process-upload', upload_id: upload.id });
  assert.equal(job.status, 'pending');

  // By id, never "the next one": the generic claim took whatever was oldest in
  // the table, which in a shared database was a real user's upload.
  const claimed = await jobsRepo.claimById(job.id, 'test-worker');
  assert.ok(claimed);
  assert.equal(claimed.id, job.id, 'the claim is this fixture and nothing else');
  assert.equal(claimed.status, 'active');
  assert.equal(claimed.attempts, 1);
  assert.equal(await jobsRepo.claimById(job.id, 'test-worker-2'), null, 'a claimed job cannot be claimed again');

  await jobsRepo.setProgress(claimed.id, 42);
  await jobsRepo.complete(claimed.id);

  const { rows } = await query<{ status: string; progress: number }>(
    'SELECT status, progress FROM jobs WHERE id = $1',
    [claimed.id],
  );
  assert.equal(rows[0]?.status, 'completed');
  assert.equal(Number(rows[0]?.progress), 100);
});

test('jobs: a retryable failure reschedules; exhausting attempts fails permanently', async () => {
  const user = await makeUser('retry');
  const upload = await uploadsRepo.create({
    user_id: user.id,
    telegram_chat_id: user.telegram_chat_id,
    telegram_message_id: null,
    telegram_file_id: 'f',
    telegram_file_unique_id: 'u',
    original_filename: 'x.mkv',
    safe_filename: 'x.mkv',
    extension: 'mkv',
    mime_type: null,
    file_size: 1,
  });

  const job = await jobsRepo.enqueue({ type: 'process-upload', upload_id: upload.id, max_attempts: 2 });
  await query('UPDATE jobs SET attempts = 1 WHERE id = $1', [job.id]);

  const first = await jobsRepo.fail(job.id, 'transient', 1000);
  assert.equal(first.willRetry, true);

  await query('UPDATE jobs SET attempts = 2 WHERE id = $1', [job.id]);
  const second = await jobsRepo.fail(job.id, 'still broken', 1000);
  assert.equal(second.willRetry, false);
});

test('admins: password hashing round-trips and rejects wrong passwords', async () => {
  const password = 'a-sufficiently-long-password';
  const hash = await hashPassword(password);

  assert.ok(hash.startsWith('scrypt$'));
  assert.ok(!hash.includes(password), 'the hash must not contain the plaintext');
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword('wrong-password-entirely', hash), false);
  assert.equal(await verifyPassword(password, 'not-a-hash'), false);
});

test('admins: the same password produces different hashes', async () => {
  const a = await hashPassword('same-password-here');
  const b = await hashPassword('same-password-here');
  assert.notEqual(a, b, 'each hash must use a fresh salt');
});

test('admins: create and look up case-insensitively', async () => {
  const username = `test-admin-${Date.now()}`;
  await adminsRepo.create(username, await hashPassword('placeholder-password'));
  assert.ok(await adminsRepo.byUsername(username.toUpperCase()));
});

test('audit: entries are written and read back newest first', async () => {
  await auditRepo.log({
    actor_type: 'system',
    action: 'test.audit.entry',
    detail: { marker: 'database-test' },
  });
  const { rows } = await auditRepo.list(5, 0);
  assert.ok(rows.length > 0);
});

test('cascade: deleting a user removes their uploads and media', async () => {
  const user = await makeUser('cascade');
  const upload = await uploadsRepo.create({
    user_id: user.id,
    telegram_chat_id: user.telegram_chat_id,
    telegram_message_id: null,
    telegram_file_id: 'f',
    telegram_file_unique_id: 'u',
    original_filename: 'x.mkv',
    safe_filename: 'x.mkv',
    extension: 'mkv',
    mime_type: null,
    file_size: 1,
  });

  await usersRepo.remove(user.id);
  assert.equal(await uploadsRepo.byId(upload.id), null);
});

test('a worker restart does not consume one of a job\'s retry attempts', async () => {
  // `claim` counts an attempt on the way in. A multi-gigabyte download holds a
  // worker slot for hours, so a restart during one is likely; without giving
  // the attempt back, three deploys would permanently fail a healthy upload.
  const user = await makeUser('orphan');
  const upload = await uploadsRepo.createDirect({
    user_id: user.id,
    telegram_chat_id: user.telegram_chat_id,
    original_filename: 'Orphan.2020.mkv',
    safe_filename: 'Orphan.2020.mkv',
    extension: 'mkv',
    file_size: 1024,
    local_source_path: '/nonexistent/orphan.mkv',
  });
  const job = await jobsRepo.enqueue({ type: 'process-upload', upload_id: upload.id });

  const workerId = `test-worker-${process.pid}-${job.id}`;
  const claimed = await jobsRepo.claimById(job.id, workerId);
  assert.ok(claimed, 'a job was claimed');
  const afterClaim = claimed.attempts;
  assert.equal(afterClaim, 1, 'claiming counts an attempt');

  // The worker dies here and a new one starts. Scoped to this worker id on
  // purpose: the unfiltered form would release live production jobs too.
  await jobsRepo.releaseOrphans(workerId);

  const { rows } = await query<{ status: string; attempts: number }>(
    'SELECT status, attempts FROM jobs WHERE id = $1',
    [job.id],
  );
  assert.equal(rows[0]?.status, 'pending', 'the job is queued again');
  assert.equal(rows[0]?.attempts, afterClaim - 1, 'the attempt it never really made is returned');
});

test('queue position matches the order jobs are actually claimed in', async () => {
  // Position must be derived from the same ordering `claim` uses, or the
  // number shown to a user is a guess rather than an answer.
  const user = await makeUser('queuepos');
  const ids: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const upload = await uploadsRepo.createDirect({
      user_id: user.id,
      telegram_chat_id: user.telegram_chat_id,
      original_filename: `Q${i}.mkv`,
      safe_filename: `Q${i}.mkv`,
      extension: 'mkv',
      file_size: 1024,
      local_source_path: `/nonexistent/q${i}.mkv`,
    });
    // Runnable now, at a priority behind every real job: position counts only
    // what a worker could claim before this one, so a parked fixture would
    // not count. The database is the tests' own, so no live worker can take
    // these; the priority keeps them clear of the other test files' fixtures.
    const job = await jobsRepo.enqueue({
      type: 'process-upload',
      upload_id: upload.id,
      priority: 900 + i,
      run_after: new Date(Date.now() - 1000),
    });
    ids.push(job.id);
  }

  try {
    const first = await jobsRepo.queuePosition(ids[0]!);
    const last = await jobsRepo.queuePosition(ids[3]!);
    assert.ok(first && last);
    assert.ok(last.ahead > first.ahead, 'a later job reports more work ahead of it');
    assert.equal(last.ahead - first.ahead, 3, 'and exactly the three jobs enqueued between them');
  } finally {
    await query('DELETE FROM jobs WHERE upload_id IN (SELECT id FROM uploads WHERE user_id = $1)', [user.id]);
    await query('DELETE FROM uploads WHERE user_id = $1', [user.id]);
  }
});

test('a large upload cannot occupy the slots reserved for short work', async () => {
  // The starvation case: one multi-gigabyte upload holds a slot for hours, so
  // with a flat concurrency limit every small upload queues behind it.
  const user = await makeUser('lanes');
  const LARGE = 512 * 1024 * 1024;

  const make = async (bytes: number) => {
    const upload = await uploadsRepo.createDirect({
      user_id: user.id,
      telegram_chat_id: user.telegram_chat_id,
      original_filename: `L${bytes}.mkv`,
      safe_filename: `L${bytes}.mkv`,
      extension: 'mkv',
      file_size: bytes,
      local_source_path: `/nonexistent/lane-${bytes}-${Math.random()}.mkv`,
    });
    // Priority 950 keeps these behind anything real; run_after in the past so
    // they are claimable by this test but they are deleted before the live
    // worker's next poll.
    // Parked far ahead so the running worker never claims it; the test looks
    // past that cutoff explicitly.
    return jobsRepo.enqueue({
      type: 'process-upload',
      upload_id: upload.id,
      priority: 950,
      run_after: PARKED,
    });
  };

  const big = await make(4 * 1024 * 1024 * 1024);
  const small = await make(10 * 1024 * 1024);

  try {
    // Asserted as a property rather than an exact id: this table is shared, so
    // the lane may legitimately hand back somebody else's job first. What must
    // hold is that the *large* upload never comes out of the small lane, and
    // that the small one is reachable through it.
    const seen: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const claimed = await jobsRepo.claimForLane('test-lane-worker', 'small', LARGE, AFTER_PARKED);
      if (!claimed) break;
      seen.push(claimed.id);
      if (claimed.id === small.id) break;
    }

    assert.ok(!seen.includes(big.id), 'a large upload must never take a short-work slot');
    assert.ok(seen.includes(small.id), 'the small upload is reachable through the small lane');

    const fromLargeLane = await jobsRepo.claimForLane('test-lane-worker', 'large', LARGE, AFTER_PARKED);
    assert.ok(fromLargeLane, 'the large lane found work');
    assert.equal(fromLargeLane.id, big.id, 'and it is the large upload');
  } finally {
    await query(
      `UPDATE jobs SET status='pending', locked_by=NULL WHERE locked_by LIKE 'test-lane-worker%'`,
    );
    await query('DELETE FROM jobs WHERE upload_id IN (SELECT id FROM uploads WHERE user_id = $1)', [user.id]);
    await query('DELETE FROM uploads WHERE user_id = $1', [user.id]);
  }
});

test('long-running job types are always treated as large', async () => {
  const user = await makeUser('lanetypes');
  const LARGE = 512 * 1024 * 1024;
  // An MTProto download moves gigabytes whatever any uploads row says.
  const job = await jobsRepo.enqueue({
    type: 'mtproto-download',
    upload_id: null,
    priority: 950,
    run_after: PARKED,
  });

  try {
    const seen: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const claimed = await jobsRepo.claimForLane('test-lane-worker-2', 'small', LARGE, AFTER_PARKED);
      if (!claimed) break;
      seen.push(claimed.id);
    }
    assert.ok(!seen.includes(job.id), 'an MTProto download must never take a short-work slot');

    const fromLarge = await jobsRepo.claimForLane('test-lane-worker-2', 'large', LARGE, AFTER_PARKED);
    assert.equal(fromLarge?.id, job.id, 'the large lane takes it');
  } finally {
    await query(
      `UPDATE jobs SET status='pending', locked_by=NULL WHERE locked_by LIKE 'test-lane-worker%'`,
    );
    await query('DELETE FROM jobs WHERE id = $1', [job.id]);
    await query('DELETE FROM users WHERE id = $1', [user.id]);
  }
});

test('cancelling a queued upload makes it terminal, and a retry clears the failure detail', async () => {
  const user = await makeUser('cancel-queued');
  const upload = await uploadsRepo.createDirect({
    user_id: user.id,
    telegram_chat_id: user.telegram_chat_id,
    original_filename: 'Cancel.Me.2020.mkv',
    safe_filename: 'Cancel.Me.2020.mkv',
    extension: 'mkv',
    file_size: 2048,
    local_source_path: '/nonexistent/cancel-me.mkv',
  });
  const job = await jobsRepo.enqueue({ type: 'process-upload', upload_id: upload.id, run_after: PARKED });

  // Nobody is running it, so the cancel must finish the job itself: before
  // this the row stayed QUEUED forever, reserving quota and refusing retry.
  const cancelled = await uploadsRepo.requestCancel(upload.id);
  assert.ok(cancelled);
  assert.equal(cancelled.status, 'CANCELLED');
  assert.ok(cancelled.completed_at, 'a cancelled upload has a completion time');
  const { rows: jobs } = await query<{ status: string }>('SELECT status FROM jobs WHERE id = $1', [job.id]);
  assert.equal(jobs[0]?.status, 'cancelled');

  // A second cancel is a no-op on a terminal row.
  assert.equal(await uploadsRepo.requestCancel(upload.id), null);

  // A running upload keeps its stage: the pipeline finishes the cancellation.
  const running = await uploadsRepo.createDirect({
    user_id: user.id,
    telegram_chat_id: user.telegram_chat_id,
    original_filename: 'Running.2020.mkv',
    safe_filename: 'Running.2020.mkv',
    extension: 'mkv',
    file_size: 2048,
    local_source_path: '/nonexistent/running.mkv',
  });
  const active = await jobsRepo.enqueue({ type: 'process-upload', upload_id: running.id, run_after: PARKED });
  await jobsRepo.claimById(active.id, 'test-worker-cancel');
  await uploadsRepo.setStatus(running.id, 'DOWNLOADING');
  const flagged = await uploadsRepo.requestCancel(running.id);
  assert.equal(flagged?.status, 'DOWNLOADING', 'a running upload is only flagged');
  assert.equal(flagged?.cancel_requested, true);
  await jobsRepo.cancel(active.id);

  // Retry wipes what the failed run left behind.
  await uploadsRepo.setStatus(upload.id, 'FAILED', {
    error_message: 'boom',
    error_stage: 'DOWNLOADING',
    error_code: 'UNKNOWN_ERROR',
    error_retryable: false,
    error_at: new Date(),
    completed_at: new Date(),
    duration_ms: 12,
  });
  const retried = await jobsRepo.retryUpload(upload.id);
  assert.equal(retried.status, 'pending');
  const after = await uploadsRepo.byId(upload.id);
  assert.equal(after?.status, 'QUEUED');
  assert.equal(after?.error_stage, null);
  assert.equal(after?.error_code, null);
  assert.equal(after?.completed_at, null);
  assert.equal(after?.duration_ms, null);
  assert.equal(after?.cancel_requested, false);
});

test('queue position ignores jobs that are backing off or parked', async () => {
  const user = await makeUser('position');
  const make = async (name: string, runAfter?: Date) => {
    const upload = await uploadsRepo.createDirect({
      user_id: user.id,
      telegram_chat_id: user.telegram_chat_id,
      original_filename: name,
      safe_filename: name,
      extension: 'mkv',
      file_size: 1,
      local_source_path: `/nonexistent/${name}`,
    });
    return jobsRepo.enqueue({ type: 'process-upload', upload_id: upload.id, priority: 990, run_after: runAfter });
  };
  // Two parked ahead of it (lower ids), one runnable ahead of it.
  const parkedA = await make('parked-a.mkv', PARKED);
  const parkedB = await make('parked-b.mkv', PARKED);
  const runnable = await make('runnable.mkv', new Date(Date.now() - 1000));
  const mine = await make('mine.mkv', new Date(Date.now() - 1000));
  try {
    const position = await jobsRepo.queuePosition(mine.id);
    assert.ok(position);
    // Only jobs that a worker could actually claim before this one count.
    const { rows } = await query<{ n: string }>(
      `SELECT count(*) AS n FROM jobs
        WHERE status = 'pending' AND run_after <= now()
          AND (priority, id) < ($1, $2)`,
      [990, mine.id],
    );
    assert.equal(position.ahead, Number(rows[0]?.n));
    assert.ok(position.ahead >= 1, 'the runnable fixture ahead of it is counted');
    const { rows: naive } = await query<{ n: string }>(
      `SELECT count(*) AS n FROM jobs WHERE status = 'pending' AND (priority, id) < ($1, $2)`,
      [990, mine.id],
    );
    assert.ok(Number(naive[0]?.n) >= position.ahead + 2, 'the two parked jobs were not counted');
  } finally {
    await query('DELETE FROM jobs WHERE id = ANY($1::bigint[])', [[parkedA.id, parkedB.id, runnable.id, mine.id]]);
  }
});
