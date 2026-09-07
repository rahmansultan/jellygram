import path from 'node:path';
import { config } from '../config/index.js';
import { getLogger } from '../lib/logger.js';
import { safeJoin } from '../lib/paths.js';
import { ensureDir } from './storage.js';
import * as jf from './jellyfin.js';
import { librariesRepo, usersRepo } from '../db/repositories.js';
import type { UserLibraryRow, UserRow } from '../db/types.js';
import type { JellyfinUser, VirtualFolder } from './jellyfin.js';

/**
 * Per-user media isolation.
 *
 * Separate folders alone give no privacy: a Jellyfin library is visible to any
 * account whose policy has `EnableAllFolders`, and Jellyfin grants access per
 * *library*, never per sub-folder. So the architecture is:
 *
 *   1. Every user gets their own directory under MOVIES_ROOT and TV_ROOT.
 *   2. Every user gets their own pair of Jellyfin libraries pointed at exactly
 *      those directories, named with the user's slug.
 *   3. Every non-admin Jellyfin account is switched to
 *      `EnableAllFolders = false` with an explicit list containing only their
 *      own two libraries.
 *
 * Step 3 is the one that actually enforces privacy, and `auditIsolation()`
 * below re-checks it continuously so a change made in the Jellyfin UI cannot
 * silently reopen everyone's media.
 */

export function libraryName(user: Pick<UserRow, 'name' | 'storage_slug'>, type: 'movie' | 'tv'): string {
  const prefix = config.jellyfin.libraryPrefix ? `${config.jellyfin.libraryPrefix} ` : '';
  const label = type === 'movie' ? 'Movies' : 'TV Shows';
  return `${prefix}${label} - ${user.name}`.trim();
}

export function userMediaDir(user: Pick<UserRow, 'storage_slug'>, type: 'movie' | 'tv'): string {
  const root = type === 'movie' ? config.storage.moviesRoot : config.storage.tvRoot;
  return safeJoin(root, user.storage_slug);
}

/** Create the user's two media directories with Jellyfin-readable ownership. */
export async function ensureUserDirectories(user: UserRow): Promise<{ movies: string; tv: string }> {
  const movies = userMediaDir(user, 'movie');
  const tv = userMediaDir(user, 'tv');
  await ensureDir(config.storage.moviesRoot, config.storage.mediaRoot);
  await ensureDir(config.storage.tvRoot, config.storage.mediaRoot);
  await ensureDir(movies, config.storage.moviesRoot);
  await ensureDir(tv, config.storage.tvRoot);
  return { movies, tv };
}

export interface ProvisionResult {
  ok: boolean;
  steps: string[];
  warnings: string[];
  jellyfinUserId: string | null;
}

/**
 * Bring one user's Jellyfin state in line with the database: directories,
 * libraries, and a locked-down access policy.
 *
 * Idempotent — safe to run on every user edit and from the dashboard button.
 */
/**
 * Which libraries a managed account should end up able to see.
 *
 * The whole two-user question lives in this one expression, so it is separated
 * from the Jellyfin calls around it and tested directly. Three rules, in
 * order of how badly getting them wrong would hurt:
 *
 * 1. The user's own libraries are always enabled — otherwise provisioning
 *    locks somebody out of their own media.
 * 2. A library belonging to a *different* managed user is always removed, even
 *    if it is currently enabled. This is the isolation guarantee; nothing else
 *    enforces it.
 * 3. Anything else already enabled is preserved. Libraries this system did not
 *    create are the administrator's business — a shared family library, or a
 *    personal one — and provisioning a user must not quietly revoke them.
 */
export function enabledFoldersFor(input: {
  ownedLibraryIds: string[];
  currentEnabled: readonly string[];
  managedByOthers: ReadonlySet<string>;
}): { enabledFolders: string[]; preserved: string[] } {
  const owned = [...new Set(input.ownedLibraryIds)];
  const preserved = [...new Set(input.currentEnabled)].filter(
    (id) => !input.managedByOthers.has(id) && !owned.includes(id),
  );
  return { enabledFolders: [...owned, ...preserved], preserved };
}

