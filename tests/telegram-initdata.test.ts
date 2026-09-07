import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  MAX_INIT_DATA_BYTES,
  signInitData,
  verifyInitData,
} from '../src/lib/telegram-initdata.js';

/**
 * The Mini App's only identity check.
 *
 * Everything the WebView says about itself is forgeable: the user id, the
 * username, the whole payload. The signature is the sole reason to believe any
 * of it, so each way of getting it wrong is tested individually — a verifier
 * that accepts one bad case accepts every account.
 *
 * The fixtures are signed with the real algorithm rather than pinned to a
 * hard-coded digest, so these keep proving something if the implementation
 * ever changes.
 */

const BOT_TOKEN = '123456789:AA-test-token-not-a-real-credential-xxxxx';
const OTHER_TOKEN = '987654321:AA-a-different-bot-entirely-yyyyyyyyyyy';
const NOW = 1_760_000_000_000;
const nowSec = Math.floor(NOW / 1000);

const opts = { maxAgeSec: 3600, now: NOW };

function makeInitData(overrides: Record<string, string> = {}, token = BOT_TOKEN): string {
  return signInitData(
    {
      auth_date: String(nowSec - 10),
      query_id: 'AAF_test',
      user: JSON.stringify({
        id: 555_000_111,
        first_name: 'Alice',
        last_name: 'H',
        username: 'alice',
        language_code: 'en',
      }),
      ...overrides,
    },
    token,
  );
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test('a correctly signed payload is accepted and yields the signed identity', () => {
  const result = verifyInitData(makeInitData(), BOT_TOKEN, opts);
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.user.id, 555_000_111);
  assert.equal(result.user.firstName, 'Alice');
  assert.equal(result.user.username, 'alice');
  assert.equal(result.queryId, 'AAF_test');
  assert.equal(result.authDate.getTime(), (nowSec - 10) * 1000);
});

test('the newer signature field is excluded from the HMAC', () => {
  // Telegram appends `signature` for its Ed25519 scheme but does not include
  // it in the HMAC. Hashing it would reject every real payload.
  const base = makeInitData();
  const params = new URLSearchParams(base);
  params.set('signature', 'abc_this_is_not_part_of_the_hmac');
  assert.equal(verifyInitData(params.toString(), BOT_TOKEN, opts).ok, true);
});

test('field order in the query string does not matter', () => {
  const params = new URLSearchParams(makeInitData());
  const reversed = new URLSearchParams();
  for (const [k, v] of [...params.entries()].reverse()) reversed.append(k, v);
  assert.equal(verifyInitData(reversed.toString(), BOT_TOKEN, opts).ok, true);
});

// ---------------------------------------------------------------------------
// Forgery
// ---------------------------------------------------------------------------

test('an unsigned payload is rejected', () => {
  const params = new URLSearchParams(makeInitData());
  params.delete('hash');
  assert.deepEqual(verifyInitData(params.toString(), BOT_TOKEN, opts), {
    ok: false,
    reason: 'missing-hash',
  });
});

test('a payload signed by a different bot is rejected', () => {
  const forged = makeInitData({}, OTHER_TOKEN);
  assert.deepEqual(verifyInitData(forged, BOT_TOKEN, opts), { ok: false, reason: 'bad-signature' });
});

test('changing the user id invalidates the signature', () => {
  // The whole point: a client that edits the payload to claim another account
  // must not be believed.
  const params = new URLSearchParams(makeInitData());
  params.set('user', JSON.stringify({ id: 999_999_999, first_name: 'Mallory' }));
  assert.deepEqual(verifyInitData(params.toString(), BOT_TOKEN, opts), {
    ok: false,
    reason: 'bad-signature',
  });
});

test('changing the username invalidates the signature', () => {
  const params = new URLSearchParams(makeInitData());
  params.set(
    'user',
    JSON.stringify({ id: 555_000_111, first_name: 'Alice', username: 'someone_else' }),
  );
  assert.equal(verifyInitData(params.toString(), BOT_TOKEN, opts).ok, false);
});

test('changing auth_date invalidates the signature', () => {
  // An expired payload cannot be refreshed by editing the date; that would
  // make the freshness window meaningless.
  const params = new URLSearchParams(makeInitData({ auth_date: String(nowSec - 99_999) }));
  params.set('auth_date', String(nowSec));
  assert.deepEqual(verifyInitData(params.toString(), BOT_TOKEN, opts), {
    ok: false,
    reason: 'bad-signature',
  });
});

