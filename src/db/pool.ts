import pg from 'pg';
import { config } from '../config/index.js';
import { getLogger } from '../lib/logger.js';

/**
 * A single shared connection pool per process.
 *
 * `BIGINT` (OID 20) and `NUMERIC` (OID 1700) are parsed into JS numbers here.
 * Every bigint column in this schema holds row ids, byte counts and Telegram
 * chat ids, all far below Number.MAX_SAFE_INTEGER, and JSON-serialising a
 * BigInt throws.
 */
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

/**
 * Ceiling on any one statement, set on the session at connect time.
 *
 * The server's default is no limit at all, so a single runaway query — a text
 * search over a large audit table, say — could hold one of a handful of pool
 * slots for as long as it liked. Generous enough for every statement this
 * application issues, including index builds in migrations.
 */
const STATEMENT_TIMEOUT_MS = 5 * 60_000;

export const pool = new pg.Pool({
  connectionString: config.db.url,
  max: config.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'jellygram',
  options: `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
});

pool.on('error', (err) => {
  getLogger().error({ err }, 'Unexpected error on idle database client');
});

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
  client: Queryable = pool,
): Promise<pg.QueryResult<T>> {
  return client.query<T>(text, params as unknown[]);
}

/** Run `fn` inside a transaction, rolling back on any thrown error. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; the pool will discard it.
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

/** True when the database answers a trivial query. Used by /api/system/status. */
export async function pingDatabase(): Promise<boolean> {
  return (await pingDatabaseDetailed()) === null;
}

/**
 * The same probe, keeping the reason. `null` means the database answered;
 * otherwise the error, so a startup wait can say *why* it is still waiting.
 */
export async function pingDatabaseDetailed(): Promise<Error | null> {
  try {
    await pool.query('SELECT 1');
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}
