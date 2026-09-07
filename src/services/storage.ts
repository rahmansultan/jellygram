import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline as pipelineAsync } from 'node:stream/promises';
import { config } from '../config/index.js';
import { getLogger } from '../lib/logger.js';
import { assertInside, safeJoin } from '../lib/paths.js';

/**
 * Filesystem operations for the media tree.
 *
 * Every write goes through `safeJoin`/`assertInside` first, and nothing here
 * shells out, so a filename can never become a command.
 */

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  /** Bytes actually available to this user, which is less than `freeBytes` on ext4. */
  availableBytes: number;
}

/** Disk usage of the filesystem holding `target`. */
export async function diskUsage(target: string = config.storage.mediaRoot): Promise<DiskUsage> {
  const stat = await fsp.statfs(target);
  const totalBytes = stat.blocks * stat.bsize;
  const freeBytes = stat.bfree * stat.bsize;
  const availableBytes = stat.bavail * stat.bsize;
  return { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes, availableBytes };
}

export interface SpaceCheck {
  ok: boolean;
  availableBytes: number;
  requiredBytes: number;
  reason?: string;
}

/**
 * Decide whether a download of `fileSize` may start.
 *
 * We require room for the file itself, a safety margin for the temp-to-final
 * move, and enough left over to stay above `MIN_FREE_DISK_BYTES`.
 */
