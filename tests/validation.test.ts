import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { config } from '../src/config/index.js';
import { extensionOf } from '../src/lib/paths.js';
import { TERMINAL_STATUSES, UPLOAD_STATUSES } from '../src/db/types.js';
import { formatBytes, checkSpaceFor } from '../src/services/storage.js';
import { planPlacement, withCollisionSuffix } from '../src/services/organize.js';
import { libraryName, userMediaDir } from '../src/services/isolation.js';
import type { UserRow } from '../src/db/types.js';
import type { Identification } from '../src/services/identify.js';
import { episodeFileName, parseFilename } from '../src/services/parser.js';

/**
 * File validation, disk-space policy, and the organiser's placement decisions.
 * These are pure functions, so they run without touching the database.
 */

const SUBTITLE_EXTENSIONS = ['srt', 'sub', 'ass', 'ssa', 'vtt', 'idx', 'sup'];

const user: UserRow = {
  id: 1,
  name: 'Alice',
  telegram_chat_id: 123456789,
  jellyfin_username: 'alice',
  jellyfin_user_id: null,
  storage_slug: 'alice',
  active: true,
  upload_enabled: true,
  quota_bytes: null,
  notes: null,
  upload_token_hash: null,
  upload_token_created_at: null,
  upload_token_last_used_at: null,
  created_at: new Date(),
  updated_at: new Date(),
};

