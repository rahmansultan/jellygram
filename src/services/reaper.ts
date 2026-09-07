import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { getLogger } from '../lib/logger.js';
import { PathEscapeError, assertInside, isInside } from '../lib/paths.js';
import { formatBytes } from './storage.js';
import { mtprotoJobsRepo, sessionsRepo, uploadsRepo } from '../db/repositories.js';

/**
 * Reaper for the download staging directory.
 *
 * Four ingestion routes write into `DOWNLOAD_TMP_DIR` — the Telegram
 * downloader, multi-part assembly, the direct uploader and MTProto — and only
 * the happy path takes the file out again. A job that fails, is cancelled, or
 * is killed mid-download leaves its scratch file behind forever; 27 of them
 * had accumulated before this existed.
 *
 * Deleting from a directory that four writers share needs two independent
 * reasons to believe a file is dead, because either alone is unsound:
 *
 *   1. Nothing in the database still refers to it. This covers every file that
 *      was handed off to a row — an assembled session, a direct upload, an
 *      MTProto download — but *not* an in-flight one. The Telegram downloader
 *      and the multi-part part-staging path both write to a name no row ever
 *      holds, so a database check on its own would delete live downloads.
 *
 *   2. Nothing has written to it for `DOWNLOAD_TMP_GRACE_HOURS`. This is what
 *      actually protects an in-flight download, whose modification time
 *      advances with every chunk. It is not sufficient alone either: a queued
 *      upload can sit untouched past the grace period waiting for a worker.
 */

export interface ReapResult {
  /** Files unlinked. */
  removed: number;
  /** Bytes freed. */
  bytes: number;
  /** Files examined and deliberately left alone. */
  kept: number;
  /** Files that looked reapable but could not be removed. */
  failed: number;
}

export interface ReapOptions {
  /** Defaults to `config.storage.downloadTmpDir`. */
  dir?: string;
  /** Defaults to `DOWNLOAD_TMP_GRACE_HOURS`. */
  graceMs?: number;
  /** Clock injection point for tests. */
  now?: number;
}

const EMPTY: ReapResult = { removed: 0, bytes: 0, kept: 0, failed: 0 };

/**
 * Directories the reaper must never be pointed at, however `DOWNLOAD_TMP_DIR`
 * is set. Quarantine especially: it is the one place a file is deliberately
 * kept for an administrator to look at, and nothing deletes from it.
 */
function protectedRoots(): string[] {
  return [
    config.storage.quarantineDir,
    config.storage.moviesRoot,
    config.storage.tvRoot,
    config.multipart.partsDir,
  ].map((d) => path.resolve(d));
}

/**
 * Delete orphaned scratch files from the staging directory.
 *
 * Never recurses, never follows a symlink, and never touches anything it
 * cannot prove is a regular file directly inside `dir`.
 */
