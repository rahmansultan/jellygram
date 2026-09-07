import './helpers/test-media-root.js';
import './helpers/test-credentials.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { explainStartupFailure } from '../src/lib/startup.js';

/**
 * The startup explainer exists so that the three boring first-run failures —
 * no database, an unwritable media root, a taken port — read as instructions
 * rather than as a pino record with a stack trace in it.
 *
 * What matters is that each recognised cause names the setting the reader has
 * to change, and that an unrecognised cause produces nothing at all. Advice
 * invented for an error nobody classified is worse than no advice: it sends
 * somebody to edit a variable that was never the problem.
 */

/** Shaped like the errors `pg` and `fs` actually throw. */
function sysError(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(code), { code, ...extra });
}

test('a refused database connection names the address and DATABASE_URL', () => {
  const advice = explainStartupFailure(
    sysError('ECONNREFUSED', { address: '127.0.0.1', port: 5432 }),
  );
  assert.ok(advice, 'ECONNREFUSED should be recognised');
  assert.match(advice, /127\.0\.0\.1:5432/);
  assert.match(advice, /DATABASE_URL/);
});

test('an unresolvable database host points at the connection string, not the network', () => {
  const advice = explainStartupFailure(sysError('EAI_AGAIN', { hostname: 'base' }));
  assert.ok(advice);
  assert.match(advice, /base/);
  assert.match(advice, /DATABASE_URL/);
});

test('a rejected password explains the volume that keeps the old one', () => {
  const advice = explainStartupFailure(sysError('28P01'));
  assert.ok(advice);
  assert.match(advice, /POSTGRES_PASSWORD/);
});

test('a missing database is distinguished from an unreachable server', () => {
  const advice = explainStartupFailure(sysError('3D000'));
  assert.ok(advice);
  assert.match(advice, /does not exist/);
});

test('an unwritable directory names the path and the settings that produce it', () => {
  const advice = explainStartupFailure(sysError('EACCES', { path: '/srv/media' }));
  assert.ok(advice);
  assert.match(advice, /\/srv\/media/);
  assert.match(advice, /MEDIA_ROOT/);
});

test('a missing parent directory suggests the unmounted drive, not a permission fix', () => {
  const advice = explainStartupFailure(sysError('ENOENT', { path: '/mnt/media/movies' }));
  assert.ok(advice);
  assert.match(advice, /not mounted/);
});

test('a taken port names ADMIN_PORT', () => {
  const advice = explainStartupFailure(
    sysError('EADDRINUSE', { address: '127.0.0.1', port: 8300 }),
  );
  assert.ok(advice);
  assert.match(advice, /ADMIN_PORT/);
  assert.match(advice, /8300/);
});

test('a filesystem error with no path gets no invented advice', () => {
  // EACCES from something that is not a directory creation carries no `path`,
  // and there is nothing useful to say about it.
  assert.equal(explainStartupFailure(sysError('EACCES')), null);
});

test('an unrecognised failure produces nothing rather than a guess', () => {
  assert.equal(explainStartupFailure(new Error('something else entirely')), null);
  assert.equal(explainStartupFailure(sysError('ESOMETHINGNEW')), null);
  assert.equal(explainStartupFailure(null), null);
  assert.equal(explainStartupFailure('a string'), null);
});
