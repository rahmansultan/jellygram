import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from './pool.js';
import { config } from '../config/index.js';
import { getLogger } from '../lib/logger.js';

const MIGRATIONS_DIR = path.join(config.projectRoot, 'migrations');

/**
 * Minimal forward-only migration runner. Each `.sql` file runs once, inside a
 * transaction, in filename order, under an advisory lock so that two services
 * starting at the same time cannot race.
 */
export async function runMigrations(): Promise<string[]> {
  const log = getLogger();
  const applied: string[] = [];

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [4711_0001]);

    // Under the lock, like everything else here: three services start at once
    // and two concurrent CREATE TABLE IF NOT EXISTS on a fresh database can
    // both pass the existence check and then collide on the catalogue.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
        (r) => r.name,
      ),
    );

    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      log.info({ migration: file }, 'Applying migration');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        log.error({ err, migration: file }, 'Migration failed');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [4711_0001]).catch(() => {});
    client.release();
  }

  return applied;
}
