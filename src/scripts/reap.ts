import { stdout } from 'node:process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { closePool } from '../db/pool.js';
import { reapBotApiData, reapDownloadTmp, reapParts, type ReapResult } from '../services/reaper.js';
import { formatBytes } from '../services/storage.js';

/**
 * Clear staging space on demand.
 *
 * The worker reaps on a schedule, but only once a file has sat untouched for
 * `DOWNLOAD_TMP_GRACE_HOURS`. That grace is what makes the reaper safe to run
 * beside live transfers, and it also means a test run leaves tens of megabytes
 * of scratch behind for a day — with no way to say "I know what those are,
 * take them now" short of `rm`, which knows none of the rules that keep a live
 * upload's staging file alive.
 *
 *   npm run media:reap                  what would go, at the configured grace
 *   npm run media:reap -- --apply       actually remove it
 *   npm run media:reap -- --grace-hours 0 --apply
 *
 * Reports by default and removes nothing: the destructive direction is the one
 * that has to be asked for. Every safety rule still applies whatever the grace
 * — the staging file of a live upload, the parts of an open session, and the
 * parts a FAILED session deliberately retains for retry are all protected by
 * the reaper itself, not by the delay.
 */

const log = createLogger('cli');

function say(text = ''): void {
  stdout.write(`${text}\n`);
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function line(label: string, result: ReapResult, applied: boolean): void {
  const verb = applied ? 'removed' : 'would remove';
  say(
    `  ${label.padEnd(22)} ${verb} ${String(result.removed).padStart(4)}  ` +
      `${formatBytes(result.bytes).padStart(10)}   kept ${result.kept}` +
      (result.failed ? `   FAILED ${result.failed}` : ''),
  );
}

/** What the reaper would delete, measured without deleting it. */
async function measure(dir: string, graceMs: number, now: number): Promise<ReapResult> {
  let removed = 0;
  let bytes = 0;
  let kept = 0;
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return { removed: 0, bytes: 0, kept: 0, failed: 0 };
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    const stat = await fsp.lstat(full).catch(() => null);
    if (!stat) continue;
    if (now - stat.mtimeMs < graceMs) {
      kept += 1;
      continue;
    }
    removed += 1;
    bytes += stat.size;
  }
  return { removed, bytes, kept, failed: 0 };
}

async function main(): Promise<void> {
  const applied = process.argv.includes('--apply');
  const graceHours = arg('grace-hours');
  const graceMs =
    graceHours === undefined
      ? config.storage.downloadTmpGraceHours * 60 * 60 * 1000
      : Math.max(0, Number(graceHours)) * 60 * 60 * 1000;

  say();
  say('Staging reaper');
  say('==============');
  say();
  say(`  grace     ${graceMs / 3_600_000} hour(s)`);
  say(`  staging   ${config.storage.downloadTmpDir}`);
  say(`  parts     ${config.multipart.partsDir}`);
  say(`  mode      ${applied ? 'APPLY — files will be deleted' : 'report only (pass --apply to remove)'}`);
  say();

  if (!applied) {
    // An upper bound on age alone: the live-path and session checks below can
    // only ever protect *more*, never less, so this never understates what
    // would survive.
    const now = Date.now();
    line('staging (upper bound)', await measure(config.storage.downloadTmpDir, graceMs, now), false);
    line('parts (upper bound)', await measure(config.multipart.partsDir, graceMs, now), false);
    say();
    say('  Nothing was deleted. Re-run with --apply to remove.');
    say('  Live uploads, open sessions and the parts a FAILED session keeps for');
    say('  retry are protected regardless of the grace.');
    return;
  }

  line('staging', await reapDownloadTmp({ graceMs }), true);
  line('parts', await reapParts({ graceMs }), true);
  line('bot API data', await reapBotApiData({ graceMs }), true);
  say();
}

main()
  .catch((err) => {
    log.error({ err }, 'Reap failed');
    process.exitCode = 1;
  })
  .finally(() => closePool());