export async function reapDownloadTmp(options: ReapOptions = {}): Promise<ReapResult> {
  const log = getLogger();
  const dir = path.resolve(options.dir ?? config.storage.downloadTmpDir);
  const graceMs = options.graceMs ?? config.storage.downloadTmpGraceHours * 60 * 60 * 1000;
  const now = options.now ?? Date.now();

  // A staging directory that contains the library, the parts tree or the
  // quarantine is a misconfiguration, and reaping inside it would destroy
  // media. Refuse rather than do a partial job.
  const swallowed = protectedRoots().filter((root) => isInside(dir, root));
  if (swallowed.length > 0) {
    log.error({ dir, swallowed }, 'Refusing to reap: staging directory contains protected media');
    return { ...EMPTY };
  }

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
    log.warn({ err, dir }, 'Could not list the download staging directory');
    return { ...EMPTY };
  }

  const result: ReapResult = { removed: 0, bytes: 0, kept: 0, failed: 0 };

  // `Dirent.isFile` is lstat-based, so a symlink — the one way an entry in
  // this directory could point at something outside the media root — reports
  // false and is skipped here rather than followed. Directories are skipped
  // too: nothing writes one, so one appearing is not ours to delete.
  const candidates: Array<{ full: string; name: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      result.kept += 1;
      continue;
    }
    try {
      candidates.push({ full: assertInside(dir, path.join(dir, entry.name)), name: entry.name });
    } catch (err) {
      // Only reachable via a name containing a separator, which the kernel
      // does not permit; belt and braces around the one unlink in here.
      if (!(err instanceof PathEscapeError)) throw err;
      log.warn({ dir, name: entry.name }, 'Skipping staging entry that resolves outside the directory');
      result.kept += 1;
    }
  }

  if (candidates.length === 0) return result;

  // Read the directory before the database, never the other way round. A file
  // written and then recorded between the two queries would otherwise be
  // listed as an orphan while its row was still invisible to us.
  const live = await livePaths();

  for (const { full } of candidates) {
    let stat: import('node:fs').Stats;
    try {
      stat = await fsp.lstat(full);
    } catch {
      // Won the race against whoever was using it; nothing to do.
      continue;
    }

    // ctime as well as mtime: a rename or a permission fix touches the inode
    // without rewriting it, and both mean somebody still cares about the file.
    const idleMs = now - Math.max(stat.mtimeMs, stat.ctimeMs);
    if (idleMs < graceMs) {
      result.kept += 1;
      continue;
    }

    if (live.has(full)) {
      result.kept += 1;
      continue;
    }

    try {
      await fsp.unlink(full);
      result.removed += 1;
      result.bytes += stat.size;
      log.debug({ path: full, bytes: stat.size, idleMs }, 'Reaped orphaned staging file');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      result.failed += 1;
      log.warn({ err, path: full }, 'Could not remove orphaned staging file');
    }
  }

  if (result.removed > 0) {
    log.info(
      {
        dir,
        removed: result.removed,
        bytes: result.bytes,
        freed: formatBytes(result.bytes),
        kept: result.kept,
        failed: result.failed,
        graceHours: graceMs / (60 * 60 * 1000),
      },
      `Reaped ${result.removed} orphaned staging file(s), ${formatBytes(result.bytes)} freed`,
    );
  }

  return result;
}

/**
 * Every staging path some unfinished piece of work still owns, resolved so
 * that a row written with a relative or unnormalised path still matches.
 */
async function livePaths(): Promise<Set<string>> {
  const [uploads, sessions, mtproto] = await Promise.all([
    uploadsRepo.liveLocalSourcePaths(),
    sessionsRepo.liveAssembledPaths(),
    mtprotoJobsRepo.liveTempPaths(),
  ]);
  return new Set([...uploads, ...sessions, ...mtproto].map((p) => path.resolve(p)));
}

/**
 * Delete downloads the local Bot API server fetched but nothing ever collected.
 *
 * In `--local` mode `getFile` makes the server download the whole file into its
 * own data directory and keeps it there; `takeLocalFile` renames it out on the
 * happy path. When an upload is abandoned, cancelled, or fails after the server
 * has already fetched the bytes, that copy stays forever. Upload 539 left a
 * 1.8 GiB orphan exactly this way.
 *
 * Two things make this safe to sweep:
 *   - the server writes in-progress downloads under `--temp-dir`, which is
 *     skipped outright, and a completed file's mtime stops advancing;
 *   - the grace period is hours, far longer than the ~24 minutes a 2 GB fetch
 *     takes, so a file still being collected is never a candidate.
 *
 * Deleting a cached file is recoverable in any case: a later `getFile` simply
 * fetches it again.
 *
 * Paths here are never logged raw — the server names each bot's directory after
 * its token.
 */