export async function checkSpaceFor(fileSize: number): Promise<SpaceCheck> {
  const { availableBytes } = await diskUsage(config.storage.mediaRoot);
  const requiredBytes =
    fileSize + config.storage.diskSafetyMarginBytes + config.storage.minFreeDiskBytes;

  if (availableBytes < requiredBytes) {
    return {
      ok: false,
      availableBytes,
      requiredBytes,
      reason: `Need ${formatBytes(requiredBytes)} free, only ${formatBytes(availableBytes)} available`,
    };
  }
  return { ok: true, availableBytes, requiredBytes };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unknown';
  // Binary units, honestly labelled. Every limit in this system is binary
  // (2000 MiB for the Bot API, 5 GiB for assembly), so dividing by 1024 and
  // printing "GB" misreported each of them by about 7%.
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const sign = bytes < 0 ? '-' : '';
  return `${sign}${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** "3m 20s" / "1h 04m" — for waits a user is watching in a chat message. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

/**
 * Create a directory (and parents) with the configured mode and group.
 *
 * `mkdir -p` creates intermediate levels with the process umask and the
 * caller's primary group, so applying ownership to the leaf alone leaves
 * traversal-blocking gaps: Jellyfin cannot enter `movies/<user>/` even when
 * `movies/<user>/<title>/` is group-readable. Every level from `root` down is
 * therefore corrected, which is cheap and idempotent.
 */
export async function ensureDir(dir: string, root: string): Promise<void> {
  const target = assertInside(root, dir);
  const mode = dirModeWithSetgid(config.storage.dirMode);
  const base = path.resolve(root);

  // Created one level at a time, each level fixed up before the next is made:
  // setgid only propagates to children created *after* the parent has it, so a
  // single `mkdir -p` would leave every intermediate directory with the
  // worker's own group.
  await fsp.mkdir(base, { recursive: true, mode });
  await applyOwnership(base, mode);

  const rest = target === base ? '' : path.relative(base, target);
  let current = base;
  for (const segment of rest.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await fsp.mkdir(current, { mode });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    await applyOwnership(current, mode);
  }
}

/**
 * Directory mode including the setgid bit, when a media group is configured.
 *
 * setgid is what actually makes the scheme work. `chown` is unavailable to the
 * worker: the unit sets `PrivateTmp=true`, which runs it in a namespace where
 * the `jellyfin` gid is unmapped, and `chown` to an unmapped gid fails with
 * EINVAL. A setgid directory instead makes the kernel assign its group to
 * everything created inside it — no privileged call, no namespace dependency —
 * and subdirectories inherit the bit, so the whole tree stays correct. A file
 * created in a setgid `.incoming` also keeps that group when it is renamed
 * into the library, which `rename` would not otherwise do.
 */
/**
 * The id the kernel shows for a uid/gid that has no mapping in the caller's
 * user namespace (`/proc/sys/kernel/overflowgid`, 65534 by default).
 */
const OVERFLOW_GID = 65534;

/**
 * Whether `target` gets its group from the kernel rather than from us.
 *
 * The worker runs under `PrivateTmp=true`, inside a namespace where the
 * `jellyfin` gid is unmapped: every media path there *reads* as the overflow
 * gid however correct it is on disk, so comparing gids inside the namespace
 * says nothing. What matters is that the entry sits under a setgid directory,
 * because then the kernel has already stamped the parent's real on-disk group
 * onto it. Attempting `chown` in that situation cannot succeed — the target
 * gid is unmapped, so it fails EINVAL — and is not needed.
 */
async function inheritsGroup(target: string, observedGid: number): Promise<boolean> {
  if (observedGid !== OVERFLOW_GID) return false;
  const parent = await fsp.stat(path.dirname(target)).catch(() => null);
  // The media root's own parent is outside the tree and is not setgid, so the
  // root is judged by its own bit instead.
  const self = await fsp.stat(target).catch(() => null);
  return Boolean((parent && parent.mode & 0o2000) || (self?.isDirectory() && self.mode & 0o2000));
}

export function dirModeWithSetgid(mode: number): number {
  return config.storage.mediaGroup ? mode | 0o2000 : mode;
}

/**
 * Give Jellyfin read access without opening the file to every local account.
 *
 * The media tree is `2750 <service-user>:<MEDIA_GROUP>`: the owner can write,
 * the Jellyfin service account can read, nobody else can do either, and new
 * entries inherit the group automatically.
 */
export async function applyOwnership(target: string, mode: number): Promise<void> {
  try {
    await fsp.chmod(target, mode);
  } catch (err) {
    // Not fatal on its own, but it always means the media tree is now wrong,
    // so it is reported rather than swallowed at a level nobody runs at.
    getLogger().warn({ err, target }, 'Could not set media permissions');
  }

  const gid = await mediaGid();
  if (gid === null) return;

  let observed: { uid: number; gid: number; mode: string } | undefined;
  try {
    const stat = await fsp.stat(target);
    observed = { uid: stat.uid, gid: stat.gid, mode: (stat.mode & 0o777).toString(8) };
    if (stat.gid !== gid && !(await inheritsGroup(target, stat.gid))) {
      await fsp.chown(target, stat.uid, gid);
    }
  } catch (err) {
    // Reaching here means the group really is wrong and could not be fixed:
    // Jellyfin will not be able to read this path.
    getLogger().warn({ err, target, gid, observed }, 'Could not set media group ownership');
  }
}

let cachedGid: number | undefined;
let warnedMissingGroup = false;

/**
 * Numeric gid of `MEDIA_GROUP`, resolved from /etc/group without shelling out.
 *
 * Only a definitive answer is cached. A transient read failure must not
 * poison a long-running worker into never setting group ownership again.
 */
export async function mediaGid(): Promise<number | null> {
  if (cachedGid !== undefined) return cachedGid;
  const name = config.storage.mediaGroup;
  if (!name) return null;
  if (/^\d+$/.test(name)) return (cachedGid = Number(name));
  try {
    const content = await fsp.readFile('/etc/group', 'utf8');
    for (const line of content.split('\n')) {
      const parts = line.split(':');
      if (parts[0] === name && parts[2]) return (cachedGid = Number(parts[2]));
    }
  } catch (err) {
    getLogger().warn({ err, group: name }, 'Could not read /etc/group');
    return null;
  }
  if (!warnedMissingGroup) {
    warnedMissingGroup = true;
    getLogger().warn({ group: name }, 'MEDIA_GROUP does not exist; Jellyfin may not see new media');
  }
  return null;
}

/** Test seam: forget the resolved gid so a changed MEDIA_GROUP is picked up. */
export function resetMediaGidCache(): void {
  cachedGid = undefined;
  warnedMissingGroup = false;
}

export interface OwnershipRepair {
  directories: number;
  files: number;
}

/**
 * Re-apply the media tree's mode and group to everything under `dir`.
 *
 * Used to heal trees created before a fix, or after `MEDIA_GROUP` changes.
 * Symlinks are skipped: `Dirent.isFile`/`isDirectory` are lstat-based, so a
 * link can never be followed out of the media root.
 */
export async function repairOwnership(dir: string, root: string): Promise<OwnershipRepair> {
  const start = assertInside(root, dir);
  const result: OwnershipRepair = { directories: 0, files: 0 };

  const walk = async (current: string): Promise<void> => {
    await applyOwnership(current, dirModeWithSetgid(config.storage.dirMode));
    result.directories += 1;
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        await applyOwnership(child, config.storage.fileMode);
        result.files += 1;
      }
    }
  };

  await walk(start);
  return result;
}

export async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move a file, falling back to copy+unlink when the source and destination are
 * on different filesystems.
 */
export async function moveFile(from: string, to: string, root: string): Promise<void> {
  assertInside(root, to);
  await ensureDir(path.dirname(to), root);
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    // Not `fsp.copyFile`: libuv preserves the source's ownership, which
    // defeats the setgid directory the destination sits in. A stream copy
    // creates an ordinary new file, so it inherits the media group.
    await streamCopy(from, to);
    await fsp.unlink(from);
  }
  await applyOwnership(to, config.storage.fileMode);
  await ensureGroupReadable(to, root);
}

/** Copy bytes without carrying the source's ownership across. */
async function streamCopy(from: string, to: string): Promise<void> {
  await pipelineAsync(
    fs.createReadStream(from, { highWaterMark: 1024 * 1024 }),
    fs.createWriteStream(to, { mode: config.storage.fileMode }),
  );
}

/**
 * Last resort when a file arrives carrying a group Jellyfin cannot read.
 *
 * `rename` keeps the group the file was created with, and setgid does not
 * apply to it, so a file produced outside the media tree — historically the
 * local Bot API server's download — lands in the library still group-owned by
 * its creator. The worker cannot `chown` it (PrivateTmp namespace, unmapped
 * gid), so the only way to fix the inode is to write a new one: rewriting it
 * inside the setgid directory gives it the media group.
 *
 * After the Bot API server was configured to write with the media group this
 * should never trigger. It exists so that no source can silently produce media
 * Jellyfin cannot read — the failure mode this replaced was invisible.
 */
async function ensureGroupReadable(target: string, root: string): Promise<void> {
  const gid = await mediaGid();
  if (gid === null) return;

  const stat = await fsp.stat(target).catch(() => null);
  // An unmapped gid reads as the overflow id and means the group is one this
  // namespace cannot see — which, inside the media tree, is the media group.
  if (!stat || stat.gid === gid || stat.gid === OVERFLOW_GID) return;

  const temp = `${target}.regroup-${process.pid}`;
  assertInside(root, temp);
  getLogger().warn(
    { target, observedGid: stat.gid, expectedGid: gid, bytes: stat.size },
    'Filed media carries the wrong group; rewriting it so Jellyfin can read it',
  );
  try {
    await streamCopy(target, temp);
    await fsp.rename(temp, target);
    await fsp.chmod(target, config.storage.fileMode);
  } catch (err) {
    await removeQuietly(temp);
    getLogger().error({ err, target }, 'Could not correct the group of filed media');
  }
}

/** SHA-256 of a file, streamed so a 20 GB movie does not enter RAM. */
export async function hashFile(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(target, { highWaterMark: 1024 * 1024 });
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Move a file we could not identify into the quarantine directory.
 * Nothing is ever deleted here; an administrator sorts it out later.
 */
export async function quarantine(from: string, filename: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = safeJoin(config.storage.quarantineDir, `${stamp}-${filename}`);
  await fsp.mkdir(config.storage.quarantineDir, { recursive: true, mode: config.storage.dirMode });
  await moveFile(from, dest, config.storage.quarantineDir);
  return dest;
}

/** Recursive size of a directory, tolerant of races with the worker. */
export async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += await directorySize(full);
      else if (entry.isFile()) total += (await fsp.stat(full)).size;
    } catch {
      // File vanished mid-walk; skip it.
    }
  }
  return total;
}

/** Remove a partial download, ignoring the case where it is already gone. */
export async function removeQuietly(target: string): Promise<void> {
  try {
    await fsp.unlink(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      getLogger().debug({ err, target }, 'Failed to remove temporary file');
    }
  }
}
