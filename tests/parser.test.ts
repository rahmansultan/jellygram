import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFilename,
  movieFolderName,
  episodeFileName,
  seasonFolderName,
} from '../src/services/parser.js';

test('movie: title and year from a release name', () => {
  const r = parseFilename('Interstellar.2014.1080p.BluRay.x264-YIFY.mkv');
  assert.equal(r.kind, 'movie');
  assert.equal(r.title, 'Interstellar');
  assert.equal(r.year, 2014);
  assert.ok(r.confidence >= 0.8);
});

test('movie: multi-word title with bracketed noise', () => {
  const r = parseFilename('The.Shawshank.Redemption.1994.2160p.UHD.BluRay.x265-TERMINAL[rarbg].mkv');
  assert.equal(r.kind, 'movie');
  assert.equal(r.title, 'The Shawshank Redemption');
  assert.equal(r.year, 1994);
});

test('movie: spaces and parenthesised year', () => {
  const r = parseFilename('Blade Runner 2049 (2017) 1080p WEB-DL.mp4');
  assert.equal(r.kind, 'movie');
  assert.equal(r.title, 'Blade Runner 2049');
  assert.equal(r.year, 2017);
});

test('movie: no year still yields a title', () => {
  const r = parseFilename('Some Random Movie.mkv');
  assert.equal(r.kind, 'movie');
  assert.equal(r.title, 'Some Random Movie');
  assert.equal(r.year, null);
});

test('tv: SxxExx form', () => {
  const r = parseFilename('Breaking.Bad.S02E03.1080p.mkv');
  assert.equal(r.kind, 'tv');
  if (r.kind !== 'tv') return;
  assert.equal(r.title, 'Breaking Bad');
  assert.equal(r.season, 2);
  assert.equal(r.episode, 3);
  assert.ok(r.confidence >= 0.9);
});

test('tv: NxNN form', () => {
  const r = parseFilename('The.Office.3x07.The.Merger.720p.mkv');
  assert.equal(r.kind, 'tv');
  if (r.kind !== 'tv') return;
  assert.equal(r.title, 'The Office');
  assert.equal(r.season, 3);
  assert.equal(r.episode, 7);
});

test('tv: "Season 1 Episode 2" form', () => {
  const r = parseFilename('Some Show Season 1 Episode 2.mp4');
  assert.equal(r.kind, 'tv');
  if (r.kind !== 'tv') return;
  assert.equal(r.season, 1);
  assert.equal(r.episode, 2);
});

test('tv: multi-episode SxxExxExx', () => {
  const r = parseFilename('Firefly.S01E01E02.1080p.mkv');
  assert.equal(r.kind, 'tv');
  if (r.kind !== 'tv') return;
  assert.deepEqual(r.episodes, [1, 2]);
});

test('tv: multi-episode range with a dash', () => {
  const r = parseFilename('Show.Name.S02E05-E07.mkv');
  assert.equal(r.kind, 'tv');
  if (r.kind !== 'tv') return;
  assert.deepEqual(r.episodes, [5, 6, 7]);
});

test('tv: episode marker wins over a year in the title', () => {
  const r = parseFilename('Breaking.Bad.2008.S01E01.720p.mkv');
  assert.equal(r.kind, 'tv');
  if (r.kind !== 'tv') return;
  assert.equal(r.title, 'Breaking Bad');
  assert.equal(r.season, 1);
  assert.equal(r.episode, 1);
});

test('tv: a resolution is not mistaken for an episode number', () => {
  const r = parseFilename('Some.Movie.2019.1080p.WEBRip.mkv');
  assert.equal(r.kind, 'movie');
});

test('tv: episode title is captured when present', () => {
  const r = parseFilename('Breaking.Bad.S01E01.Pilot.1080p.BluRay.mkv');
  assert.equal(r.kind, 'tv');
  if (r.kind !== 'tv') return;
  assert.equal(r.episodeTitle, 'Pilot');
});

test('naming helpers produce the Jellyfin layout', () => {
  assert.equal(movieFolderName('Interstellar', 2014), 'Interstellar (2014)');
  assert.equal(movieFolderName('Untitled', null), 'Untitled');
  assert.equal(episodeFileName('Breaking Bad', 2, [3]), 'Breaking Bad - S02E03');
  assert.equal(episodeFileName('Firefly', 1, [1, 2]), 'Firefly - S01E01E02');
  assert.equal(seasonFolderName(2), 'Season 02');
  assert.equal(seasonFolderName(0), 'Specials');
});

// ---------------------------------------------------------------------------
// Release-name shapes seen in production
// ---------------------------------------------------------------------------

test('the real Mayday release name parses to title and year', () => {
  const r = parseFilename('Mayday.2026.1080p.10bit.WEBRip.6CH.x265.HEVC-PSA.mkv');
  assert.equal(r.title, 'Mayday');
  assert.equal(r.year, 2026);
  assert.equal(r.kind, 'movie');
  // 10bit, 6CH, x265, HEVC and the release group must not leak into the title.
  assert.ok(!/10bit|6CH|x265|HEVC|PSA|WEBRip/i.test(r.title));
});

test('codec, channel and HDR tags never reach the title', () => {
  for (const name of [
    'Supergirl.2026.2160p.HDR10Plus.DV.WEBRip.6CH.x265-PSA.mkv',
    'The.Runner.2026.1080p.WEB-DL.x264.6CH-Pahe.in.mkv',
    'Some.Film.2021.1080p.BluRay.DDP5.1.Atmos.x264-GROUP.mkv',
  ]) {
    const r = parseFilename(name);
    assert.ok(
      !/\b(2160p|1080p|WEB-?DL|WEBRip|BluRay|x26[45]|HEVC|HDR\w*|DV|DDP?5|Atmos|6CH|10bit)\b/i.test(r.title),
      `tag leaked into title for ${name}: ${r.title}`,
    );
  }
});

/**
 * A title that is itself a year.
 *
 * `YEAR_RE` used to consume the separator after a match, so in `2012.2009` the
 * scan resumed mid-`2009` and only ever saw one year — the "last year wins"
 * rule could never fire, and the release year stayed glued to the title.
 */
test('a film whose title is a year keeps the title and takes the later year', () => {
  const a = parseFilename('2012.2009.1080p.BluRay.x264.mkv');
  assert.equal(a.title, '2012');
  assert.equal(a.year, 2009);

  const b = parseFilename('1917.2019.1080p.mkv');
  assert.equal(b.title, '1917');
  assert.equal(b.year, 2019);
});

test('a resolution is not mistaken for a release year', () => {
  const r = parseFilename('Mayday.2026.1920x1080.HEVC.mkv');
  assert.equal(r.title, 'Mayday');
  assert.equal(r.year, 2026, '1920 is a resolution, not the release year');
});

test('a parenthesised year still wins over a year inside the title', () => {
  const r = parseFilename('Blade Runner 2049 (2017).mkv');
  assert.equal(r.title, 'Blade Runner 2049');
  assert.equal(r.year, 2017);
});