export async function reapBotApiData(options: ReapOptions = {}): Promise<ReapResult> {
  const log = getLogger();
  if (!config.telegram.localMode) return { ...EMPTY };

  const root = path.resolve(options.dir ?? config.telegram.localHostRoot);
  const graceMs = options.graceMs ?? config.storage.downloadTmpGraceHours * 60 * 60 * 1000;
  const now = options.now ?? Date.now();

  // The same refusal as the staging sweep: if this is misconfigured to point
  // at the media tree, do nothing at all.
  const swallowed = protectedRoots().filter((p) => isInside(root, p));
  if (swallowed.length > 0) {
    log.error({ swallowed }, 'Refusing to reap: Bot API data directory contains protected media');
    return { ...EMPTY };
  }

  const result: ReapResult = { removed: 0, bytes: 0, kept: 0, failed: 0 };
  const live = await livePaths();

  /** Relative to the data root, minus the token-named first segment. */
  const loggable = (full: string): string =>
    path.relative(root, full).split(path.sep).slice(1).join('/') || '(top level)';

  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn({ err, dir: loggable(dir) }, 'Could not list a Bot API data directory');
      }
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        assertInside(root, full);
      } catch (err) {
        if (!(err instanceof PathEscapeError)) throw err;
        result.kept += 1;
        continue;
      }

      if (entry.isDirectory()) {
        // Whatever the server is still writing lives here; never touch it.
        if (entry.name === '.tmp') {
          result.kept += 1;
          continue;
        }
        await walk(full);
        continue;
      }
      // lstat-based, so symlinks are skipped rather than followed.
      if (!entry.isFile()) {
        result.kept += 1;
        continue;
      }

      let stat: import('node:fs').Stats;
      try {
        stat = await fsp.lstat(full);
      } catch {
        continue;
      }

      if (now - Math.max(stat.mtimeMs, stat.ctimeMs) < graceMs || live.has(full)) {
        result.kept += 1;
        continue;
      }

      try {
        await fsp.unlink(full);
        result.removed += 1;
        result.bytes += stat.size;
        log.debug({ file: loggable(full), bytes: stat.size }, 'Reaped an uncollected Bot API download');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        result.failed += 1;
        log.warn({ err, file: loggable(full) }, 'Could not remove an uncollected Bot API download');
      }
    }
  };

  await walk(root);

  if (result.removed > 0) {
    log.info(
      { removed: result.removed, freed: formatBytes(result.bytes), kept: result.kept, failed: result.failed },
      `Reaped ${result.removed} uncollected Bot API download(s), ${formatBytes(result.bytes)} freed`,
    );
  }
  return result;
}

/**
 * Delete the part files of multi-part sessions that are finished or abandoned.
 *
 * Parts are the largest scratch objects the system writes: a 5 GiB multi-part
 * upload stores 5 GiB of pieces *and* the assembled copy, so leaving the pieces
 * behind doubles the permanent cost of every large upload. Nothing else removes
 * them — the staging reaper deliberately refuses to operate anywhere near this
 * tree — so this is the only thing standing between a busy month and a full
 * disk.
 *
 * The layout makes precise cleanup possible: every session owns exactly one
 * directory, `<parts>/session-<id>`, and nothing else writes there. A directory
 * is removable only when all three hold:
 *
 *   1. its name is exactly `session-<digits>` — anything else is not ours;
 *   2. the session it names is gone, or failed permanently;
 *   3. nothing in it has been written for the applicable retention window.
 *
 * Rule 2 alone would be unsafe: a row is created before its directory and
 * updated after it, so a session in flight during the query could be misread.
 * Rule 3 alone would be unsafe too: a session can sit untouched for hours
 * waiting for its next part. Both together mean a live upload is never at risk.
 *
 * The retention window differs by reason, because `handleAssembleSession`
 * deliberately keeps a failed session's parts so a retry does not have to
 * re-upload gigabytes. Deleting those immediately would destroy a feature, so
 * they are held for `MULTIPART_FAILED_RETENTION_HOURS` instead — long enough to
 * retry, short enough not to be permanent. Directories whose session no longer
 * exists have no retry to protect and use the ordinary grace period.
 */
