import { stemOf } from '../lib/paths.js';

/**
 * Filename-based media identification.
 *
 * This is a *hypothesis* generator, never the final word. The worker feeds the
 * result to TMDB for confirmation and only falls back to the raw parse when
 * TMDB is unavailable or finds nothing.
 */

export interface ParsedMovie {
  kind: 'movie';
  title: string;
  year: number | null;
  /** 0-1; how much of the filename we could account for. */
  confidence: number;
}

export interface ParsedEpisode {
  kind: 'tv';
  title: string;
  year: number | null;
  season: number;
  /** First episode of the range. */
  episode: number;
  /** Populated for multi-episode files such as `S01E01E02` or `S01E01-E02`. */
  episodes: number[];
  episodeTitle: string | null;
  confidence: number;
}

export type ParseResult = ParsedMovie | ParsedEpisode;

/**
 * Release-scene noise. Everything from the first match onwards is usually
 * technical metadata rather than part of the title.
 */
const NOISE_TOKENS = [
  '2160p', '1080p', '720p', '480p', '576p', '4k', 'uhd', 'hdr10plus', 'hdr10', 'hdr', 'sdr',
  'dolby.?vision', 'dv',
  'bluray', 'blu.?ray', 'bdrip', 'brrip', 'bdremux', 'remux', 'dvdrip', 'dvdscr', 'hdtv', 'pdtv',
  'webrip', 'web.?dl', 'web', 'hdrip', 'camrip', 'cam', 'ts', 'tc', 'r5', 'workprint',
  'x264', 'x265', 'h\\.?264', 'h\\.?265', 'hevc', 'avc', 'xvid', 'divx', 'vp9', 'av1', '10bit', '8bit',
  'aac', 'aac2', 'ac3', 'eac3', 'dts', 'dts.?hd', 'truehd', 'atmos', 'flac', 'mp3', 'opus',
  'ddp?5.1', 'dd5.1', 'ddp', '5\\.1', '7\\.1', '2\\.0',
  'dual.?audio', 'multi', 'subbed', 'dubbed', 'hardsub', 'softsub',
  'proper', 'repack', 'internal', 'limited', 'unrated', 'uncut', 'extended', 'remastered',
  'directors.?cut', 'theatrical', 'imax', 'complete',
  'amzn', 'nf', 'netflix', 'hulu', 'dsnp', 'disney', 'hmax', 'atvp', 'pcok', 'stan',
  'yify', 'yts', 'rarbg', 'evo', 'ettv', 'eztv', 'ntb', 'ion10', 'sparks', 'fgt', 'cmrg',
];

const NOISE_RE = new RegExp(`\\b(?:${NOISE_TOKENS.join('|')})\\b`, 'i');

/** A 4-digit year, anywhere in the name. Matched globally so we can choose. */
/**
 * The trailing boundary is a lookahead, not a consumed character.
 *
 * Consuming it meant two adjacent years could never both match: in
 * `2012.2009.1080p` the separator after `2012` was eaten, so the scan resumed
 * mid-`2009` and only ever saw one year. Titles that *are* years — 2012, 1917,
 * 1984 — were therefore parsed as their own release year, and the real one was
 * left in the title.
 */
const YEAR_RE = /(?:^|[^0-9])((?:19|20)\d{2})(?=[^0-9]|$)/g;

/** `1920x1080` is a resolution, not a release year. */
const RESOLUTION_AFTER_RE = /^\s*[x*]\s*\d{3,4}/i;

/** A year in parentheses, which release names use for the actual release year. */
const PAREN_YEAR_RE = /\(((?:19|20)\d{2})\)/;

/** Cinema predates 1888, and nothing here is released more than two years out. */
function isPlausibleReleaseYear(year: number): boolean {
  return year >= 1888 && year <= new Date().getFullYear() + 2;
}

interface YearMatch {
  year: number;
  index: number;
  length: number;
}

/**
 * Choose the release year from a filename.
 *
 * A parenthesised year wins outright. Otherwise the *last* plausible year wins,
 * so `Blade Runner 2049 (2017)` and `Blade Runner 2049 2017 1080p` both keep
 * 2049 in the title and read 2017 as the year, and a future-dated number like
 * 2049 is never mistaken for a release year on its own.
 */
