import test from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_CODES, classify, codeFor, isAlertable } from '../src/lib/errors.js';
import { DownloadCancelledError, TelegramFileError } from '../src/services/download.js';
import { JellyfinError } from '../src/services/jellyfin.js';
import { MtprotoError, MtprotoStalledError } from '../src/services/mtproto.js';
import { PipelineError } from '../src/worker/pipeline.js';
import { PathEscapeError } from '../src/lib/paths.js';

/**
 * The failure vocabulary.
 *
 * The classifier reads the existing error classes rather than replacing them,
 * so the important property is that it never contradicts a throw site that
 * already made a decision — and that everything else still lands somewhere an
 * operator can group and act on.
 */

const errno = (code: string): NodeJS.ErrnoException => {
  const err = new Error(`${code}: something failed`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
};

test('a Telegram failure is classified by what actually went wrong', () => {
  assert.equal(codeFor(new TelegramFileError('Telegram getFile failed: file is too big', false)), 'TELEGRAM_FILE_TOO_BIG');
  assert.equal(
    codeFor(new TelegramFileError('Telegram did not make the file available within 3600s', true)),
    'TELEGRAM_TIMEOUT',
  );
  assert.equal(codeFor(new TelegramFileError('Telegram returned no file path for this file', false)), 'TELEGRAM_FILE_NOT_FOUND');
});

test('MTProto failures are separated by kind, not by wording', () => {
  assert.equal(codeFor(new MtprotoError('x', 'y', false, 'auth')), 'MTPROTO_NOT_AUTHORISED');
  assert.equal(codeFor(new MtprotoError('x', 'y', false, 'access')), 'MTPROTO_ACCESS_DENIED');
  assert.equal(codeFor(new MtprotoError('x', 'y', false, 'config')), 'MTPROTO_NOT_CONFIGURED');
  assert.equal(codeFor(new MtprotoStalledError(120_000)), 'MTPROTO_TIMEOUT');
});

test('a Jellyfin failure distinguishes a rejected key from an unreachable server', () => {
  assert.equal(codeFor(new JellyfinError('unauthorised', 401)), 'JELLYFIN_AUTH_FAILED');
  assert.equal(codeFor(new JellyfinError('server error', 503)), 'JELLYFIN_UNAVAILABLE');
  assert.equal(codeFor(new JellyfinError('Jellyfin POST /Library/Refresh failed: 400', 400)), 'JELLYFIN_SCAN_FAILED');
});

test('filesystem errno values map to what an operator must do about them', () => {
  assert.equal(codeFor(errno('ENOSPC')), 'DISK_FULL');
  assert.equal(codeFor(errno('EACCES')), 'DISK_PERMISSION_DENIED');
  assert.equal(codeFor(errno('EPERM')), 'DISK_PERMISSION_DENIED');
  assert.equal(codeFor(errno('EIO')), 'DISK_IO_ERROR');
});

test('a database failure is recognised from its SQLSTATE', () => {
  // node-postgres reports SQLSTATE, which is five characters and nothing like
  // an errno; without this it fell through to UNKNOWN_ERROR.
  assert.equal(codeFor(errno('23503')), 'DATABASE_ERROR');
  assert.equal(codeFor(errno('57P01')), 'DATABASE_ERROR');
});

test('cancellation is never reported as a failure', () => {
  const c = classify(new DownloadCancelledError());
  assert.equal(c.code, 'CANCELLED');
  assert.equal(c.severity, 'expected', 'a user cancelling is not an incident');
  assert.equal(c.retryable, false);
});

test('a path escape is treated as critical, because it is a bug or an attack', () => {
  const c = classify(new PathEscapeError('/etc/passwd', '/srv/media'));
  assert.equal(c.code, 'PATH_REJECTED');
  assert.equal(c.severity, 'critical');
  assert.ok(isAlertable(c.code));
});

test('a throw site that declared its own retryability keeps it', () => {
  // The table says TELEGRAM_UNAVAILABLE is retryable; this instance says it is
  // not. The instance wins — it knew something the table cannot.
  const err = new TelegramFileError('The local Bot API server refused the download', false);
  const c = classify(err);
  assert.equal(c.retryable, false, 'the error object is authoritative about its own retryability');
});

test('a throw site that wrote a user-facing message keeps it', () => {
  const err = new PipelineError('internal detail', '❌ That file contains no video stream.', false);
  const c = classify(err);
  assert.equal(c.userMessage, '❌ That file contains no video stream.');
  assert.equal(c.retryable, false);
});

test('the user message never carries internals and the admin message does', () => {
  const err = new Error('ECONNREFUSED 127.0.0.1:8081 while calling internal endpoint');
  (err as NodeJS.ErrnoException).code = 'ECONNREFUSED';
  const c = classify(err);

  assert.doesNotMatch(c.userMessage, /127\.0\.0\.1|ECONNREFUSED/, 'a user gets no internals');
  assert.match(c.adminMessage, /ECONNREFUSED/, 'an administrator gets the detail');
});

test('an unrecognised failure is retryable and flagged for a human', () => {
  const c = classify(new Error('something nobody anticipated'));
  assert.equal(c.code, 'UNKNOWN_ERROR');
  assert.equal(c.retryable, true, 'the safe default is to try again');
  assert.equal(c.severity, 'error');
});

test('null and undefined do not throw', () => {
  assert.equal(codeFor(null), 'UNKNOWN_ERROR');
  assert.equal(codeFor(undefined), 'UNKNOWN_ERROR');
  assert.equal(classify(null).code, 'UNKNOWN_ERROR');
});

test('every code has a complete rule', () => {
  for (const code of ERROR_CODES) {
    const c = classify(Object.assign(new Error('x'), { errorCode: code }));
    assert.equal(c.code, code, `${code} round-trips`);
    assert.ok(c.userMessage.length > 0, `${code} has a user message`);
    assert.ok(['expected', 'warning', 'error', 'critical'].includes(c.severity), `${code} has a severity`);
  }
});

test('only genuinely critical failures are alertable', () => {
  // Alerting on the ordinary — a duplicate, a quota refusal, a cancellation —
  // teaches people to ignore alerts.
  assert.equal(isAlertable('DUPLICATE_MEDIA'), false);
  assert.equal(isAlertable('QUOTA_EXCEEDED'), false);
  assert.equal(isAlertable('CANCELLED'), false);
  assert.equal(isAlertable('TMDB_NOT_FOUND'), false);

  assert.equal(isAlertable('DISK_FULL'), true);
  assert.equal(isAlertable('JELLYFIN_AUTH_FAILED'), true);
  assert.equal(isAlertable('DATABASE_ERROR'), true);
});
