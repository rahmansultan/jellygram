import './helpers/test-credentials.js';
import './helpers/test-database.js';
import './helpers/test-media-root.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { config } from '../src/config/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { closePool, query } from '../src/db/pool.js';
import { mediaRepo, uploadsRepo, usersRepo } from '../src/db/repositories.js';
import { miniappRouter } from '../src/api/miniapp.js';
import { signInitData } from '../src/lib/telegram-initdata.js';
import { storageSlug } from '../src/lib/paths.js';
import type { UserRow } from '../src/db/types.js';

/**
 * The Mini App's API, exercised over real HTTP against a real database.
 *
 * The property that matters most is not that the endpoints work but that they
 * cannot be talked out of who you are. Two users are created for every run and
 * each one's credential is pointed at the other's data: at their uploads, at
 * their media, at cancelling and retrying their transfers. A single one of
 * those succeeding would be a privacy breach in a system whose entire purpose
 * is that one person cannot see another's library.
 */

/**
 * This file's own range. Test files run in parallel against one database, so
 * each owns a disjoint band of telegram_chat_id and must delete only inside it.
 *
 * Positive, unlike every other test file's range, and deliberately so: a real
 * Telegram *user* id is always positive, and the verifier rejects anything
 * else, so a negative fixture could never be signed into a valid credential.
 * The band is far from any id Telegram has issued and is verified empty before
 * use.
 */
const CHAT_A = 8_999_666_001;
const CHAT_B = 8_999_666_002;
const CHAT_FLOOR = 8_999_666_000;
const CHAT_CEIL = 8_999_666_999;

let server: Server;
let base: string;
let alice: UserRow;
let bob: UserRow;
let aliceUploadId: number;
let bobUploadId: number;
let aliceMediaId: number;
let bobMediaId: number;

/**
 * A credential for a given Telegram account.
 *
 * Signed with the same bot token the server verifies against — read from
 * config, never printed. A test that hard-coded a hash would stop proving
 * anything the moment the algorithm changed.
 */
function credential(telegramId: number, overrides: Record<string, string> = {}): string {
  return signInitData(
    {
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: telegramId, first_name: 'Test', username: `t${Math.abs(telegramId)}` }),
      ...overrides,
    },
    config.telegram.botToken,
  );
}

async function call(
  path: string,
  { as, method = 'GET', raw, body }: { as?: number; method?: string; raw?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (raw !== undefined) headers['Authorization'] = `tma ${raw}`;
  else if (as !== undefined) headers['Authorization'] = `tma ${credential(as)}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

async function makeUser(suffix: string, chatId: number): Promise<UserRow> {
  const slug = storageSlug(`mini-${suffix}-${Date.now()}-${Math.abs(chatId)}`);
  return usersRepo.create({
    name: `Mini ${suffix}`,
    telegram_chat_id: chatId,
    jellyfin_username: slug,
    jellyfin_user_id: null,
    storage_slug: slug,
  });
}

async function makeUpload(user: UserRow, filename: string): Promise<number> {
  const row = await uploadsRepo.create({
    user_id: user.id,
    telegram_chat_id: user.telegram_chat_id,
    telegram_message_id: Math.floor(Math.abs(user.telegram_chat_id) % 100000),
    telegram_file_id: `mini-${user.id}-${filename}`,
    telegram_file_unique_id: null,
    mime_type: null,
    original_filename: filename,
    safe_filename: filename,
    extension: 'mkv',
    file_size: 1024 * 1024,
  });
  return row.id;
}

/**
 * Delete exactly this file's own fixtures, by id, and nothing else.
 *
 * Every other test file sweeps its band with a range DELETE. That is safe for
 * a *negative* band, which Telegram never issues, and it is the wrong shape
 * here: users.id cascades to uploads and media, and DATABASE_URL points at the
 * live database. Naming the two rows removes the class of accident entirely.
 */
async function cleanup(): Promise<void> {
  await query('DELETE FROM users WHERE telegram_chat_id = ANY($1::bigint[])', [[CHAT_A, CHAT_B]]);
}

/** Refuse to run if anything unexpected already occupies the band. */
async function assertBandIsOurs(): Promise<void> {
  const { rows } = await query<{ telegram_chat_id: string; name: string }>(
    'SELECT telegram_chat_id, name FROM users WHERE telegram_chat_id BETWEEN $1 AND $2',
    [CHAT_FLOOR, CHAT_CEIL],
  );
  const strangers = rows.filter((r) => ![CHAT_A, CHAT_B].includes(Number(r.telegram_chat_id)));
  if (strangers.length > 0) {
    throw new Error(
      `Refusing to run: ${strangers.length} unexpected user(s) occupy this test's chat-id band. ` +
        'Investigate before running, rather than deleting them.',
    );
  }
}

