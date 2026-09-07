import { config } from '../config/index.js';
import { getLogger } from '../lib/logger.js';

/**
 * Thin TMDB client used to confirm or correct a filename parse.
 *
 * Every call is best-effort: TMDB being unreachable, rate-limited or
 * unconfigured degrades identification to the filename parse rather than
 * failing the upload.
 */

const BASE = 'https://api.themoviedb.org/3';
const TIMEOUT_MS = 12_000;

export interface TmdbMovie {
  tmdbId: number;
  title: string;
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
}

export interface TmdbShow {
  tmdbId: number;
  name: string;
  originalName: string | null;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
}

export interface TmdbEpisode {
  name: string | null;
  overview: string | null;
  airDate: string | null;
}

/** Simple in-process cache; media titles repeat a lot within one session. */
const cache = new Map<string, { at: number; value: unknown }>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

async function request<T>(path: string, params: Record<string, string | number | undefined>): Promise<T | null> {
  if (!config.tmdb.configured) return null;

  const url = new URL(BASE + path);
  url.searchParams.set('language', config.tmdb.language);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const cacheKey = url.toString();
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // v4 bearer tokens are long JWTs; v3 keys are 32 hex characters.
        ...(config.tmdb.apiKey.length > 40
          ? { Authorization: `Bearer ${config.tmdb.apiKey}` }
          : {}),
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      getLogger().warn({ status: res.status, path }, 'TMDB request failed');
      return null;
    }
    const value = (await res.json()) as T;
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (err) {
    getLogger().warn({ err, path }, 'TMDB request errored');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** v3 keys travel as a query parameter rather than a bearer header. */
function withKey(params: Record<string, string | number | undefined>) {
  return config.tmdb.apiKey.length > 40 ? params : { ...params, api_key: config.tmdb.apiKey };
}

interface SearchResponse<T> {
  results?: T[];
}

export async function searchMovie(title: string, year: number | null): Promise<TmdbMovie | null> {
  const data = await request<SearchResponse<Record<string, unknown>>>(
    '/search/movie',
    withKey({ query: title, year: year ?? undefined, include_adult: 'false' }),
  );
  const first = data?.results?.[0];
  if (!first) return null;

  const release = typeof first['release_date'] === 'string' ? (first['release_date'] as string) : '';
  return {
    tmdbId: Number(first['id']),
    title: String(first['title'] ?? title),
    originalTitle: (first['original_title'] as string) ?? null,
    year: release ? Number(release.slice(0, 4)) : year,
    overview: (first['overview'] as string) || null,
    posterPath: (first['poster_path'] as string) || null,
  };
}

export async function searchShow(name: string, year: number | null): Promise<TmdbShow | null> {
  const data = await request<SearchResponse<Record<string, unknown>>>(
    '/search/tv',
    withKey({ query: name, first_air_date_year: year ?? undefined, include_adult: 'false' }),
  );
  const first = data?.results?.[0];
  if (!first) return null;

  const air = typeof first['first_air_date'] === 'string' ? (first['first_air_date'] as string) : '';
  return {
    tmdbId: Number(first['id']),
    name: String(first['name'] ?? name),
    originalName: (first['original_name'] as string) ?? null,
    year: air ? Number(air.slice(0, 4)) : year,
    overview: (first['overview'] as string) || null,
    posterPath: (first['poster_path'] as string) || null,
  };
}

export async function getEpisode(
  showId: number,
  season: number,
  episode: number,
): Promise<TmdbEpisode | null> {
  const data = await request<Record<string, unknown>>(
    `/tv/${showId}/season/${season}/episode/${episode}`,
    withKey({}),
  );
  if (!data || data['id'] === undefined) return null;
  return {
    name: (data['name'] as string) || null,
    overview: (data['overview'] as string) || null,
    airDate: (data['air_date'] as string) || null,
  };
}

/** Round-trip check used by the dashboard's "TMDB connection" indicator. */
export async function checkTmdb(): Promise<{ ok: boolean; message: string }> {
  if (!config.tmdb.configured) return { ok: false, message: 'TMDB_API_KEY is not set' };
  const data = await request<Record<string, unknown>>('/configuration', withKey({}));
  return data
    ? { ok: true, message: 'Connected' }
    : { ok: false, message: 'TMDB did not answer or rejected the key' };
}