test('adding any extra field invalidates the signature', () => {
  const params = new URLSearchParams(makeInitData());
  params.set('is_admin', 'true');
  assert.equal(verifyInitData(params.toString(), BOT_TOKEN, opts).ok, false);
});

test('a hash of the right shape but wrong value is rejected', () => {
  const params = new URLSearchParams(makeInitData());
  params.set('hash', 'a'.repeat(64));
  assert.deepEqual(verifyInitData(params.toString(), BOT_TOKEN, opts), {
    ok: false,
    reason: 'bad-signature',
  });
});

test('a hash of the wrong shape is rejected before any comparison', () => {
  for (const bad of ['', 'zz', 'not-hex-at-all', 'a'.repeat(63), 'a'.repeat(65), '../etc/passwd']) {
    const params = new URLSearchParams(makeInitData());
    params.set('hash', bad);
    assert.equal(
      verifyInitData(params.toString(), BOT_TOKEN, opts).ok,
      false,
      `accepted hash ${JSON.stringify(bad)}`,
    );
  }
});

test('a valid signature from a truncated token is still a different signature', () => {
  // Guards against a comparison that only checks a prefix.
  const forged = makeInitData({}, BOT_TOKEN.slice(0, -1));
  assert.deepEqual(verifyInitData(forged, BOT_TOKEN, opts), { ok: false, reason: 'bad-signature' });
});

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

test('a payload older than the maximum age is rejected', () => {
  const old = makeInitData({ auth_date: String(nowSec - 7200) });
  assert.deepEqual(verifyInitData(old, BOT_TOKEN, { maxAgeSec: 3600, now: NOW }), {
    ok: false,
    reason: 'expired',
  });
});

test('a payload exactly at the maximum age is still accepted', () => {
  const edge = makeInitData({ auth_date: String(nowSec - 3600) });
  assert.equal(verifyInitData(edge, BOT_TOKEN, { maxAgeSec: 3600, now: NOW }).ok, true);
});

test('a small clock skew into the future is tolerated', () => {
  // A signature proves origin, not time. A phone a minute fast is not an
  // attack and must not lock somebody out of their own library.
  const skewed = makeInitData({ auth_date: String(nowSec + 60) });
  assert.equal(verifyInitData(skewed, BOT_TOKEN, { maxAgeSec: 3600, now: NOW }).ok, true);
});

test('a wildly future-dated payload is rejected', () => {
  // Otherwise a captured payload could be given an unbounded replay window.
  const future = makeInitData({ auth_date: String(nowSec + 86_400) });
  assert.deepEqual(verifyInitData(future, BOT_TOKEN, { maxAgeSec: 3600, now: NOW }), {
    ok: false,
    reason: 'future-dated',
  });
});

test('a missing or non-numeric auth_date is rejected', () => {
  for (const value of ['', 'soon', '-100', '1e9', '12.5']) {
    const data = makeInitData({ auth_date: value });
    const result = verifyInitData(data, BOT_TOKEN, opts);
    assert.equal(result.ok, false, `accepted auth_date ${JSON.stringify(value)}`);
  }
});

// ---------------------------------------------------------------------------
// Shape and abuse
// ---------------------------------------------------------------------------

test('absent initData is reported separately from a bad one', () => {
  // The caller shows different things for "open this from Telegram" and
  // "your session expired".
  assert.deepEqual(verifyInitData(undefined, BOT_TOKEN, opts), { ok: false, reason: 'missing' });
  assert.deepEqual(verifyInitData('', BOT_TOKEN, opts), { ok: false, reason: 'missing' });
  assert.deepEqual(verifyInitData(null, BOT_TOKEN, opts), { ok: false, reason: 'missing' });
});

test('an unconfigured bot token can never verify anything', () => {
  assert.deepEqual(verifyInitData(makeInitData(), '', opts), {
    ok: false,
    reason: 'bot-not-configured',
  });
});

test('an oversized payload is refused without being hashed', () => {
  // Verification is reachable before authentication, so the work it can be
  // made to do has to be bounded.
  const huge = `${makeInitData()}&padding=${'x'.repeat(MAX_INIT_DATA_BYTES)}`;
  assert.deepEqual(verifyInitData(huge, BOT_TOKEN, opts), { ok: false, reason: 'malformed' });
});

test('a signed payload with an unparseable user object is rejected', () => {
  const data = makeInitData({ user: 'not json at all' });
  assert.deepEqual(verifyInitData(data, BOT_TOKEN, opts), { ok: false, reason: 'malformed' });
});

test('a signed payload with no user is rejected', () => {
  const signed = signInitData({ auth_date: String(nowSec) }, BOT_TOKEN);
  assert.deepEqual(verifyInitData(signed, BOT_TOKEN, opts), { ok: false, reason: 'missing-user' });
});

