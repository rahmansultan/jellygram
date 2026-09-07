import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { stdout } from 'node:process';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { closePool, query } from '../db/pool.js';
import { formatBytes } from '../services/storage.js';

/**
 * Compressed PostgreSQL backup with retention.
 *
 *   npm run db:backup
 *
 * Run from a systemd timer. The database holds every user, upload, media
 * record, Jellyfin item id and token hash: the media files survive its loss,
 * but the system's knowledge of them does not.
 *
 * The password is passed through the environment, never on the command line,
 * so it cannot appear in `ps` output; `pg_dump` is invoked with `execFile` and
 * an argument array, so nothing reaches a shell. Neither the URL nor the
 * password is ever logged.
 */

const log = createLogger('backup');

function say(text = ''): void {
  stdout.write(`${text}\n`);
}

/** Split DATABASE_URL into pg_dump arguments plus an environment password. */
function connection(): { args: string[]; env: NodeJS.ProcessEnv; database: string } {
  const url = new URL(config.db.url);
  const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres';
  return {
    args: [
      '--host', url.hostname,
      '--port', url.port || '5432',
      '--username', decodeURIComponent(url.username),
      '--dbname', database,
      // A plain SQL dump restores with psql alone — no pg_restore version
      // matching to get wrong at three in the morning.
      '--format', 'plain',
      '--no-owner',
      '--no-privileges',
    ],
    env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
    database,
  };
}

/** Timestamp safe for a filename and sortable as a string. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

async function prune(dir: string, keepDays: number): Promise<number> {
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !/^jellygram-.*\.sql\.gz$/.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat || stat.mtimeMs >= cutoff) continue;
    await fsp.unlink(full).catch(() => {});
    removed += 1;
  }
  return removed;
}

async function main(): Promise<void> {
  const dir = path.resolve(config.backup.dir);
  // 0700: a dump is a complete copy of the database.
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700).catch(() => {});

  const startedAt = Date.now();
  const { rows } = await query<{ id: number }>(
    `INSERT INTO backups (status) VALUES ('RUNNING') RETURNING id`,
  );
  const id = rows[0]?.id;

  const target = path.join(dir, `jellygram-${stamp(new Date())}.sql.gz`);
  const { args, env, database } = connection();

  try {
    await new Promise<void>((resolve, reject) => {
      // `spawn`, not `execFile`: execFile accumulates stdout in memory as well
      // as handing it to us, and kills the child the moment that buffer passes
      // `maxBuffer` — so the nightly dump began failing with 'Premature close'
      // the day the database grew past one megabyte. spawn buffers nothing.
      const child = spawn('pg_dump', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      if (!child.stdout) return reject(new Error('pg_dump produced no output stream'));

      // 0600 from the moment it exists, not chmod-ed afterwards.
      const sink = fs.createWriteStream(target, { mode: 0o600 });
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk).slice(0, 2000);
      });

      pipeline(child.stdout, zlib.createGzip({ level: 6 }), sink).then(resolve, reject);
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`pg_dump exited ${code}: ${stderr.trim().slice(0, 300)}`));
      });
    });

    const stat = await fsp.stat(target);
    // An empty or near-empty dump means pg_dump "succeeded" without producing
    // anything usable, which is worse than a clean failure.
    if (stat.size < 1024) {
      throw new Error(`Backup is implausibly small (${stat.size} bytes); treating it as failed`);
    }

    const durationMs = Date.now() - startedAt;
    await query(
      `UPDATE backups SET status='COMPLETED', finished_at=now(), path=$2, size_bytes=$3, duration_ms=$4
        WHERE id=$1`,
      [id, target, stat.size, durationMs],
    );

    const pruned = await prune(dir, config.backup.retentionDays);
    log.info(
      { database, bytes: stat.size, durationMs, pruned, retentionDays: config.backup.retentionDays },
      'Database backup completed',
    );
    say(`Backup written: ${target}`);
    say(`Size: ${formatBytes(stat.size)}  Duration: ${Math.round(durationMs / 1000)}s  Pruned: ${pruned}`);
  } catch (err) {
    await fsp.rm(target, { force: true }).catch(() => {});
    await query(
      `UPDATE backups SET status='FAILED', finished_at=now(), duration_ms=$2, error_message=$3 WHERE id=$1`,
      [id, Date.now() - startedAt, (err as Error).message.slice(0, 2000)],
    ).catch(() => {});
    // The message is scrubbed by the logger, and the URL never reaches it.
    log.error({ err }, 'Database backup failed');
    say(`Backup FAILED: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    log.error({ err }, 'Backup run failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