export async function reapParts(options: ReapOptions = {}): Promise<ReapResult> {
  const log = getLogger();
  const root = path.resolve(options.dir ?? config.multipart.partsDir);
  const graceMs = options.graceMs ?? config.storage.downloadTmpGraceHours * 60 * 60 * 1000;
  const now = options.now ?? Date.now();

  // The same refusal as the staging sweep: a misconfigured parts directory
  // that contains the library must never be walked.
  const swallowed = [config.storage.moviesRoot, config.storage.tvRoot, config.storage.quarantineDir]
    .map((d) => path.resolve(d))
    .filter((d) => isInside(root, d));
  if (swallowed.length > 0) {
    log.error({ swallowed }, 'Refusing to reap: parts directory contains protected media');
    return { ...EMPTY };
  }

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
    log.warn({ err, dir: root }, 'Could not list the parts directory');
    return { ...EMPTY };
  }

  const result: ReapResult = { removed: 0, bytes: 0, kept: 0, failed: 0 };

  // Read the directory before the database, never the other way round: a
  // session created between the two queries would otherwise look like an
  // orphan while its row was still invisible to us.
  const candidates: Array<{ dir: string; sessionId: number }> = [];
  for (const entry of entries) {
    // `isDirectory` is lstat-based, so a symlink reports false and is skipped
    // rather than followed out of the media root.
    if (!entry.isDirectory()) {
      result.kept += 1;
      continue;
    }
    const match = /^session-(\d+)$/.exec(entry.name);
    if (!match?.[1]) {
      result.kept += 1;
      continue;
    }
    try {
      candidates.push({
        dir: assertInside(root, path.join(root, entry.name)),
        sessionId: Number(match[1]),
      });
    } catch (err) {
      if (!(err instanceof PathEscapeError)) throw err;
      result.kept += 1;
    }
  }

  if (candidates.length === 0) return result;

  const classified = await sessionsRepo.classifyForReaping(candidates.map((c) => c.sessionId));
  const retainedMs = config.multipart.failedRetentionHours * 60 * 60 * 1000;

  for (const { dir, sessionId } of candidates) {
    // A session still working is never a candidate, whatever its age.
    const reason = classified.get(sessionId);
    if (reason === undefined) {
      result.kept += 1;
      continue;
    }

    const window = reason === 'retained' ? Math.max(graceMs, retainedMs) : graceMs;
    const idle = await newestMtime(dir);
    if (idle === null || now - idle < window) {
      result.kept += 1;
      continue;
    }

    const size = await directorySize(dir);
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      result.removed += 1;
      result.bytes += size;
      log.debug({ sessionId, bytes: size, reason }, 'Reaped the parts of a finished session');
    } catch (err) {
      result.failed += 1;
      log.warn({ err, sessionId }, 'Could not remove the parts of a finished session');
    }
  }

  if (result.removed > 0) {
    log.info(
      {
        removed: result.removed,
        bytes: result.bytes,
        freed: formatBytes(result.bytes),
        kept: result.kept,
        failed: result.failed,
      },
      `Reaped parts for ${result.removed} finished session(s), ${formatBytes(result.bytes)} freed`,
    );
  }
  return result;
}

/** Most recent mtime/ctime anywhere in a directory, or null if unreadable. */
async function newestMtime(dir: string): Promise<number | null> {
  let newest: number | null = null;
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    const stat = await fsp.lstat(current).catch(() => null);
    if (stat) newest = Math.max(newest ?? 0, stat.mtimeMs, stat.ctimeMs);
    if (!stat?.isDirectory()) return;
    const kids = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const kid of kids) await visit(path.join(current, kid.name), depth + 1);
  };
  await visit(dir, 0);
  return newest;
}

/** Bytes held by a directory tree, for reporting how much was freed. */
async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full, depth + 1);
      else if (entry.isFile()) {
        const stat = await fsp.lstat(full).catch(() => null);
        if (stat) total += stat.size;
      }
    }
  };
  await visit(dir, 0);
  return total;
}
