import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyInitData, signInitData } from '../src/lib/telegram-initdata.js';
import { checkLoginAllowed, recordLoginFailure, recordLoginSuccess, resetLoginThrottle } from '../src/api/auth.js';
import { classify, codeFor } from '../src/lib/errors.js';
import { titlesAgree } from '../src/services/identify.js';
import { looksLikeNoTitle, parseFilename } from '../src/services/parser.js';
import { TelegramFileError } from '../src/services/download.js';
import { PipelineError } from '../src/worker/pipeline.js';
import { userUpdateSchema } from '../src/api/routes/index.js';

/**
 * The behaviours the final audit changed, each pinned so it cannot quietly
 * revert: configuration that refuses nonsense, a credential parser that
 * refuses non-objects, a login throttle with a per-address ceiling, error
 * classification that looks through wrappers, identification that does not
 * invent titles, and a PATCH schema that changes only what it was sent.
 */

const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmn';

// ---------------------------------------------------------------------------
// Configuration validation, in a child process so a bad value cannot take
// this test file down with it.
// ---------------------------------------------------------------------------

function loadConfigWith(env: Record<string, string>): { code: number; stderr: string } {
  const script = path.join(process.cwd(), 'dist-tests', 'src', 'config', 'index.js');
  try {
    execFileSync(process.execPath, ['-e', `import(${JSON.stringify(script)}).then(() => process.exit(0))`], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return { code: 0, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer | string };
    return { code: e.status ?? -1, stderr: String(e.stderr ?? '') };
  }
}

test('a misspelt boolean is a configuration error, not a silent false', () => {
  const r = loadConfigWith({ TRUST_PROXY: 'loopback' });
  assert.equal(r.code, 78, 'EX_CONFIG');
  assert.match(r.stderr, /TRUST_PROXY/);
  assert.match(r.stderr, /true\/false/);
});

test('the accepted boolean spellings all parse', () => {
  for (const v of ['1', '0', 'true', 'FALSE', 'yes', 'No', 'on', 'off']) {
    assert.equal(loadConfigWith({ QUEUE_PAUSED: v }).code, 0, `QUEUE_PAUSED=${v}`);
  }
});

test('counts below their floor, a bad mode and an unknown log level are refused at startup', () => {
  assert.equal(loadConfigWith({ DB_POOL_MAX: '0' }).code, 78);
  assert.equal(loadConfigWith({ WORKER_SMALL_CONCURRENCY: '0' }).code, 78);
  assert.equal(loadConfigWith({ MINIAPP_MAX_AGE_SEC: '-1' }).code, 78);
  assert.equal(loadConfigWith({ ADMIN_PORT: '99999' }).code, 78);
  assert.equal(loadConfigWith({ MEDIA_DIR_MODE: 'zz' }).code, 78);
  assert.equal(loadConfigWith({ LOG_LEVEL: 'garbage' }).code, 78);
  assert.equal(loadConfigWith({ LOG_LEVEL: 'WARN' }).code, 0, 'case is forgiven');
});

// ---------------------------------------------------------------------------
// initData: the user field must be an object with a numeric id
// ---------------------------------------------------------------------------

function signed(user: string): string {
  return signInitData(
    { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'q', user },
    BOT_TOKEN,
    { signedOver: 'fields' },
  );
}

test('a validly signed but non-object user is refused as malformed, not thrown', () => {
  for (const user of ['null', '[1]', '"x"', '7']) {
    const r = verifyInitData(signed(user), BOT_TOKEN, { maxAgeSec: 3600 });
    assert.equal(r.ok, false, user);
    if (!r.ok) assert.equal(r.reason, 'malformed', user);
  }
});

test('an id that is not a JSON number is refused, even where Number() would coerce it', () => {
  for (const user of ['{"id":true}', '{"id":"12"}', '{"id":[5]}', '{"id":1.5}', '{"id":0}']) {
    const r = verifyInitData(signed(user), BOT_TOKEN, { maxAgeSec: 3600 });
    assert.equal(r.ok, false, user);
  }
  const ok = verifyInitData(signed('{"id":42,"first_name":"A"}'), BOT_TOKEN, { maxAgeSec: 3600 });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.user.id, 42);
});

// ---------------------------------------------------------------------------
// Login throttle: a per-address ceiling across usernames
// ---------------------------------------------------------------------------

