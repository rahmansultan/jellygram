import { config } from '../config/index.js';
import { getLogger } from '../lib/logger.js';

/**
 * Jellyfin Server API client.
 *
 * Only the endpoints this application needs are wrapped. The API key never
 * leaves this module: callers get plain objects, and the dashboard never sees
 * the token.
 */

export class JellyfinError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'JellyfinError';
  }
}

export interface JellyfinUser {
  id: string;
  name: string;
  isAdministrator: boolean;
  isDisabled: boolean;
  enableAllFolders: boolean;
  enabledFolders: string[];
}

export interface VirtualFolder {
  name: string;
  itemId: string;
  collectionType: string | null;
  locations: string[];
}

export interface JellyfinItem {
  id: string;
  name: string;
  type: string;
  path: string | null;
  seriesName?: string | null;
  parentIndexNumber?: number | null;
  indexNumber?: number | null;
}

const TIMEOUT_MS = 30_000;

function requireKey(): string {
  if (!config.jellyfin.apiKey) {
    throw new JellyfinError('JELLYFIN_API_KEY is not configured. Run `npm run jellyfin:bootstrap`.');
  }
  return config.jellyfin.apiKey;
}

async function call<T>(
  method: string,
  pathname: string,
  options: {
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    /** Allow an unauthenticated call (only /System/Info/Public). */
    anonymous?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const url = new URL(config.jellyfin.url + pathname);
  for (const [k, v] of Object.entries(options.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (!options.anonymous) headers['Authorization'] = `MediaBrowser Token="${requireKey()}"`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new JellyfinError(
        `Jellyfin ${method} ${pathname} failed: ${res.status} ${res.statusText} ${text.slice(0, 300)}`,
        res.status,
      );
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Public server info; works without an API key and is used for health checks. */
export async function serverInfo(): Promise<{ serverName: string; version: string; id: string }> {
  const data = await call<Record<string, unknown>>('GET', '/System/Info/Public', {
    anonymous: true,
    timeoutMs: 10_000,
  });
  return {
    serverName: String(data['ServerName'] ?? ''),
    version: String(data['Version'] ?? ''),
    id: String(data['Id'] ?? ''),
  };
}

export interface JellyfinStatus {
  reachable: boolean;
  authenticated: boolean;
  version: string | null;
  serverName: string | null;
  message: string;
}

/** Connection state shown on the dashboard. Never throws. */
export async function status(): Promise<JellyfinStatus> {
  let version: string | null = null;
  let serverName: string | null = null;
  try {
    const info = await serverInfo();
    version = info.version;
    serverName = info.serverName;
  } catch (err) {
    return {
      reachable: false,
      authenticated: false,
      version: null,
      serverName: null,
      message: `Cannot reach ${config.jellyfin.url}: ${(err as Error).message}`,
    };
  }

  if (!config.jellyfin.apiKey) {
    return {
      reachable: true,
      authenticated: false,
      version,
      serverName,
      message: 'Reachable, but JELLYFIN_API_KEY is not set',
    };
  }

  try {
    await listUsers();
    return { reachable: true, authenticated: true, version, serverName, message: 'Connected' };
  } catch (err) {
    return {
      reachable: true,
      authenticated: false,
      version,
      serverName,
      message: `API key rejected: ${(err as Error).message}`,
    };
  }
}

function mapUser(raw: Record<string, unknown>): JellyfinUser {
  const policy = (raw['Policy'] ?? {}) as Record<string, unknown>;
  return {
    id: String(raw['Id']),
    name: String(raw['Name']),
    isAdministrator: Boolean(policy['IsAdministrator']),
    isDisabled: Boolean(policy['IsDisabled']),
    enableAllFolders: Boolean(policy['EnableAllFolders']),
    enabledFolders: Array.isArray(policy['EnabledFolders'])
      ? (policy['EnabledFolders'] as string[]).map(String)
      : [],
  };
}

export async function listUsers(): Promise<JellyfinUser[]> {
  const raw = await call<Record<string, unknown>[]>('GET', '/Users');
  return raw.map(mapUser);
}

export async function findUserByName(username: string): Promise<JellyfinUser | null> {
  const target = username.trim().toLowerCase();
  const users = await listUsers();
  return users.find((u) => u.name.toLowerCase() === target) ?? null;
}

export async function getUser(userId: string): Promise<JellyfinUser | null> {
  try {
    return mapUser(await call<Record<string, unknown>>('GET', `/Users/${encodeURIComponent(userId)}`));
  } catch (err) {
    if (err instanceof JellyfinError && err.status === 404) return null;
    throw err;
  }
}

export async function listVirtualFolders(): Promise<VirtualFolder[]> {
  const raw = await call<Record<string, unknown>[]>('GET', '/Library/VirtualFolders');
  return raw.map((f) => ({
    name: String(f['Name']),
    itemId: String(f['ItemId'] ?? ''),
    collectionType: (f['CollectionType'] as string) ?? null,
    locations: Array.isArray(f['Locations']) ? (f['Locations'] as string[]).map(String) : [],
  }));
}

/**
 * Create a library pointed at exactly one directory.
 *
 * One library per user per media type is what makes per-user isolation
 * possible: Jellyfin grants access at library granularity, not folder
 * granularity.
 */
export async function createLibrary(opts: {
  name: string;
  collectionType: 'movies' | 'tvshows';
  path: string;
}): Promise<void> {
  await call<void>('POST', '/Library/VirtualFolders', {
    query: {
      name: opts.name,
      collectionType: opts.collectionType,
      refreshLibrary: false,
    },
    body: {
      LibraryOptions: {
        PathInfos: [{ Path: opts.path }],
        EnableRealtimeMonitor: true,
        EnableChapterImageExtraction: false,
        SaveLocalMetadata: false,
        // The media tree is deliberately not writable by the Jellyfin account,
        // so an enabled NFO saver can only ever fail — Jellyfin's own default
        // for a movies library is `['Nfo']`, which logs a permission error on
        // every scan. Metadata *providers* are left at Jellyfin's defaults for
        // the admin to tune; only the savers are turned off.
        MetadataSavers: [],
      },
    },
  });
}

/**
 * Ask Jellyfin to pick up a file that was just placed on disk.
 *
 * `/Items/{id}/Refresh` re-reads metadata for items Jellyfin has already
 * indexed; it does not walk the folder looking for new ones, so on its own it
 * will never surface a newly filed movie. `/Library/Refresh` is the scan that
 * actually discovers files, and must always run. The targeted refresh is still
 * issued first when the library id is known: it is cheap and keeps the
 * library's own metadata current.
 */
export async function requestScan(libraryItemId: string | null): Promise<void> {
  if (libraryItemId) await refreshItem(libraryItemId);
  await refreshLibrary();
}

/**
 * Turn off local metadata savers for one library.
 *
 * Heals libraries created before `createLibrary` set `MetadataSavers`, and
 * libraries adopted from an existing Jellyfin configuration. Returns whether
 * anything actually changed.
 */
export async function disableLocalMetadataSavers(name: string): Promise<boolean> {
  const raw = await call<Record<string, unknown>[]>('GET', '/Library/VirtualFolders');
  const folder = raw.find((f) => String(f['Name']) === name);
  if (!folder) return false;

  const options = { ...((folder['LibraryOptions'] ?? {}) as Record<string, unknown>) };
  const savers = options['MetadataSavers'];
  if (Array.isArray(savers) && savers.length === 0 && options['SaveLocalMetadata'] === false) {
    return false;
  }

  options['MetadataSavers'] = [];
  options['SaveLocalMetadata'] = false;
  await call<void>('POST', '/Library/VirtualFolders/LibraryOptions', {
    body: { Id: String(folder['ItemId'] ?? ''), LibraryOptions: options },
  });
  return true;
}

export async function removeLibrary(name: string): Promise<void> {
  await call<void>('DELETE', '/Library/VirtualFolders', {
    query: { name, refreshLibrary: false },
  });
}

/**
 * Replace a user's library access list.
 *
 * `enableAllFolders: false` plus an explicit id list is the only configuration
 * in which Jellyfin actually hides other people's media.
 */
/** The libraries a Jellyfin account can currently see. */
export async function enabledFolders(userId: string): Promise<string[]> {
  const user = await call<Record<string, unknown>>('GET', `/Users/${encodeURIComponent(userId)}`);
  const policy = (user['Policy'] ?? {}) as Record<string, unknown>;
  const folders = policy['EnabledFolders'];
  return Array.isArray(folders) ? folders.map(String) : [];
}

export async function setUserLibraryAccess(
  userId: string,
  opts: { enableAllFolders: boolean; enabledFolders: string[] },
): Promise<void> {
  const user = await call<Record<string, unknown>>('GET', `/Users/${encodeURIComponent(userId)}`);
  const policy = { ...((user['Policy'] ?? {}) as Record<string, unknown>) };
  policy['EnableAllFolders'] = opts.enableAllFolders;
  policy['EnabledFolders'] = opts.enabledFolders;
  await call<void>('POST', `/Users/${encodeURIComponent(userId)}/Policy`, { body: policy });
}

/** Ask Jellyfin to rescan. Cheap; it does not restart the server. */
export async function refreshLibrary(): Promise<void> {
  await call<void>('POST', '/Library/Refresh');
}

/**
 * Refresh the metadata of one library and the items already inside it.
 *
 * This does NOT discover files added since the last scan — for that, the
 * caller must also run `refreshLibrary()`.
 */
export async function refreshItem(itemId: string): Promise<void> {
  await call<void>('POST', `/Items/${encodeURIComponent(itemId)}/Refresh`, {
    query: {
      Recursive: true,
      ImageRefreshMode: 'Default',
      MetadataRefreshMode: 'Default',
      ReplaceAllImages: false,
      ReplaceAllMetadata: false,
    },
  });
}

/**
 * Find the item Jellyfin created for a file we just placed on disk.
 * Used to verify that the media actually became visible.
 */
export async function findItemByPath(
  userId: string,
  filePath: string,
  searchTerm: string,
): Promise<JellyfinItem | null> {
  const data = await call<{ Items?: Record<string, unknown>[] }>('GET', '/Items', {
    query: {
      userId,
      recursive: true,
      searchTerm,
      includeItemTypes: 'Movie,Episode',
      fields: 'Path',
      limit: 50,
    },
  });

  for (const raw of data.Items ?? []) {
    if (String(raw['Path'] ?? '') === filePath) {
      return {
        id: String(raw['Id']),
        name: String(raw['Name']),
        type: String(raw['Type']),
        path: (raw['Path'] as string) ?? null,
        seriesName: (raw['SeriesName'] as string) ?? null,
        parentIndexNumber: (raw['ParentIndexNumber'] as number) ?? null,
        indexNumber: (raw['IndexNumber'] as number) ?? null,
      };
    }
  }
  return null;
}

/** Count items in one library, used for the per-user statistics. */
export async function countItems(
  userId: string,
  parentId: string,
  includeItemTypes: string,
): Promise<number> {
  const data = await call<{ TotalRecordCount?: number }>('GET', '/Items', {
    query: { userId, parentId, recursive: true, includeItemTypes, limit: 0 },
  });
  return data.TotalRecordCount ?? 0;
}

/**
 * Exchange an admin username and password for an API key.
 * Only used by the interactive bootstrap script.
 */
export async function createApiKeyWithPassword(
  username: string,
  password: string,
  appName: string,
): Promise<string> {
  const authHeader =
    `MediaBrowser Client="JellyGram", Device="setup", ` +
    `DeviceId="jellygram-bootstrap", Version="1.0.0"`;

  const authRes = await fetch(`${config.jellyfin.url}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify({ Username: username, Pw: password }),
  });
  if (!authRes.ok) {
    throw new JellyfinError(
      `Jellyfin rejected those credentials (${authRes.status} ${authRes.statusText})`,
      authRes.status,
    );
  }
  const auth = (await authRes.json()) as Record<string, unknown>;
  const token = String(auth['AccessToken'] ?? '');
  const user = (auth['User'] ?? {}) as Record<string, unknown>;
  if (!token) throw new JellyfinError('Jellyfin returned no access token');
  if (!((user['Policy'] as Record<string, unknown>)?.['IsAdministrator'])) {
    throw new JellyfinError(`Jellyfin user "${username}" is not an administrator`);
  }

  const sessionHeaders = { Authorization: `MediaBrowser Token="${token}"`, Accept: 'application/json' };

  const createRes = await fetch(
    `${config.jellyfin.url}/Auth/Keys?app=${encodeURIComponent(appName)}`,
    { method: 'POST', headers: sessionHeaders },
  );
  if (!createRes.ok) {
    throw new JellyfinError(`Could not create API key: ${createRes.status} ${createRes.statusText}`);
  }

  const keysRes = await fetch(`${config.jellyfin.url}/Auth/Keys`, { headers: sessionHeaders });
  if (!keysRes.ok) throw new JellyfinError('Could not read back the new API key');
  const keys = (await keysRes.json()) as { Items?: Record<string, unknown>[] };

  const match = (keys.Items ?? [])
    .filter((k) => String(k['AppName'] ?? '') === appName)
    .sort((a, b) => String(b['DateCreated'] ?? '').localeCompare(String(a['DateCreated'] ?? ''))) [0];

  const accessToken = match ? String(match['AccessToken'] ?? '') : '';
  if (!accessToken) throw new JellyfinError('Jellyfin created no key with that name');

  // Log out the temporary session so the bootstrap leaves no trace.
  await fetch(`${config.jellyfin.url}/Sessions/Logout`, {
    method: 'POST',
    headers: sessionHeaders,
  }).catch(() => {
    getLogger().debug('Bootstrap logout failed; the session will expire on its own');
  });

  return accessToken;
}