export async function provisionUser(user: UserRow): Promise<ProvisionResult> {
  const log = getLogger();
  const steps: string[] = [];
  const warnings: string[] = [];

  const dirs = await ensureUserDirectories(user);
  steps.push(`Created media directories: ${dirs.movies}, ${dirs.tv}`);

  if (!config.jellyfin.configured) {
    warnings.push('JELLYFIN_API_KEY is not set, so Jellyfin libraries were not created.');
    return { ok: false, steps, warnings, jellyfinUserId: user.jellyfin_user_id };
  }

  // --- Resolve the Jellyfin account -----------------------------------------
  const jfUser = await jf.findUserByName(user.jellyfin_username);
  if (!jfUser) {
    warnings.push(
      `No Jellyfin account named "${user.jellyfin_username}". Create it in the Jellyfin dashboard, then provision again.`,
    );
    return { ok: false, steps, warnings, jellyfinUserId: null };
  }
  if (jfUser.id !== user.jellyfin_user_id) {
    await usersRepo.update(user.id, { jellyfin_user_id: jfUser.id });
    steps.push(`Linked Jellyfin account ${jfUser.name} (${jfUser.id})`);
  }

  // --- Ensure the two libraries exist ---------------------------------------
  const existing = await jf.listVirtualFolders();
  const wanted: Array<{ type: 'movie' | 'tv'; collection: 'movies' | 'tvshows'; dir: string }> = [
    { type: 'movie', collection: 'movies', dir: dirs.movies },
    { type: 'tv', collection: 'tvshows', dir: dirs.tv },
  ];

  const ownedLibraryIds: string[] = [];

  for (const w of wanted) {
    const name = libraryName(user, w.type);
    let folder = existing.find((f) => f.name === name);

    if (!folder) {
      // A library elsewhere already points at this directory: adopt it rather
      // than creating a duplicate that would double-index the files.
      const byPath = existing.find((f) => f.locations.some((l) => path.resolve(l) === w.dir));
      if (byPath) {
        folder = byPath;
        warnings.push(
          `Reusing existing Jellyfin library "${byPath.name}" which already points at ${w.dir}.`,
        );
      } else {
        await jf.createLibrary({ name, collectionType: w.collection, path: w.dir });
        steps.push(`Created Jellyfin library "${name}" -> ${w.dir}`);
        folder = (await jf.listVirtualFolders()).find((f) => f.name === name);
      }
    }

    if (!folder) {
      warnings.push(`Jellyfin did not report library "${name}" after creation.`);
      continue;
    }

    // A library that also points somewhere else would leak media into this
    // user's view; surface it instead of silently trusting it.
    const strayLocations = folder.locations.filter((l) => path.resolve(l) !== w.dir);
    if (strayLocations.length > 0) {
      warnings.push(
        `Library "${folder.name}" also points at ${strayLocations.join(', ')} — remove those paths in Jellyfin.`,
      );
    }

    // Jellyfin defaults a movies library to the NFO saver, which cannot write
    // into a tree the Jellyfin account may only read.
    if (await jf.disableLocalMetadataSavers(folder.name).catch(() => false)) {
      steps.push(`Disabled local metadata savers for "${folder.name}"`);
    }

    ownedLibraryIds.push(folder.itemId);
    await librariesRepo.upsert({
      user_id: user.id,
      media_type: w.type,
      library_name: folder.name,
      library_path: w.dir,
      jellyfin_item_id: folder.itemId,
    });
  }

  // --- Lock the account down to exactly those libraries ----------------------
  if (jfUser.isAdministrator) {
    warnings.push(
      `Jellyfin account "${jfUser.name}" is an administrator, so it can see every library. ` +
        `Use a non-admin account for media owners.`,
    );
  } else if (ownedLibraryIds.length > 0) {
    const managedByOthers = await librariesRepo.itemIdsExcludingUser(user.id);
    const current = await jf.enabledFolders(jfUser.id).catch(() => [] as string[]);
    const { enabledFolders, preserved } = enabledFoldersFor({
      ownedLibraryIds,
      currentEnabled: current,
      managedByOthers,
    });

    await jf.setUserLibraryAccess(jfUser.id, { enableAllFolders: false, enabledFolders });
    steps.push(
      `Restricted "${jfUser.name}" to ${ownedLibraryIds.length} own librar${
        ownedLibraryIds.length === 1 ? 'y' : 'ies'
      }` + (preserved.length ? ` plus ${preserved.length} unmanaged` : ''),
    );
  }

  log.info({ userId: user.id, steps, warnings }, 'Provisioned user');
  return { ok: warnings.length === 0, steps, warnings, jellyfinUserId: jfUser.id };
}

export interface IsolationFinding {
  severity: 'error' | 'warning' | 'info';
  jellyfinUser: string;
  message: string;
}

export interface IsolationReport {
  checked: boolean;
  ok: boolean;
  findings: IsolationFinding[];
  managedLibraries: number;
  checkedAt: string;
}

/**
 * Re-derive, from Jellyfin's own state, whether each account can currently see
 * anything that is not its own. This is what the dashboard's privacy panel
 * shows; it never trusts the local database's idea of the policy.
 */
export async function auditIsolation(): Promise<IsolationReport> {
  const findings: IsolationFinding[] = [];
  const checkedAt = new Date().toISOString();

  if (!config.jellyfin.configured) {
    return {
      checked: false,
      ok: false,
      findings: [
        { severity: 'error', jellyfinUser: '-', message: 'JELLYFIN_API_KEY is not set; isolation cannot be verified.' },
      ],
      managedLibraries: 0,
      checkedAt,
    };
  }

  const [jfUsers, folders, dbUsers, dbLibraries] = await Promise.all([
    jf.listUsers(),
    jf.listVirtualFolders(),
    usersRepo.list(),
    librariesRepo.listAll(),
  ]);

  return analyseIsolation({ jfUsers, folders, dbUsers, dbLibraries, checkedAt });
}

/**
 * Decide whether the state Jellyfin just reported is isolated.
 *
 * Separated from the four calls that fetch it so the two-user cases — the ones
 * that matter and the ones a single-user installation can never exercise — can
 * be tested exhaustively without a Jellyfin server, a database, or any media
 * on disk. `auditIsolation` is now fetch-then-analyse and nothing else.
 */
