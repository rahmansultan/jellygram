import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLogger } from '../lib/logger.js';
import { config } from '../config/index.js';
import { parseFilename, type ParseResult } from './parser.js';
import * as tmdb from './tmdb.js';

const execFileAsync = promisify(execFile);

/**
 * Media identification.
 *
 * The filename is only a hypothesis. Where TMDB is configured its answer wins,
 * because release names lie constantly about titles and years. Where it is
 * not, we fall back to the parse and say so, and the caller decides whether
 * confidence is high enough to file the media or to quarantine it.
 */

export interface Identification {
  type: 'movie' | 'tv';
  title: string;
  originalTitle: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
  episodes: number[];
  episodeTitle: string | null;
  tmdbId: number | null;
  overview: string | null;
  posterPath: string | null;
  /** 0-1. Below `MIN_CONFIDENCE` the file is quarantined rather than filed. */
  confidence: number;
  source: 'tmdb' | 'filename';
  parsed: ParseResult;
}

/** Below this we refuse to guess and quarantine the file instead. */
export const MIN_CONFIDENCE = 0.35;

/** ffprobe ships with Jellyfin; fall back to a system ffprobe if present. */
const FFPROBE_CANDIDATES = ['/usr/lib/jellyfin-ffmpeg/ffprobe', '/usr/bin/ffprobe', 'ffprobe'];

export interface ProbeResult {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  container: string | null;
  isVideo: boolean;
}

/**
 * Inspect the actual container rather than trusting the extension.
 *
 * `execFile` (not `exec`) with an argument array means the path is passed as a
 * single argv entry and never reaches a shell, so a filename containing `;`
 * or backticks is inert.
 */
export async function probeFile(filePath: string): Promise<ProbeResult | null> {
  for (const bin of FFPROBE_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(
        bin,
        [
          '-v', 'error',
          '-print_format', 'json',
          '-show_format',
          '-show_streams',
          '--',
          filePath,
        ],
        { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
      );

      const data = JSON.parse(stdout) as {
        format?: { duration?: string; format_name?: string };
        streams?: Array<Record<string, unknown>>;
      };

      const video = (data.streams ?? []).find((s) => s['codec_type'] === 'video');
      return {
        durationSec: data.format?.duration ? Number(data.format.duration) : null,
        width: video ? Number(video['width']) || null : null,
        height: video ? Number(video['height']) || null : null,
        videoCodec: video ? String(video['codec_name'] ?? '') || null : null,
        container: data.format?.format_name ?? null,
        isVideo: Boolean(video),
      };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      // Try the next candidate only when the binary itself is missing.
      if (code === 'ENOENT') continue;
      // ffprobe ran and could not read the file: that *is* the answer. A text
      // file renamed .mkv, or a truncated download, exits 1 with "Invalid data
      // found when processing input" — returning null here used to let exactly
      // those files through as if no probe had been possible.
      // A numeric code is ffprobe's own exit status; a string is the OS
      // failing to run it (or a timeout killing it), which says nothing about
      // the file and is reported as "no verdict" as before.
      if (typeof code === 'number' && !(err as { killed?: boolean }).killed) {
        getLogger().warn({ err, bin }, 'ffprobe could not read the file');
        return { durationSec: null, width: null, height: null, videoCodec: null, container: null, isVideo: false };
      }
      getLogger().warn({ err, bin }, 'ffprobe failed');
      return null;
    }
  }
  getLogger().debug('No ffprobe binary found; skipping container validation');
  return null;
}

/** Letters and digits only, lower-cased and unaccented, so titles compare by substance. */
function normaliseTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Whether a search hit is the title the filename named.
 *
 * Exported for tests. A leading article is forgiven on either side, and the
 * hit's original-language title counts too, since release names often use it.
 */
export function titlesAgree(parsed: string, ...candidates: Array<string | null | undefined>): boolean {
  const strip = (s: string) => normaliseTitle(s).replace(/^(the|a|an)(?=.)/, '');
  const wanted = normaliseTitle(parsed);
  if (!wanted) return false;
  const wantedLoose = strip(parsed);
  return candidates.some((c) => {
    if (!c) return false;
    const got = normaliseTitle(c);
    return got === wanted || strip(c) === wantedLoose;
  });
}

/**
 * Identify a file from its original Telegram filename, confirming against
 * TMDB when a key is configured.
 */
export async function identify(originalFilename: string): Promise<Identification> {
  const parsed = parseFilename(originalFilename);

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
    confidence: parsed.confidence,
    source: 'filename',
    parsed,
  };

  if (!config.tmdb.configured) return base;

  // A name the parser could not read as a title — `video.mp4`, `1.mkv`,
  // `IMG_2041.mov` — is not made into one by a search engine that always
  // answers. Asking TMDB for "video" returned a 1975 film with that word in
  // its title, at 0.95 confidence, and the file was renamed after it.
  if (parsed.confidence < MIN_CONFIDENCE) return base;

  try {
    if (parsed.kind === 'movie') {
      const hit = await tmdb.searchMovie(parsed.title, parsed.year);
      if (!hit) return base;
      // Without a year the search is a plain title match, and TMDB's best guess
      // for a short or generic title is often a different film that merely
      // contains the words. The hit is only trusted when its title actually
      // agrees with what the filename said.
      if (parsed.year === null && !titlesAgree(parsed.title, hit.title, hit.originalTitle)) {
        getLogger().info(
          { parsed: parsed.title, hit: hit.title, year: hit.year },
          'TMDB hit does not match the year-less title; keeping the filename parse',
        );
        return base;
      }
      return {
        ...base,
        title: hit.title,
        originalTitle: hit.originalTitle,
        year: hit.year ?? parsed.year,
        tmdbId: hit.tmdbId,
        overview: hit.overview,
        posterPath: hit.posterPath,
        // TMDB confirming a parse is the strongest signal we get.
        confidence: Math.max(parsed.confidence, 0.95),
        source: 'tmdb',
      };
    }

    const show = await tmdb.searchShow(parsed.title, parsed.year);
    if (!show) return base;
    if (parsed.year === null && !titlesAgree(parsed.title, show.name, show.originalName)) {
      getLogger().info(
        { parsed: parsed.title, hit: show.name },
        'TMDB show does not match the year-less title; keeping the filename parse',
      );
      return base;
    }

    const episodeInfo = await tmdb.getEpisode(show.tmdbId, parsed.season, parsed.episode);
    return {
      ...base,
      title: show.name,
      originalTitle: show.originalName,
      year: show.year ?? parsed.year,
      tmdbId: show.tmdbId,
      overview: episodeInfo?.overview ?? show.overview,
      posterPath: show.posterPath,
      // Only claim high confidence when TMDB actually knows this episode.
      episodeTitle: episodeInfo?.name ?? parsed.episodeTitle,
      confidence: episodeInfo ? Math.max(parsed.confidence, 0.95) : Math.max(parsed.confidence, 0.7),
      source: 'tmdb',
    };
  } catch (err) {
    getLogger().warn({ err }, 'TMDB lookup failed; using filename parse');
    return base;
  }
}