test('a user id that is not a usable integer is rejected', () => {
  for (const id of [0, -5, 1.5, Number.MAX_SAFE_INTEGER + 2, 'abc']) {
    const data = makeInitData({ user: JSON.stringify({ id, first_name: 'X' }) });
    assert.equal(
      verifyInitData(data, BOT_TOKEN, opts).ok,
      false,
      `accepted user id ${JSON.stringify(id)}`,
    );
  }
});

test('user string fields are bounded so they cannot be used as a payload', () => {
  // Long enough to overflow the cap, short enough to stay inside the size
  // limit — otherwise this would be testing the size limit instead.
  const data = makeInitData({
    user: JSON.stringify({ id: 42, first_name: 'A'.repeat(600), username: 'B'.repeat(600) }),
  });
  const result = verifyInitData(data, BOT_TOKEN, opts);
  assert.ok(result.ok);
  assert.equal(result.user.firstName.length, 128);
  assert.equal(result.user.username?.length, 128);
});

test('verification does not depend on how the payload was encoded', () => {
  // Percent-encoding differences must not change the outcome: the JSON is
  // signed as the exact string Telegram sent.
  const data = makeInitData({ user: JSON.stringify({ id: 7, first_name: 'Ñ Ǎ / & = ?' }) });
  const result = verifyInitData(data, BOT_TOKEN, opts);
  assert.ok(result.ok);
  assert.equal(result.user.firstName, 'Ñ Ǎ / & = ?');
});

test('two payloads differing only in signature bytes both fail closed', () => {
  const data = new URLSearchParams(makeInitData());
  const real = data.get('hash')!;
  for (let i = 0; i < 8; i += 1) {
    const flipped = crypto.randomBytes(32).toString('hex');
    if (flipped === real) continue;
    data.set('hash', flipped);
    assert.equal(verifyInitData(data.toString(), BOT_TOKEN, opts).ok, false);
  }
});

/**
 * Bot API 8.0 added a `signature` field for third parties to validate initData
 * without the bot token. Telegram documents the HMAC's check string as every
 * received field except `hash`, which now includes `signature`; several widely
 * used libraries exclude it. Real clients produce both, and a verifier that
 * knows only one convention rejects half the world with "bad signature" —
 * which is exactly how this was found.
 */
test('a credential signed over the signature field verifies', () => {
  const raw = signInitData(
    {
      auth_date: String(nowSec - 10),
      query_id: 'AAF_test',
      signature: 'Zm9yLXRoaXJkLXBhcnRpZXM',
      user: JSON.stringify({ id: 555_000_111, first_name: 'Alice' }),
    },
    BOT_TOKEN,
    { signedOver: 'fields-with-signature' },
  );

  const result = verifyInitData(raw, BOT_TOKEN, opts);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.signedOver, 'fields-with-signature');
  assert.equal(result.ok && result.user.id, 555_000_111);
});

test('a credential signed without the signature field still verifies', () => {
  const raw = signInitData(
    {
      auth_date: String(nowSec - 10),
      signature: 'Zm9yLXRoaXJkLXBhcnRpZXM',
      user: JSON.stringify({ id: 555_000_111, first_name: 'Alice' }),
    },
    BOT_TOKEN,
  );

  const result = verifyInitData(raw, BOT_TOKEN, opts);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.signedOver, 'fields');
});

test('neither convention accepts a credential signed by another bot', () => {
  const raw = signInitData(
    {
      auth_date: String(nowSec - 10),
      signature: 'Zm9yLXRoaXJkLXBhcnRpZXM',
      user: JSON.stringify({ id: 555_000_111, first_name: 'Alice' }),
    },
    OTHER_TOKEN,
    { signedOver: 'fields-with-signature' },
  );

  const result = verifyInitData(raw, BOT_TOKEN, opts);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'bad-signature');
});

test('the wider convention does not let the user payload be edited', () => {
  const raw = signInitData(
    {
      auth_date: String(nowSec - 10),
      signature: 'Zm9yLXRoaXJkLXBhcnRpZXM',
      user: JSON.stringify({ id: 555_000_111, first_name: 'Alice' }),
    },
    BOT_TOKEN,
    { signedOver: 'fields-with-signature' },
  );

  // The one substitution the whole system exists to refuse.
  const tampered = raw.replace('555000111', '555000222');
  assert.notEqual(tampered, raw);

  const result = verifyInitData(tampered, BOT_TOKEN, opts);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'bad-signature');
});