function pickYear(text: string): YearMatch | null {
  const paren = text.match(PAREN_YEAR_RE);
  if (paren?.[1] && paren.index !== undefined) {
    const year = Number(paren[1]);
    if (isPlausibleReleaseYear(year)) {
      return { year, index: paren.index, length: paren[0].length };
    }
  }

  // The last plausible year wins: release names put the title first, so in
  // `2012 2009 1080p` the release year is the second one.
  let best: YearMatch | null = null;
  for (const m of text.matchAll(YEAR_RE)) {
    const raw = m[1];
    if (!raw || m.index === undefined) continue;
    const year = Number(raw);
    if (!isPlausibleReleaseYear(year)) continue;
    const index = m.index + m[0].indexOf(raw);
    if (RESOLUTION_AFTER_RE.test(text.slice(index + raw.length))) continue;
    best = { year, index, length: raw.length };
  }
  return best;
}

/**
 * Episode patterns, most specific first. Each must expose named groups
 * `season` and `ep`, and may expose `ep2` for a range.
 */
const EPISODE_PATTERNS: Array<{ re: RegExp; multi?: boolean }> = [
  // S01E01E02 / S01E01-E02 / S01E01-02
  { re: /\bs(?<season>\d{1,3})[\s._-]*e(?<ep>\d{1,4})(?:[\s._-]*(?:e|-)\s*(?<ep2>\d{1,4}))+/i, multi: true },
  // S01E01
  { re: /\bs(?<season>\d{1,3})[\s._-]*e(?<ep>\d{1,4})\b/i },
  // 1x01 / 01x01-02
  { re: /\b(?<season>\d{1,3})\s*x\s*(?<ep>\d{1,3})(?:\s*-\s*(?:\d{1,3}\s*x\s*)?(?<ep2>\d{1,3}))?\b/i, multi: true },
  // Season 1 Episode 2
  { re: /\bseason[\s._-]*(?<season>\d{1,3})[\s._-]*episode[\s._-]*(?<ep>\d{1,4})\b/i },
  // S01.E01
  { re: /\bs(?<season>\d{1,3})[\s._-]+ep?(?<ep>\d{1,4})\b/i },
  // 3-digit / 4-digit compact form: 101 -> S01E01. Deliberately last and only
  // accepted when clearly delimited, because it collides with resolutions and
  // years constantly.
  { re: /(?:^|[\s._-])(?<season>[1-9])(?<ep>\d{2})(?:[\s._-]|$)/ },
];

/** Turn dots/underscores into spaces and collapse whitespace. */
function normalizeSeparators(input: string): string {
  return input
    .replace(/[._]+/g, ' ')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip bracketed groups such as `[YTS.MX]` or `(1080p)`. */
function stripBracketed(input: string): string {
  return input
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\((?![^)]*\b(?:19|20)\d{2}\b)[^)]*\)/g, ' ');
}