before(async () => {
  await runMigrations();
  await assertBandIsOurs();
  await cleanup();

  alice = await makeUser('alice', CHAT_A);
  bob = await makeUser('bob', CHAT_B);

  aliceUploadId = await makeUpload(alice, 'Alice.Private.2024.mkv');
  bobUploadId = await makeUpload(bob, 'Bob.Private.2024.mkv');

  const aliceMedia = await mediaRepo.create({
    user_id: alice.id,
    upload_id: aliceUploadId,
    title: 'Alice Private Film',
    year: 2024,
    type: 'movie',
    season: null,
    episode: null,
    episode_title: null,
    path: `/tmp/mini-test/alice-${alice.id}.mkv`,
    file_size: 1024,
    checksum_sha256: null,
    tmdb_id: null,
    overview: null,
    poster_path: null,
    original_title: null,
    jellyfin_item_id: null,
    jellyfin_verified: false,
  });
  aliceMediaId = aliceMedia.id;

  const bobMedia = await mediaRepo.create({
    user_id: bob.id,
    upload_id: bobUploadId,
    title: 'Bob Private Film',
    year: 2024,
    type: 'movie',
    season: null,
    episode: null,
    episode_title: null,
    path: `/tmp/mini-test/bob-${bob.id}.mkv`,
    file_size: 1024,
    checksum_sha256: null,
    tmdb_id: null,
    overview: null,
    poster_path: null,
    original_title: null,
    jellyfin_item_id: null,
    jellyfin_verified: false,
  });
  bobMediaId = bobMedia.id;

  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use('/api/miniapp', miniappRouter);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
  await closePool();
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

test('a registered user with a valid credential is recognised', async () => {
  const { status, json } = await call('/api/miniapp/me', { as: CHAT_A });
  assert.equal(status, 200);
  assert.equal(json.account.name, 'Mini alice');
  assert.equal(json.account.jellyfinUsername, alice.jellyfin_username);
});

test('no credential at all is refused', async () => {
  const { status, json } = await call('/api/miniapp/me');
  assert.equal(status, 401);
  assert.equal(json.code, 'NO_INIT_DATA');
});

test('a forged credential is refused', async () => {
  // Signed with a bot token that is not ours: the shape is perfect, the
  // signature is not.
  const forged = signInitData(
    {
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: CHAT_A, first_name: 'Mallory' }),
    },
    'someone-elses-bot-token',
  );
  const { status, json } = await call('/api/miniapp/me', { raw: forged });
  assert.equal(status, 401);
  assert.equal(json.code, 'BAD_INIT_DATA');
});

test('editing the user id in a valid credential invalidates it', async () => {
  // The exact attack: take your own signed blob, point it at another account.
  const mine = new URLSearchParams(credential(CHAT_B));
  mine.set('user', JSON.stringify({ id: CHAT_A, first_name: 'Bob pretending' }));
  const { status } = await call('/api/miniapp/me', { raw: mine.toString() });
  assert.equal(status, 401);
});

test('an expired credential is refused and says so distinctly', async () => {
  const stale = credential(CHAT_A, {
    auth_date: String(Math.floor(Date.now() / 1000) - config.miniapp.maxAgeSec - 60),
  });
  const { status, json } = await call('/api/miniapp/me', { raw: stale });
  assert.equal(status, 401);
  // Distinct from a bad signature so the app can say "reopen" rather than
  // "you are not allowed".
  assert.equal(json.code, 'EXPIRED');
});

test('a validly signed but unregistered Telegram account is refused', async () => {
  // Signature genuine, account unknown: authentication succeeded and
  // authorisation did not.
  const stranger = credential(8_999_666_900);
  const { status, json } = await call('/api/miniapp/me', { raw: stranger });
  assert.equal(status, 403);
  assert.equal(json.code, 'NOT_REGISTERED');
});

test('a deactivated user loses access on their next request', async () => {
  await usersRepo.update(bob.id, { active: false });
  try {
    const { status, json } = await call('/api/miniapp/me', { as: CHAT_B });
    assert.equal(status, 403);
    assert.equal(json.code, 'DEACTIVATED');
  } finally {
    await usersRepo.update(bob.id, { active: true });
  }
});

