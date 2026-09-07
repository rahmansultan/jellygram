import { stdout } from 'node:process';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { closePool } from '../db/pool.js';
import { mtprotoJobsRepo } from '../db/repositories.js';
import { disconnectClient, status } from '../services/mtproto.js';
import { formatBytes } from '../services/storage.js';

/**
 * Report MTProto readiness and recent ingestion jobs.
 *
 *   npm run telegram:mtproto:status
 *
 * Never prints the session, the API hash, or any other secret.
 */

const log = createLogger('cli');

function say(text = ''): void {
  stdout.write(`${text}\n`);
}

async function main(): Promise<void> {
  say();
  say('MTProto ingestion status');
  say('========================');
  say();

  // The CLI is the one place a real connection check is wanted.
  const s = await status({ probe: true });

  say(`Enabled           : ${s.enabled}`);
  say(`API credentials   : ${s.credentialsPresent ? 'present' : 'MISSING'}`);
  say(`Session file      : ${s.sessionPresent ? config.mtproto.sessionPath : '(none)'}`);
  say(`Session file mode : ${s.sessionPathMode ?? 'n/a'}${s.sessionPathMode === '0600' ? ' (correct)' : s.sessionPathMode ? ' — expected 0600' : ''}`);
  say(`Authorised        : ${s.authorized}`);
  if (s.account) {
    say(
      `Account           : ${s.account.username ? `@${s.account.username}` : (s.account.firstName ?? 'unknown')}`,
    );
  }
  say(`Max file size     : ${formatBytes(config.mtproto.maxFileBytes)}`);
  say(`Chunk size        : ${formatBytes(config.mtproto.chunkBytes)}`);
  say();
  say(s.message);

  // --- Recent jobs ----------------------------------------------------------
  const recent = await mtprotoJobsRepo.search({ limit: 10, offset: 0 }).catch(() => null);
  if (recent && recent.rows.length > 0) {
    say();
    say('Recent ingestion jobs');
    say('---------------------');
    for (const job of recent.rows) {
      const pct =
        job.file_size > 0 ? `${Math.round((job.bytes_downloaded / job.file_size) * 100)}%` : '—';
      say(
        `  #${job.id} ${job.status.padEnd(12)} ${formatBytes(job.file_size).padStart(9)} ` +
          `${pct.padStart(5)}  ${job.file_name.slice(0, 48)}`,
      );
      if (job.error_message) say(`      ${job.error_message.slice(0, 100)}`);
    }
  }
  say();

  if (!s.enabled || !s.authorized) process.exitCode = 1;
}

main()
  .catch((err) => {
    log.error({ err }, 'Could not read MTProto status');
    say(`Failed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectClient().catch(() => {});
    await closePool();
  });