function titleCase(input: string): string {
  const small = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs']);
  const words = input.split(' ').filter(Boolean);
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      // Leave acronyms and stylised casing alone.
      if (/^[A-Z0-9]{2,}$/.test(w)) return w;
      if (i !== 0 && i !== words.length - 1 && small.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function cleanTitle(raw: string): string {
  let t = normalizeSeparators(stripBracketed(raw));
  // Drop everything from the first release-noise token onwards.
  const noise = t.match(NOISE_RE);
  if (noise && noise.index !== undefined && noise.index > 0) t = t.slice(0, noise.index);
  t = t
    .replace(/\((?:19|20)\d{2}\)/g, ' ')
    .replace(/[-\s]+$/g, '')
    .replace(/^[-\s]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return titleCase(t);
}

function toInt(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a filename into a movie or episode hypothesis.
 *
 * Order matters: an episode marker anywhere in the name beats a year, because
 * `Breaking.Bad.2008.S01E01.mkv` is an episode, not a 2008 film.
 */
export function parseFilename(filename: string): ParseResult {
  const stem = stemOf(String(filename ?? ''));
  const normalized = normalizeSeparators(stripBracketed(stem));

  for (const { re, multi } of EPISODE_PATTERNS) {
    const m = normalized.match(re);
    if (!m?.groups) continue;

    const season = toInt(m.groups['season']);
    const episode = toInt(m.groups['ep']);
    if (season === null || episode === null) continue;
    // Season 0 is legitimate (specials); episode 0 is not.
    if (season > 100 || episode < 1 || episode > 999) continue;

    const before = normalized.slice(0, m.index ?? 0);
    const after = normalized.slice((m.index ?? 0) + m[0].length);

    const showTitle = cleanTitle(before);
    // Without a title before the marker the parse is not trustworthy.
    if (!showTitle) continue;

    const episodes = [episode];
    if (multi) {
      const end = toInt(m.groups['ep2']);
      if (end !== null && end > episode && end - episode < 30) {
        for (let i = episode + 1; i <= end; i += 1) episodes.push(i);
      }
      // `S01E01E02E03` style: collect every trailing E-number.
      const chain = m[0].match(/e(\d{1,4})/gi);
      if (chain && chain.length > 1) {
        for (const c of chain) {
          const n = toInt(c.slice(1));
          if (n !== null && !episodes.includes(n)) episodes.push(n);
        }
      }
    }
    episodes.sort((a, b) => a - b);

    const episodeTitle = cleanTitle(after) || null;

    // `Breaking.Bad.2008.S01E01` names the show's first-air year, which belongs
    // in `year` rather than in the show title.
    const trailingYear = showTitle.match(/^(.*?)[\s(]+((?:19|20)\d{2})\)?$/);
    const yearFromTitle =
      trailingYear?.[2] && isPlausibleReleaseYear(Number(trailingYear[2]))
        ? Number(trailingYear[2])
        : null;

    return {
      kind: 'tv',
      title: yearFromTitle && trailingYear?.[1] ? trailingYear[1].trim() : showTitle,
      year: yearFromTitle,
      season,
      episode: episodes[0] ?? episode,
      episodes,
      episodeTitle,
      // Compact `101` form is a guess; explicit SxxExx is not.
      confidence: /s\d{1,3}[\s._-]*e\d/i.test(m[0]) ? 0.9 : 0.6,
    };
  }

  // No episode marker: treat as a movie.
  const yearMatch = pickYear(normalized);
  const year = yearMatch?.year ?? null;
  const beforeYear = yearMatch ? normalized.slice(0, yearMatch.index) : normalized;

  const title = cleanTitle(beforeYear) || cleanTitle(normalized) || stem;

  return {
    kind: 'movie',
    title,
    year,
    // A name that is not a title is not made one by a year beside it — a
    // phone's `Screen Recording 2024-09-01` carries a date, not a release.
    confidence: looksLikeNoTitle(title) ? 0.3 : year !== null && title.length > 1 ? 0.8 : 0.4,
  };
}

/**
 * Names that are not titles: a phone's `video.mp4` or `IMG_2041.mov`, a bare
 * number, a single character. A year-less parse of one of these is scored
 * below the quarantine threshold, so the file is parked for a person rather
 * than filed — or, worse, matched against a search index that will return
 * *some* film for any word at all.
 */
const GENERIC_STEMS = new Set([
  'video', 'movie', 'film', 'untitled', 'clip', 'vid', 'output', 'final', 'render', 'new',
  'download', 'file', 'sample', 'trailer', 'test', 'export', 'recording', 'screen recording',
  'capture', 'temp', 'tmp', 'copy', 'media', 'unknown', 'noname', 'my video', 'my movie',
]);

export function looksLikeNoTitle(title: string): boolean {
  const t = title.trim().toLowerCase();
  if (t.length <= 1) return true;
  if (/^\d+$/.test(t)) return true;
  if (GENERIC_STEMS.has(t)) return true;
  if (GENERIC_STEMS.has(t.replace(/[\s_-]*\(?\d+\)?$/, '').trim())) return true; // video 2, clip (3)
  // Camera and messenger exports: IMG_2041, VID_20240901_183000, MOV0012,
  // DSC00123, PXL_20240901_1830, 20240901_183000, GH010203, DJI_0042.
  if (/^(img|vid|mov|dsc|dscn|pxl|gopr|gh|gx|dji|mvi|scr|screenshot|screen)[\s_-]*\d/.test(t)) return true;
  if (/^\d{8}[\s_-]*\d{4,6}$/.test(t)) return true;
  if (/^(whatsapp|telegram)[\s_-]*(video|image)/.test(t)) return true;
  return false;
}

/** `Interstellar (2014)` — the folder and file name Jellyfin expects for a film. */
export function movieFolderName(title: string, year: number | null): string {
  return year ? `${title} (${year})` : title;
}

/** `Breaking Bad - S02E03` — the file name Jellyfin expects for an episode. */
export function episodeFileName(show: string, season: number, episodes: number[]): string {
  const s = String(season).padStart(2, '0');
  const e = episodes.map((n) => `E${String(n).padStart(2, '0')}`).join('');
  return `${show} - S${s}${e}`;
}

/** `Season 02` — Jellyfin's expected season folder. */
export function seasonFolderName(season: number): string {
  return season === 0 ? 'Specials' : `Season ${String(season).padStart(2, '0')}`;
}
