import { stdout } from 'node:process';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { dirModeWithSetgid, exists, mediaGid, repairOwnership } from '../services/storage.js';

/**
 * Re-apply media-tree permissions and group ownership.
 *
 *   npm run media:repair
 *
 * Safe to run at any time: it only chmods and chgrps, never moves or deletes.
 */

const log = createLogger('cli');

function say(text = ''): void {
  stdout.write(`${text}\n`);
}

async function main(): Promise<void> {
  const gid = await mediaGid();
  say();
  say('Media permission repair');
  say('=======================');
  say(`Root       : ${config.storage.mediaRoot}`);
  say(`Group      : ${config.storage.mediaGroup}${gid === null ? ' (NOT FOUND)' : ` (gid ${gid})`}`);
  say(`Dir mode   : 0${dirModeWithSetgid(config.storage.dirMode).toString(8)} (setgid: new entries inherit the group)`);
  say(`File mode  : 0${config.storage.fileMode.toString(8)}`);
  say();

  if (gid === null) {
    say(`Group "${config.storage.mediaGroup}" does not exist. Create it, or set MEDIA_GROUP, then re-run.`);
    process.exitCode = 1;
    return;
  }

  // The staging directories matter as much as the library ones: a temp file is
  // created in `.incoming` and then *renamed* into place, and rename keeps the
  // group it was born with. If `.incoming` is not setgid, every filed file
  // arrives with the wrong group however correct the library tree is.
  const roots = [
    config.storage.mediaRoot,
    config.storage.moviesRoot,
    config.storage.tvRoot,
    config.storage.downloadTmpDir,
    config.multipart.partsDir,
    config.storage.quarantineDir,
  ].filter((r): r is string => Boolean(r));

  const total = { directories: 0, files: 0 };
  const seen = new Set<string>();
  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    if (!(await exists(root))) continue;
    // The media root is walked non-recursively first so its own mode and group
    // are fixed before anything is created beneath it; the subtrees below then
    // cover their own contents.
    const r = await repairOwnership(root, config.storage.mediaRoot);
    say(`  ${root}: ${r.directories} directories, ${r.files} files`);
    total.directories += r.directories;
    total.files += r.files;
  }

  say();
  say(`Done: ${total.directories} directories, ${total.files} files.`);
}

main().catch((err) => {
  log.error({ err }, 'Permission repair failed');
  say(`Failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
