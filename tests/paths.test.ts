import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  sanitizeSegment,
  sanitizeFilename,
  extensionOf,
  stemOf,
  safeJoin,
  isInside,
  assertInside,
  storageSlug,
  PathEscapeError,
} from '../src/lib/paths.js';

const ROOT = '/srv/media/movies';

test('sanitizeSegment strips separators and traversal', () => {
  assert.equal(sanitizeSegment('../../etc/passwd'), 'etc passwd');
  assert.equal(sanitizeSegment('..'), 'unnamed');
  assert.equal(sanitizeSegment('.'), 'unnamed');
  assert.equal(sanitizeSegment('....'), 'unnamed');
  assert.equal(sanitizeSegment('/absolute/path'), 'absolute path');
  assert.equal(sanitizeSegment('a\\b'), 'a b');
});

test('sanitizeSegment removes leading dots and dashes', () => {
  assert.equal(sanitizeSegment('.hidden'), 'hidden');
  assert.equal(sanitizeSegment('--rf'), 'rf');
});

test('sanitizeSegment neutralises shell metacharacters positionally', () => {
  // The characters survive as text; what matters is that they never reach a
  // shell and never introduce a path separator.
  const out = sanitizeSegment('movie; rm -rf ~ && echo $(whoami)');
  assert.ok(!out.includes('/'));
  assert.ok(!out.includes('\\'));
  assert.ok(!out.startsWith('.'));
});

test('sanitizeSegment drops control characters', () => {
  const out = sanitizeSegment('bad\u0000name\u001fhere');
  assert.ok(!/[\u0000-\u001f]/.test(out));
  assert.equal(out, 'bad name here');
});

test('sanitizeSegment escapes reserved device names', () => {
  assert.equal(sanitizeSegment('CON'), '_CON');
  assert.equal(sanitizeSegment('lpt1'), '_lpt1');
});

test('sanitizeSegment bounds the length', () => {
  const out = sanitizeSegment('x'.repeat(500));
  assert.ok(Buffer.byteLength(out, 'utf8') <= 200);
});

test('extensionOf and stemOf handle path-like filenames', () => {
  assert.equal(extensionOf('movie.MKV'), 'mkv');
  assert.equal(extensionOf('../../evil.mp4'), 'mp4');
  assert.equal(extensionOf('no-extension'), '');
  assert.equal(extensionOf('.bashrc'), '');
  assert.equal(stemOf('/tmp/Interstellar.2014.mkv'), 'Interstellar.2014');
});

test('sanitizeFilename keeps the extension and cleans the stem', () => {
  // Directory components are discarded outright, not flattened into the name.
  assert.equal(sanitizeFilename('../../../etc/shadow.mkv'), 'shadow.mkv');
  assert.equal(sanitizeFilename('Interstellar.2014.mkv'), 'Interstellar.2014.mkv');
});

test('safeJoin keeps traversal inside the root', () => {
  const p = safeJoin(ROOT, '../../../../etc', 'passwd');
  assert.ok(p.startsWith(ROOT + path.sep), `${p} escaped ${ROOT}`);
});

test('safeJoin rejects absolute-looking segments', () => {
  const p = safeJoin(ROOT, '/etc/passwd');
  assert.ok(p.startsWith(ROOT + path.sep));
  assert.equal(p, path.join(ROOT, 'etc', 'passwd'));
});

test('safeJoin handles encoded and mixed separators', () => {
  for (const attempt of [
    '..\\..\\windows\\system32',
    '....//....//etc',
    'a/../../../b',
    '.././.././root',
  ]) {
    const p = safeJoin(ROOT, attempt);
    assert.ok(p.startsWith(ROOT + path.sep), `${attempt} escaped to ${p}`);
  }
});

test('safeJoin builds the expected Jellyfin layout', () => {
  assert.equal(
    safeJoin(ROOT, 'alice', 'Interstellar (2014)', 'Interstellar (2014).mkv'),
    '/srv/media/movies/alice/Interstellar (2014)/Interstellar (2014).mkv',
  );
});

test('isInside distinguishes siblings from children', () => {
  assert.equal(isInside('/srv/media', '/srv/media/movies/a.mkv'), true);
  assert.equal(isInside('/srv/media', '/srv/media'), true);
  assert.equal(isInside('/srv/media', '/srv/media-other/a.mkv'), false);
  assert.equal(isInside('/srv/media', '/srv'), false);
});

test('assertInside throws for an outside path', () => {
  assert.throws(() => assertInside(ROOT, '/etc/passwd'), PathEscapeError);
  assert.equal(assertInside(ROOT, `${ROOT}/ok.mkv`), `${ROOT}/ok.mkv`);
});

test('storageSlug produces a safe directory name', () => {
  assert.equal(storageSlug('Alice'), 'alice');
  assert.equal(storageSlug('User Name!'), 'user-name');
  assert.equal(storageSlug('../etc'), 'etc');
  assert.equal(storageSlug(''), 'user');
  assert.ok(!storageSlug('a'.repeat(200)).includes('/'));
});