export function analyseIsolation(input: {
  jfUsers: readonly JellyfinUser[];
  folders: readonly VirtualFolder[];
  dbUsers: readonly UserRow[];
  dbLibraries: readonly UserLibraryRow[];
  checkedAt?: string;
}): IsolationReport {
  const { jfUsers, folders, dbUsers, dbLibraries } = input;
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const findings: IsolationFinding[] = [];

  const managedIds = new Set(dbLibraries.map((l) => l.jellyfin_item_id).filter(Boolean) as string[]);
  const libraryOwner = new Map<string, number>();
  for (const l of dbLibraries) {
    if (l.jellyfin_item_id) libraryOwner.set(l.jellyfin_item_id, l.user_id);
  }
  const folderNameById = new Map(folders.map((f) => [f.itemId, f.name]));
  const dbUserByJfId = new Map(dbUsers.filter((u) => u.jellyfin_user_id).map((u) => [u.jellyfin_user_id!, u]));

  for (const jfUser of jfUsers) {
    const owner = dbUserByJfId.get(jfUser.id);

    if (jfUser.isAdministrator) {
      findings.push({
        severity: owner ? 'error' : 'info',
        jellyfinUser: jfUser.name,
        message: owner
          ? `Managed user "${jfUser.name}" is a Jellyfin administrator and can therefore see every library. Remove admin rights in Jellyfin.`
          : `Administrator account (expected to see all libraries).`,
      });
      continue;
    }

    if (jfUser.enableAllFolders) {
      findings.push({
        severity: 'error',
        jellyfinUser: jfUser.name,
        message: `"${jfUser.name}" has "access to all libraries" enabled and can see every user's media.`,
      });
      continue;
    }

    // Managed libraries this account can reach that belong to somebody else.
    const foreign = jfUser.enabledFolders.filter(
      (id) => managedIds.has(id) && (!owner || libraryOwner.get(id) !== owner.id),
    );
    if (foreign.length > 0) {
      findings.push({
        severity: 'error',
        jellyfinUser: jfUser.name,
        message: `"${jfUser.name}" can access other users' libraries: ${foreign
          .map((id) => folderNameById.get(id) ?? id)
          .join(', ')}.`,
      });
    }

    if (owner) {
      const own = dbLibraries.filter((l) => l.user_id === owner.id && l.jellyfin_item_id);
      const missing = own.filter((l) => !jfUser.enabledFolders.includes(l.jellyfin_item_id!));
      if (missing.length > 0) {
        findings.push({
          severity: 'warning',
          jellyfinUser: jfUser.name,
          message: `"${jfUser.name}" cannot see their own libraries: ${missing
            .map((l) => l.library_name)
            .join(', ')}. Re-provision the user.`,
        });
      }
    }
  }

  // Any library pointing at a user's private directory but not managed by us
  // is an independent way in; flag it.
  for (const folder of folders) {
    if (managedIds.has(folder.itemId)) continue;
    for (const location of folder.locations) {
      const resolved = path.resolve(location);
      const owner = dbUsers.find(
        (u) => resolved === userMediaDir(u, 'movie') || resolved === userMediaDir(u, 'tv'),
      );
      if (owner) {
        findings.push({
          severity: 'error',
          jellyfinUser: '-',
          message: `Unmanaged Jellyfin library "${folder.name}" points at ${owner.name}'s private folder (${resolved}).`,
        });
      }
    }
  }

  return {
    checked: true,
    ok: !findings.some((f) => f.severity === 'error'),
    findings,
    managedLibraries: managedIds.size,
    checkedAt,
  };
}

/**
 * Repair isolation for every managed user by re-applying the intended policy.
 * Accounts this application does not manage are left alone.
 */
export async function enforceIsolation(): Promise<{ repaired: string[]; warnings: string[] }> {
  const repaired: string[] = [];
  const warnings: string[] = [];

  for (const user of await usersRepo.list()) {
    try {
      const result = await provisionUser(user);
      if (result.steps.length > 0) repaired.push(user.name);
      warnings.push(...result.warnings);
    } catch (err) {
      warnings.push(`${user.name}: ${(err as Error).message}`);
    }
  }
  return { repaired, warnings };
}

/**
 * Remove the Jellyfin libraries created for a user. The media files themselves
 * are never touched: uploaded media is permanent until an administrator
 * deletes it deliberately.
 */
export async function deprovisionUser(user: UserRow): Promise<string[]> {
  const notes: string[] = [];
  if (!config.jellyfin.configured) return ['Jellyfin not configured; no libraries removed.'];

  for (const lib of await librariesRepo.listForUser(user.id)) {
    try {
      await jf.removeLibrary(lib.library_name);
      notes.push(`Removed Jellyfin library "${lib.library_name}"`);
    } catch (err) {
      notes.push(`Could not remove "${lib.library_name}": ${(err as Error).message}`);
    }
  }
  await librariesRepo.removeForUser(user.id);
  notes.push('Media files were left on disk.');
  return notes;
}
