// Imported first, before anything that reads configuration: these tests point a
// deleter and a directory-creator at `config.storage.mediaRoot`, and without
// this that root is the owner's real film library.
import './helpers/test-media-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { config } from '../src/config/index.js';
import { execFileSync } from 'node:child_process';
import {
  applyOwnership,
  dirModeWithSetgid,
  ensureDir,
  mediaGid,
  moveFile,
  repairOwnership,
} from '../src/services/storage.js';

/**
 * Regression tests for the bug that left filed media unreadable by Jellyfin.
 *
 * `mkdir -p` creates intermediate directories with the caller's primary group,
 * so applying ownership only to the leaf left `movies/<user>/` group-owned by
 * the service account's own primary group. Jellyfin could not traverse into it
 * and reported the library folder as "inaccessible or empty".
 */

const gidPromise = mediaGid();

async function gidOf(target: string): Promise<number> {
  return (await fsp.stat(target)).gid;
}

async function modeOf(target: string): Promise<number> {
  return (await fsp.stat(target)).mode & 0o777;
}

/** A scratch tree under the real media root, so the real gid rules apply. */
async function scratchRoot(label: string): Promise<string> {
  const dir = path.join(config.storage.mediaRoot, `.test-own-${label}-${process.pid}-${Date.now()}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

test('ensureDir applies the media group to every level it creates, not just the leaf', async (t) => {
  const gid = await gidPromise;
  if (gid === null) return t.skip('MEDIA_GROUP does not resolve on this machine');

  const root = await scratchRoot('ensuredir');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const leaf = path.join(root, 'movies', 'someuser', 'Some Title (2020)');
  await ensureDir(leaf, root);

  // Every level, including the intermediates mkdir -p made silently.
  for (const level of [
    root,
    path.join(root, 'movies'),
    path.join(root, 'movies', 'someuser'),
    leaf,
  ]) {
    assert.equal(await gidOf(level), gid, `${level} should be group ${gid}`);
    assert.equal(await modeOf(level), config.storage.dirMode, `${level} mode`);
  }
});

test('moveFile groups the destination file and its whole parent chain', async (t) => {
  const gid = await gidPromise;
  if (gid === null) return t.skip('MEDIA_GROUP does not resolve on this machine');

  const root = await scratchRoot('movefile');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  // Source deliberately outside the media tree, as a real temp file may be.
  const from = path.join(os.tmpdir(), `jellygram-move-${process.pid}-${Date.now()}.bin`);
  await fsp.writeFile(from, 'payload');

  const to = path.join(root, 'movies', 'someuser', 'Title (2021)', 'Title (2021).bin');
  await moveFile(from, to, root);

  assert.equal(await gidOf(to), gid, 'moved file group');
  assert.equal(await modeOf(to), config.storage.fileMode, 'moved file mode');
  assert.equal(await gidOf(path.dirname(to)), gid, 'title directory group');
  assert.equal(await gidOf(path.join(root, 'movies', 'someuser')), gid, 'user directory group');
  assert.equal(await gidOf(path.join(root, 'movies')), gid, 'movies directory group');
});

test('repairOwnership heals a tree created without the media group', async (t) => {
  const gid = await gidPromise;
  if (gid === null) return t.skip('MEDIA_GROUP does not resolve on this machine');

  const root = await scratchRoot('repair');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  // Build the tree the way the buggy code did: plain mkdir, no ownership.
  const dir = path.join(root, 'movies', 'someuser', 'Old Title (2019)');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'Old Title (2019).bin');
  await fsp.writeFile(file, 'payload');
  await fsp.chmod(dir, 0o755);
  await fsp.chmod(file, 0o644);

  const result = await repairOwnership(root, root);

  assert.ok(result.directories >= 4, 'walked every directory');
  assert.equal(result.files, 1);
  assert.equal(await gidOf(file), gid);
  assert.equal(await modeOf(file), config.storage.fileMode);
  assert.equal(await gidOf(dir), gid);
  assert.equal(await modeOf(dir), config.storage.dirMode);
});

test('repairOwnership refuses to walk outside the media root', async () => {
  await assert.rejects(() => repairOwnership('/etc', config.storage.mediaRoot));
});

test('applyOwnership on a missing path does not throw', async () => {
  // Ownership is best-effort; a vanished temp file must not fail an upload.
  await applyOwnership(
    path.join(config.storage.mediaRoot, `.test-own-absent-${Date.now()}`),
    config.storage.fileMode,
  );
});

// ---------------------------------------------------------------------------
// The bug that actually made media invisible to Jellyfin
// ---------------------------------------------------------------------------

test('media directories carry setgid so new entries inherit the group', async (t) => {
  const gid = await gidPromise;
  if (gid === null) return t.skip('MEDIA_GROUP does not resolve on this machine');

  const root = await scratchRoot('setgid');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const leaf = path.join(root, 'movies', 'someuser', 'Title (2024)');
  await ensureDir(leaf, root);

  for (const level of [root, path.join(root, 'movies'), path.join(root, 'movies', 'someuser'), leaf]) {
    const mode = (await fsp.stat(level)).mode;
    assert.ok(
      (mode & 0o2000) !== 0,
      `${level} must be setgid — chown is unavailable to the worker, so inheritance is the only mechanism`,
    );
  }
});

test('dirModeWithSetgid only adds the bit when a media group is configured', () => {
  const withGroup = dirModeWithSetgid(0o750);
  assert.equal(withGroup & 0o777, 0o750, 'the permission bits are untouched');
  if (config.storage.mediaGroup) assert.equal(withGroup & 0o2000, 0o2000);
});

/**
 * The production defect, end to end.
 *
 * The worker unit sets `PrivateTmp=true`, which runs it in a namespace where
 * the `jellyfin` gid is unmapped. `chown` to an unmapped gid fails with EINVAL,
 * so the previous chown-based approach silently left every filed movie group-
 * owned by the service account and Jellyfin logged "Library folder ... is
 * inaccessible or empty". The setgid bit works regardless of the namespace, and this asserts
 * the on-disk result from *outside* it — inside, an unmapped gid merely reads
 * as the overflow id and proves nothing.
 */
test('a file written inside the worker sandbox lands with the media group on disk', async (t) => {
  const gid = await gidPromise;
  if (gid === null) return t.skip('MEDIA_GROUP does not resolve on this machine');

  try {
    execFileSync('systemd-run', ['--user', '--version'], { stdio: 'ignore' });
  } catch {
    return t.skip('systemd-run is unavailable; cannot reproduce the worker sandbox');
  }

  const marker = `.sandbox-test-${process.pid}`;
  const dir = path.join(config.storage.moviesRoot, marker, 'Sandbox Title (2024)');
  t.after(() => fsp.rm(path.join(config.storage.moviesRoot, marker), { recursive: true, force: true }));

  const script = `
    import fsp from 'node:fs/promises';
    import { ensureDir, moveFile } from '${config.projectRoot}/dist/services/storage.js';
    const dir = ${JSON.stringify(dir)};
    await ensureDir(dir, ${JSON.stringify(config.storage.moviesRoot)});
    const src = ${JSON.stringify(path.join(config.storage.downloadTmpDir, `${marker}.bin`))};
    await fsp.writeFile(src, 'payload');
    await moveFile(src, dir + '/Sandbox Title (2024).bin', ${JSON.stringify(config.storage.moviesRoot)});
  `;

  execFileSync(
    'systemd-run',
    [
      '--user', '--quiet', '--wait', '--pipe',
      '-p', 'PrivateTmp=true',
      '-p', 'NoNewPrivileges=true',
      '-p', 'UMask=0027',
      '-p', `WorkingDirectory=${config.projectRoot}`,
      process.execPath, '--input-type=module', '-e', script,
    ],
    { stdio: 'pipe' },
  );

  // Checked from outside the namespace, where the real gid is visible.
  for (const p of [dir, path.join(dir, 'Sandbox Title (2024).bin')]) {
    assert.equal(await gidOf(p), gid, `${p} must be group ${gid} on disk`);
  }
});