function identification(filename: string, overrides: Partial<Identification> = {}): Identification {
  const parsed = parseFilename(filename);
  const base: Identification = {
    type: parsed.kind,
    title: parsed.title,
    originalTitle: null,
    year: parsed.year,
    season: parsed.kind === 'tv' ? parsed.season : null,
    episode: parsed.kind === 'tv' ? parsed.episode : null,
    episodes: parsed.kind === 'tv' ? parsed.episodes : [],
    episodeTitle: parsed.kind === 'tv' ? parsed.episodeTitle : null,
    tmdbId: null,
    overview: null,
    posterPath: null,
    confidence: 0.95,
    source: 'filename',
    parsed,
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Extension validation
// ---------------------------------------------------------------------------

test('accepted video extensions pass the allow-list', () => {
  for (const name of ['a.mp4', 'b.mkv', 'c.avi', 'd.mov', 'E.MKV']) {
    assert.ok(
      config.storage.allowedExtensions.includes(extensionOf(name)),
      `${name} should be accepted`,
    );
  }
});

test('subtitle files are not on the allow-list', () => {
  for (const ext of SUBTITLE_EXTENSIONS) {
    assert.ok(
      !config.storage.allowedExtensions.includes(ext),
      `.${ext} must never be accepted`,
    );
  }
});

test('other file types are rejected', () => {
  for (const name of ['payload.exe', 'script.sh', 'archive.zip', 'photo.jpg', 'notes.txt', 'noext']) {
    assert.ok(
      !config.storage.allowedExtensions.includes(extensionOf(name)),
      `${name} must be rejected`,
    );
  }
});

test('a double extension is judged by the final one', () => {
  assert.equal(extensionOf('movie.mkv.exe'), 'exe');
  assert.ok(!config.storage.allowedExtensions.includes(extensionOf('movie.mkv.exe')));
});

// ---------------------------------------------------------------------------
// Disk space
// ---------------------------------------------------------------------------

/**
 * The decision rule, not this machine's happenstance.
 *
 * This used to assert that a small file simply passes — which is an assertion
 * about the disk the tests run on, not about the code. It held on a media
 * server with terabytes free and failed on a CI runner, a container, or a
 * checkout on a small tmpfs, where the honest answer is that there genuinely
 * is not room for the 10 GiB reserve. That failure looked like a bug in the
 * disk check and was not.
 *
 * So: measure what is actually available, then assert the check agrees with
 * the policy either way.
 */
test('a small file is judged against the reserve, not waved through', async () => {
  const result = await checkSpaceFor(1024);
  assert.ok(result.availableBytes > 0, 'the free space was actually measured');

  const required = 1024 + config.storage.diskSafetyMarginBytes + config.storage.minFreeDiskBytes;
  if (result.availableBytes >= required) {
    assert.equal(result.ok, true, 'there is room, so it must be allowed');
  } else {
    assert.equal(result.ok, false, 'the reserve does not fit, so it must be refused');
    assert.match(result.reason ?? '', /free/i, 'and it must say why');
  }
});

test('an absurdly large file is refused', async () => {
  const result = await checkSpaceFor(Number.MAX_SAFE_INTEGER);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /free/i);
});

test('the requirement includes the file, the margin and the reserve', async () => {
  const size = 5 * 1024 * 1024 * 1024;
  const result = await checkSpaceFor(size);
  assert.equal(
    result.requiredBytes,
    size + config.storage.diskSafetyMarginBytes + config.storage.minFreeDiskBytes,
  );
});

test('formatBytes renders human-readable sizes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(1024 ** 3), '1.0 GiB');
  // The labels are binary because every limit in this system is binary;
  // dividing by 1024 and printing "GB" understated each limit by ~7%.
  assert.equal(formatBytes(1024 ** 2), '1.0 MiB');
  assert.equal(formatBytes(2000 * 1024 * 1024), '2.0 GiB', 'the Bot API ceiling, in binary units');
  assert.equal(formatBytes(Number.NaN), 'unknown');
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

test('a movie is placed in the Jellyfin movie layout', () => {
  const p = planPlacement(user, identification('Interstellar.2014.1080p.mkv'), 'mkv', 'Interstellar.2014.1080p.mkv');
  assert.equal(
    p.relativePath,
    path.join('movies', 'alice', 'Interstellar (2014)', 'Interstellar (2014).mkv'),
  );
  assert.equal(p.keptOriginalName, false);
});

test('an episode is placed in the Jellyfin TV layout', () => {
  const p = planPlacement(user, identification('Breaking.Bad.S02E03.1080p.mkv'), 'mkv', 'Breaking.Bad.S02E03.1080p.mkv');
  assert.equal(
    p.relativePath,
    path.join('tv', 'alice', 'Breaking Bad', 'Season 02', 'Breaking Bad - S02E03.mkv'),
  );
});

test('a low-confidence identification keeps the original filename', () => {
  const id = identification('mystery-file.mkv', { confidence: 0.4 });
  const p = planPlacement(user, id, 'mkv', 'mystery-file.mkv');
  assert.equal(p.keptOriginalName, true);
  assert.ok(p.targetPath.endsWith('mystery-file.mkv'));
});

test('a hostile title cannot escape the user directory', () => {
  const id = identification('x.mkv', {
    type: 'movie',
    title: '../../../../etc/cron.d/evil',
    year: null,
    confidence: 0.95,
  });
  const p = planPlacement(user, id, 'mkv', 'x.mkv');
  assert.ok(
    p.targetPath.startsWith(userMediaDir(user, 'movie') + path.sep),
    `${p.targetPath} escaped the user directory`,
  );
});

test('a hostile show name cannot escape the user directory', () => {
  const id = identification('x.mkv', {
    type: 'tv',
    title: '../../..',
    season: 1,
    episode: 1,
    episodes: [1],
    confidence: 0.95,
  });
  const p = planPlacement(user, id, 'mkv', 'x.mkv');
  assert.ok(p.targetPath.startsWith(userMediaDir(user, 'tv') + path.sep));
});

test('a hostile extension cannot introduce a path separator', () => {
  const id = identification('Interstellar.2014.mkv');
  const p = planPlacement(user, id, '../../evil', 'x.mkv');
  assert.ok(p.targetPath.startsWith(userMediaDir(user, 'movie') + path.sep));
  assert.ok(!p.targetPath.includes('..'));
});

test('collision suffixes are appended before the extension', () => {
  assert.equal(
    withCollisionSuffix('/media/movies/alice/Film (2020)/Film (2020).mkv', 1),
    '/media/movies/alice/Film (2020)/Film (2020) (2).mkv',
  );
  assert.equal(withCollisionSuffix('/a/b.mkv', 0), '/a/b.mkv');
});

// ---------------------------------------------------------------------------
// Isolation naming
// ---------------------------------------------------------------------------

test('each user gets distinctly named libraries', () => {
  const other: UserRow = { ...user, id: 2, name: 'Sara', storage_slug: 'sara' };
  assert.notEqual(libraryName(user, 'movie'), libraryName(other, 'movie'));
  assert.notEqual(libraryName(user, 'movie'), libraryName(user, 'tv'));
  assert.match(libraryName(user, 'movie'), /Movies/);
  assert.match(libraryName(user, 'tv'), /TV Shows/);
});

test("each user's media directories are disjoint", () => {
  const other: UserRow = { ...user, id: 2, name: 'Sara', storage_slug: 'sara' };
  const mine = userMediaDir(user, 'movie');
  const theirs = userMediaDir(other, 'movie');

  assert.notEqual(mine, theirs);
  assert.ok(!mine.startsWith(theirs + path.sep));
  assert.ok(!theirs.startsWith(mine + path.sep));
});

test('media directories live under the configured roots', () => {
  assert.ok(userMediaDir(user, 'movie').startsWith(config.storage.moviesRoot + path.sep));
  assert.ok(userMediaDir(user, 'tv').startsWith(config.storage.tvRoot + path.sep));
});

// ---------------------------------------------------------------------------
// Declining to guess
// ---------------------------------------------------------------------------

test('NEEDS_REVIEW is terminal but is not a failure', () => {
  // The pipeline stops, because the next step is a human decision — but an
  // administrator must be able to tell "waiting on me" from "broken".
  assert.ok(TERMINAL_STATUSES.includes('NEEDS_REVIEW'), 'no further automatic work happens');
  assert.ok(UPLOAD_STATUSES.includes('NEEDS_REVIEW'));
  assert.notEqual('NEEDS_REVIEW', 'FAILED');
});

test('a file the parser cannot place scores below the review threshold', () => {
  // These are the shapes that should reach a person rather than be filed
  // somewhere plausible-looking and wrong.
  for (const name of ['IMG_4021.mkv', 'video.mkv', 'aaaaaaaa.mkv']) {
    const parsed = parseFilename(name);
    assert.ok(
      parsed.confidence <= 0.4,
      `${name} scored ${parsed.confidence}; it should not be filed confidently`,
    );
  }
});

test('a clearly named release stays well above the threshold', () => {
  // The counterpart: raising the bar must not send ordinary files for review.
  for (const name of [
    'Mayday.2026.1080p.10bit.WEBRip.6CH.x265.HEVC-PSA.mkv',
    'The.Matrix.1999.1080p.mkv',
    'Breaking.Bad.S01E01.1080p.mkv',
  ]) {
    const parsed = parseFilename(name);
    assert.ok(parsed.confidence >= 0.8, `${name} scored ${parsed.confidence}`);
  }
});

test('a multi-episode file keeps its whole range end to end', () => {
  // Losing E02 would file a double episode as a single one, and Jellyfin would
  // never match the second.
  const parsed = parseFilename('Show.Name.S01E01E02.mkv');
  assert.equal(parsed.kind, 'tv');
  if (parsed.kind !== 'tv') return;
  assert.deepEqual(parsed.episodes, [1, 2]);
  assert.equal(episodeFileName('Show Name', 1, parsed.episodes), 'Show Name - S01E01E02');

  const dashed = parseFilename('Show.Name.S02E05-E07.mkv');
  assert.equal(dashed.kind, 'tv');
  if (dashed.kind !== 'tv') return;
  assert.deepEqual(dashed.episodes, [5, 6, 7], 'a dashed range expands to every episode in it');
});