test('varying the username does not buy unlimited guesses from one address', () => {
  resetLoginThrottle();
  try {
    for (let i = 0; i < 29; i += 1) recordLoginFailure(`10.0.0.9:user-${i}`);
    assert.equal(checkLoginAllowed('10.0.0.9:user-9999').allowed, true, 'under the ceiling');
    recordLoginFailure('10.0.0.9:user-30');
    const gate = checkLoginAllowed('10.0.0.9:someone-new');
    assert.equal(gate.allowed, false, 'thirty failures from one address block that address');
    assert.ok(gate.retryAfterSec > 0);
    // Another address is untouched.
    assert.equal(checkLoginAllowed('10.0.0.10:user-1').allowed, true);
    // The per-account rule still applies on its own.
    for (let i = 0; i < 8; i += 1) recordLoginFailure('10.0.0.11:admin');
    assert.equal(checkLoginAllowed('10.0.0.11:admin').allowed, false);
    assert.equal(checkLoginAllowed('10.0.0.11:other').allowed, true);
    recordLoginSuccess('10.0.0.11:admin');
    assert.equal(checkLoginAllowed('10.0.0.11:admin').allowed, true);
  } finally {
    resetLoginThrottle();
  }
});

// ---------------------------------------------------------------------------
// Error classification looks through a wrapper to its cause
// ---------------------------------------------------------------------------

test('a PipelineError wrapping a Telegram failure is classified as that failure', () => {
  const inner = new TelegramFileError(
    'Telegram getFile failed: Bad Request: wrong file_id or the file is temporarily unavailable',
    true,
  );
  const wrapped = new PipelineError(inner.message, 'Download failed.', inner.retryable, { cause: inner });
  assert.equal(codeFor(wrapped), 'TELEGRAM_UNAVAILABLE');
  assert.equal(classify(wrapped).retryable, true, 'the wrapper keeps its declared retryability');
  const bare = new PipelineError(inner.message, 'Download failed.', false);
  assert.equal(codeFor(bare), 'UNKNOWN_ERROR', 'without a cause there is nothing to look through');
});

test('"wrong file_id" without the temporary clause is a missing file', () => {
  const gone = new TelegramFileError('Telegram getFile failed: Bad Request: wrong file_id', false);
  assert.equal(codeFor(gone), 'TELEGRAM_FILE_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// Identification: a search hit must agree with the name
// ---------------------------------------------------------------------------

test('title agreement forgives punctuation, case, accents and a leading article', () => {
  assert.equal(titlesAgree('The Matrix', 'The Matrix'), true);
  assert.equal(titlesAgree('Matrix', 'The Matrix'), true);
  assert.equal(titlesAgree('Amelie', 'Amélie', 'Le Fabuleux Destin d’Amélie Poulain'), true);
  assert.equal(titlesAgree('Dune Part Two', 'Dune: Part Two'), true);
  assert.equal(titlesAgree('video', 'Video Vixens!'), false);
  assert.equal(titlesAgree('a', 'A Great Love'), false);
  assert.equal(titlesAgree('', 'Anything'), false);
});

test('names that are not titles score below the review threshold', () => {
  for (const name of ['video.mp4', 'a.mkv', '1.mp4', 'Untitled.mov', 'IMG_2041.mov', 'VID_20240901_183000.mp4', 'video 2.mp4', 'Screen Recording 2024-09-01.mov']) {
    assert.equal(looksLikeNoTitle(parseFilename(name).title), true, name);
    assert.ok(parseFilename(name).confidence < 0.35, `${name} parks for review`);
  }
  for (const name of ['Inception.mkv', 'Dune.Part.Two.mkv', 'The.Matrix.1999.1080p.mkv']) {
    assert.equal(looksLikeNoTitle(parseFilename(name).title), false, name);
    assert.ok(parseFilename(name).confidence >= 0.35, `${name} is filed`);
  }
});

// ---------------------------------------------------------------------------
// PATCH /users changes only what it was sent
// ---------------------------------------------------------------------------

test('a partial user update carries no defaults for the fields it did not mention', () => {
  assert.deepEqual(userUpdateSchema.parse({ active: false }), { active: false });
  assert.deepEqual(userUpdateSchema.parse({ name: 'x' }), { name: 'x' });
  assert.equal('upload_enabled' in userUpdateSchema.parse({ active: true }), false);
});
