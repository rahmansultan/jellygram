import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Point every database-backed test at a database of its own.
 *
 * The suites once shared the live database and kept out of its way by
 * convention: synthetic id ranges, fixtures parked a century ahead, a helper
 * that stopped the running worker. The convention broke where it mattered most
 * — a test that claimed "the next job" claimed a real queued upload and marked
 * it completed without doing the work — and every run left rows behind that
 * the dashboard then counted. Conventions are not isolation; a separate
 * database is.
 *
 * The scratch database lives on the same server as your own, so it needs no
 * new credentials and the same migrations shape it. Imported for its side
 * effect, *before* the config module, like the media-root helper:
 * `DATABASE_URL` must already point at the test database when the schema is
 * evaluated, and dotenv never overrides a variable that is already set.
 *
 * The heavy lifting — creating the database on first use and applying the
 * migrations — runs synchronously in a child process, because nothing async
 * can happen between this module evaluating and the config module reading the
 * variable.
 */
/**
 * The scratch database the suites run against.
 *
 * A name, not a URL: it is spliced onto whatever `DATABASE_URL` already points
 * at, so the tests need no second set of credentials and no second server.
 * Override it with `JELLYGRAM_TEST_DATABASE_NAME` when `jellygram_test` is
 * taken.
 */
export const TEST_DATABASE_NAME = process.env['JELLYGRAM_TEST_DATABASE_NAME'] || 'jellygram_test';

function declaredDatabaseUrl(): string {
  const fromEnv = process.env['DATABASE_URL'];
  if (fromEnv) return fromEnv;
  const envFile = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envFile)) return '';
  return /^DATABASE_URL=(.*)$/m.exec(fs.readFileSync(envFile, 'utf8'))?.[1]?.trim() ?? '';
}

/** The same server and credentials, a different database. */
export function testDatabaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${TEST_DATABASE_NAME}`;
  return url.toString();
}

const base = declaredDatabaseUrl();
if (!base) {
  throw new Error(
    'DATABASE_URL is not set and .env does not declare one; the tests need a PostgreSQL server. ' +
      'Copy .env.example to .env and set DATABASE_URL, or export it for this run.',
  );
}
const url = testDatabaseUrl(base);

/**
 * The one invariant that makes this file safe to ship.
 *
 * Everything else here is convenience; this is the guarantee. If the scratch
 * name ever coincides with the database named in `DATABASE_URL` — a developer
 * who called their own database `jellygram_test`, a
 * `JELLYGRAM_TEST_DATABASE_NAME` that points back at itself — the suites would
 * truncate live tables between test
 * files. Refuse to start rather than find out afterwards.
 */
{
  const liveName = new URL(base).pathname.replace(/^\//, '');
  if (liveName === TEST_DATABASE_NAME) {
    throw new Error(
      `DATABASE_URL names "${liveName}", which is also the scratch database the tests destroy ` +
        `between files. Point DATABASE_URL at your real database, or set ` +
        `JELLYGRAM_TEST_DATABASE_NAME to something else.`,
    );
  }
}

// The child gets both addresses through its environment rather than argv, so
// the credentials never appear in a process listing.
execFileSync(process.execPath, [path.join(import.meta.dirname, 'ensure-test-database.js')], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    JELLYGRAM_TEST_DATABASE_URL: url,
    JELLYGRAM_BASE_DATABASE_URL: base,
    LOG_TO_FILE: 'false',
    LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

process.env['DATABASE_URL'] = url;

export const TEST_DATABASE_URL = url;