test('the unauthenticated config endpoint reveals nothing about anyone', async () => {
  const { status, json } = await call('/api/miniapp/config');
  assert.equal(status, 200);
  const body = JSON.stringify(json);
  assert.doesNotMatch(body, /alice|bob|jellyfin_user|telegram_chat/i);
  assert.ok(Array.isArray(json.formats));

  // Not even the instance's own name. The Mini App is opened over a public
  // https URL, so an unauthenticated caller learns that the app exists and
  // what it would accept — never whose it is. APP_NAME rides on /me, which
  // requires a verified Telegram credential.
  assert.ok(!('appName' in (json as Record<string, unknown>)), 'APP_NAME must not be public');
  assert.doesNotMatch(body, new RegExp(config.appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
});

// ---------------------------------------------------------------------------
// Isolation — the property the whole system exists for
// ---------------------------------------------------------------------------

test('the library shows only your own media', async () => {
  const a = await call('/api/miniapp/library', { as: CHAT_A });
  assert.equal(a.status, 200);
  const titles = a.json.items.map((m: { title: string }) => m.title);
  assert.ok(titles.includes('Alice Private Film'));
  assert.ok(!titles.includes('Bob Private Film'), "Alice can see Bob's media");

  const b = await call('/api/miniapp/library', { as: CHAT_B });
  const bTitles = b.json.items.map((m: { title: string }) => m.title);
  assert.ok(bTitles.includes('Bob Private Film'));
  assert.ok(!bTitles.includes('Alice Private Film'), "Bob can see Alice's media");
});

test('a userId in the query string is ignored, not honoured', async () => {
  // The obvious attempt: name somebody else and hope the server passes it
  // through to the repository.
  const { status, json } = await call(`/api/miniapp/library?userId=${bob.id}`, { as: CHAT_A });
  assert.equal(status, 200);
  const titles = json.items.map((m: { title: string }) => m.title);
  assert.ok(!titles.includes('Bob Private Film'), 'a client-supplied userId changed the result');
  assert.ok(titles.includes('Alice Private Film'));
});

test('upload history shows only your own uploads', async () => {
  const a = await call('/api/miniapp/uploads', { as: CHAT_A });
  const names = a.json.items.map((u: { filename: string }) => u.filename);
  assert.ok(names.includes('Alice.Private.2024.mkv'));
  assert.ok(!names.includes('Bob.Private.2024.mkv'), "Alice can see Bob's uploads");
});

test('active transfers are filtered in the database, not in a page', async () => {
  // Filtering a page in JavaScript lost any upload with more than a page of
  // newer rows ahead of it, and reported the page's size as the total.
  await uploadsRepo.setStatus(aliceUploadId, 'DOWNLOADING', {});
  const { status, json } = await call('/api/miniapp/active', { as: CHAT_A });
  assert.equal(status, 200);
  assert.equal(json.total, json.items.length, 'the total must count what the filter matched');
  assert.ok(json.items.some((u: { id: number }) => u.id === aliceUploadId));
  for (const item of json.items) {
    assert.ok(
      ['RECEIVED', 'QUEUED', 'DOWNLOADING', 'PROCESSING', 'ORGANIZING', 'JELLYFIN_SCAN'].includes(item.status),
      `${item.status} is not an active status`,
    );
  }
});

test('active transfers show only your own', async () => {
  const a = await call('/api/miniapp/active', { as: CHAT_A });
  assert.equal(a.status, 200);
  for (const item of a.json.items) {
    assert.notEqual(item.filename, 'Bob.Private.2024.mkv');
  }
});

test("cancelling another user's upload is refused as if it did not exist", async () => {
  const { status, json } = await call(`/api/miniapp/uploads/${bobUploadId}/cancel`, {
    as: CHAT_A,
    method: 'POST',
  });
  // 404 rather than 403: a 403 would confirm the id exists, turning the
  // endpoint into a way to enumerate other people's uploads.
  assert.equal(status, 404);
  assert.equal(json.code, 'NOT_FOUND');

  const still = await uploadsRepo.byId(bobUploadId);
  assert.ok(still);
  assert.notEqual(still.status, 'CANCELLED', "Alice cancelled Bob's upload");
});

test("retrying another user's upload is refused", async () => {
  const { status } = await call(`/api/miniapp/uploads/${bobUploadId}/retry`, {
    as: CHAT_A,
    method: 'POST',
  });
  assert.equal(status, 404);
});

test("another user's poster cannot be fetched", async () => {
  const { status } = await call(`/api/miniapp/poster/${bobMediaId}`, { as: CHAT_A });
  assert.equal(status, 404);
});

test('your own actions on your own upload are allowed', async () => {
  // The mirror of the tests above: isolation that also blocked the owner
  // would be indistinguishable from a broken endpoint.
  const own = await call(`/api/miniapp/uploads/${aliceUploadId}/cancel`, { as: CHAT_A, method: 'POST' });
  assert.equal(own.status, 200, JSON.stringify(own.json));
  assert.equal(own.json.ok, true);

  // Cancellation is *requested* — the worker acts on the flag — so the row is
  // not yet terminal and retrying it here would be wrong. Drive it to a
  // terminal state the way a real failure would.
  await uploadsRepo.setStatus(aliceUploadId, 'FAILED', { error_message: 'synthetic test failure' });
  const retry = await call(`/api/miniapp/uploads/${aliceUploadId}/retry`, { as: CHAT_A, method: 'POST' });
  assert.equal(retry.status, 200, JSON.stringify(retry.json));
  assert.ok(retry.json.jobId);
});

test('an upload that is still running cannot be retried', async () => {
  await uploadsRepo.setStatus(bobUploadId, 'DOWNLOADING', {});
  const { status, json } = await call(`/api/miniapp/uploads/${bobUploadId}/retry`, {
    as: CHAT_B,
    method: 'POST',
  });
  assert.equal(status, 409);
  assert.equal(json.code, 'NOT_RETRYABLE');
});

test('a quarantined upload is not retried, and says what to do instead', async () => {
  // NEEDS_REVIEW means the pipeline declined to guess and moved the file to
  // quarantine, repointing stored_path at the copy. Re-queueing it is a
  // different operation wearing the same name, and the admin API refuses it
  // too.
  await uploadsRepo.setStatus(bobUploadId, 'NEEDS_REVIEW', {});
  const { status, json } = await call(`/api/miniapp/uploads/${bobUploadId}/retry`, {
    as: CHAT_B,
    method: 'POST',
  });
  assert.equal(status, 409);
  assert.equal(json.code, 'NOT_RETRYABLE');
  assert.match(json.error, /rename|send it again/i);
});

test('authenticated responses forbid caching and vary on the credential', async () => {
  // Authentication is a header, so a cache keyed on the URL alone would serve
  // one person's library to the next caller.
  const res = await fetch(`${base}/api/miniapp/me`, {
    headers: { Authorization: `tma ${credential(CHAT_A)}` },
  });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('vary') ?? '', /Authorization/i);
});

test('an ordinary expiry does not consume the attempt budget', async () => {
  // An app left open overnight expires normally; counting that as an attack
  // would let it lock its own owner out.
  const stale = credential(CHAT_A, {
    auth_date: String(Math.floor(Date.now() / 1000) - config.miniapp.maxAgeSec - 60),
  });
  for (let i = 0; i < 10; i += 1) {
    const r = await call('/api/miniapp/me', { raw: stale });
    assert.equal(r.status, 401, `attempt ${i + 1} became ${r.status}`);
    assert.equal(r.json.code, 'EXPIRED');
  }
  // And a good credential still works afterwards.
  assert.equal((await call('/api/miniapp/me', { as: CHAT_A })).status, 200);
});

// ---------------------------------------------------------------------------
// What the responses may contain
// ---------------------------------------------------------------------------

test('no response carries a filesystem path or a secret', async () => {
  const responses = await Promise.all([
    call('/api/miniapp/me', { as: CHAT_A }),
    call('/api/miniapp/library', { as: CHAT_A }),
    call('/api/miniapp/uploads', { as: CHAT_A }),
    call('/api/miniapp/active', { as: CHAT_A }),
  ]);

  for (const { json } of responses) {
    const body = JSON.stringify(json);
    // The media row carries an absolute path; the client has no use for it
    // and it describes the server's own disk.
    assert.doesNotMatch(body, /"path"/, 'a filesystem path was serialised');
    assert.doesNotMatch(body, /\/home\/|\/srv\/|\/var\//, 'an absolute path leaked');
    assert.doesNotMatch(body, /upload_token|token_hash|api_?key|password|session_string/i);
    // The bot token is what signs the credential; it must never travel back.
    assert.ok(!body.includes(config.telegram.botToken) || config.telegram.botToken === '');
  }
});

test('a media item exposes only what a phone needs to display it', async () => {
  const { json } = await call('/api/miniapp/library', { as: CHAT_A });
  const item = json.items[0];
  assert.ok(item);
  assert.deepEqual(
    Object.keys(item).sort(),
    [
      'addedAt', 'episode', 'episodeTitle', 'fileSize', 'hasPoster', 'id',
      'jellyfinItemId', 'jellyfinVerified', 'season', 'title', 'type', 'uploadId', 'year',
    ].sort(),
  );
});

// ---------------------------------------------------------------------------
// Malformed and hostile input
// ---------------------------------------------------------------------------

test('a non-numeric or absurd upload id is a client error, not a server one', async () => {
  for (const id of ['abc', '-1', '0', '99999999999999999999', '1e40']) {
    const { status } = await call(`/api/miniapp/uploads/${id}/cancel`, { as: CHAT_A, method: 'POST' });
    assert.ok(status === 404 || status === 400, `id ${id} produced ${status}`);
  }
});

test('injection through a search term matches nothing rather than executing', async () => {
  for (const q of ["' OR 1=1--", "'; DROP TABLE users;--", '%', '_']) {
    const { status, json } = await call(`/api/miniapp/library?q=${encodeURIComponent(q)}`, { as: CHAT_A });
    assert.equal(status, 200);
    assert.equal(json.items.length, 0, `search ${JSON.stringify(q)} matched something`);
  }
  // Still there.
  assert.ok(await usersRepo.byId(alice.id));
});

test('paging parameters are bounded', async () => {
  const huge = await call('/api/miniapp/library?limit=100000', { as: CHAT_A });
  assert.equal(huge.status, 422);
  const negative = await call('/api/miniapp/library?offset=-5', { as: CHAT_A });
  assert.equal(negative.status, 422);
  const fine = await call('/api/miniapp/library?limit=5&offset=0', { as: CHAT_A });
  assert.equal(fine.status, 200);
  assert.equal(fine.json.limit, 5);
});

test('an oversized credential is rejected without being verified', async () => {
  const huge = `${credential(CHAT_A)}&pad=${'x'.repeat(8192)}`;
  const { status } = await call('/api/miniapp/me', { raw: huge });
  assert.equal(status, 401);
});

test('an unknown path under the mini app API is JSON, never an HTML shell', async () => {
  const { status, json } = await call('/api/miniapp/does-not-exist', { as: CHAT_A });
  assert.equal(status, 404);
  assert.equal(json.code, 'NOT_FOUND');
});

test('progress is reported with the flag that says whether it was measured', async () => {
  const { json } = await call('/api/miniapp/uploads', { as: CHAT_A });
  const item = json.items[0];
  assert.ok(item);
  assert.ok('progress' in item);
  // The field that stops a pipeline-position estimate being read as a
  // transfer measurement.
  assert.equal(typeof item.progress.byteAccurate, 'boolean');
  assert.ok('percent' in item.progress);
  assert.ok('stage' in item.progress);
});

test('/me names every door to Jellyfin without changing the old field', async () => {
  const { status, json } = await call('/api/miniapp/me', { as: CHAT_A });
  assert.equal(status, 200);
  // The field the app already relied on keeps its name and its meaning.
  assert.ok('jellyfinUrl' in json);
  assert.deepEqual(Object.keys(json.jellyfin).sort(), ['internet', 'lan', 'tailscale']);
  assert.equal(json.jellyfin.lan, json.jellyfinUrl);
  for (const value of Object.values(json.jellyfin)) {
    assert.ok(value === null || /^https?:\/\//.test(String(value)), `not a URL: ${value}`);
  }
});

/**
 * Placed last on purpose: it fills the attempt counter for the address every
 * other test shares, and only a success empties it again.
 */
test('a flood of bad signatures throttles the flood but never the owner', async () => {
  const forged = signInitData(
    {
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: CHAT_A, first_name: 'Test' }),
    },
    'not-the-bot-token',
  );

  let throttled = false;
  for (let i = 0; i < 12 && !throttled; i += 1) {
    const { status } = await call('/api/miniapp/me', { raw: forged });
    if (status === 429) throttled = true;
    else assert.equal(status, 401);
  }
  assert.ok(throttled, 'repeated bad signatures must eventually be throttled');

  // The property this test exists for. Once the app is reachable from the open
  // internet every request arrives from the same proxy address, so a block that
  // attached to the address rather than to the failures would hand any passing
  // scanner a fifteen-minute denial of service against the real owner.
  const { status } = await call('/api/miniapp/me', { as: CHAT_A });
  assert.equal(status, 200);
});
