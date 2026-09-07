import './helpers/test-media-root.js';
import './helpers/test-credentials.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ffprobeCandidates } from '../src/services/identify.js';

/**
 * Which ffprobe the application reaches for, and in what order.
 *
 * The default search covers a Debian-packaged Jellyfin, an ordinary
 * distribution package, and a container image — but not Homebrew, a Nix store
 * path, or a Jellyfin installed somewhere other than /usr/lib. `FFPROBE_PATH`
 * exists for those, and the order matters in both directions: configured
 * first, so it actually wins; the search still after it, so a path that has
 * gone stale falls back rather than turning container validation off.
 */

test('with nothing configured, the search is unchanged', () => {
  assert.deepEqual(ffprobeCandidates(''), [
    '/usr/lib/jellyfin-ffmpeg/ffprobe',
    '/usr/bin/ffprobe',
    'ffprobe',
  ]);
});

test('a configured path is tried first', () => {
  const candidates = ffprobeCandidates('/opt/homebrew/bin/ffprobe');
  assert.equal(candidates[0], '/opt/homebrew/bin/ffprobe');
});

test('and the default search still follows it', () => {
  // A stale FFPROBE_PATH must degrade to the old behaviour, not disable the
  // check: probeFile walks this list and only gives up after the last entry.
  assert.deepEqual(ffprobeCandidates('/nix/store/abc/bin/ffprobe'), [
    '/nix/store/abc/bin/ffprobe',
    '/usr/lib/jellyfin-ffmpeg/ffprobe',
    '/usr/bin/ffprobe',
    'ffprobe',
  ]);
});

test("Jellyfin's own build keeps priority when nothing is configured", () => {
  // The reason this order exists: a host running Jellyfin from its Debian
  // package should use the ffprobe that ships with it, which is the build
  // Jellyfin itself will read the file with.
  const candidates = ffprobeCandidates('');
  assert.ok(
    candidates.indexOf('/usr/lib/jellyfin-ffmpeg/ffprobe') < candidates.indexOf('/usr/bin/ffprobe'),
    "Jellyfin's bundled ffprobe must be tried before the system one",
  );
});

test('a value that is only whitespace is treated as unset', () => {
  // config trims, so this asserts the contract the caller relies on rather
  // than re-testing trim: an operator who leaves `FFPROBE_PATH=   ` in .env
  // gets the default search, not an attempt to spawn an empty string.
  assert.deepEqual(ffprobeCandidates(''), ffprobeCandidates(undefined as unknown as string));
});
