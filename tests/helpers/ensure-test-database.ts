import pg from 'pg';

/**
 * Create the test database if it is missing and bring it up to date.
 *
 * Run as a child process by `test-database.ts`, never imported: it has to
 * finish before the parent's configuration is read, and it has to import the
 * application's migration runner *after* `DATABASE_URL` has been redirected.
 *
 * Several test files start at once under `node --test`, so every step here
 * tolerates a sibling doing the same thing a moment earlier: an existing
 * database is fine, a template briefly busy is retried, and the migration
 * runner takes an advisory lock of its own.
 */
const url = process.env['JELLYGRAM_TEST_DATABASE_URL'] ?? '';
const base = process.env['JELLYGRAM_BASE_DATABASE_URL'] ?? '';
if (!url || !base) {
  process.stderr.write('ensure-test-database: JELLYGRAM_TEST_DATABASE_URL and JELLYGRAM_BASE_DATABASE_URL are required\n');
  process.exit(2);
}

const name = new URL(url).pathname.replace(/^\//, '');
if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
  process.stderr.write(`ensure-test-database: refusing to create a database named ${JSON.stringify(name)}\n`);
  process.exit(2);
}

async function canConnect(target: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: target, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    return true;
  } catch (err) {
    // 3D000: the database does not exist. Anything else is a real failure.
    if ((err as { code?: string }).code === '3D000') return false;
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

async function createDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: base, connectionTimeoutMillis: 10_000 });
  await admin.connect();
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await admin.query(`CREATE DATABASE "${name}"`);
        return;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === '42P04') return; // a sibling created it first
        // 55006: the template is in use — a sibling is mid-CREATE. Wait for it.
        if (code === '55006' && attempt < 20) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        if (code === '42501') {
          throw new Error(
            `The database role may not create databases. Either grant it CREATEDB, or ` +
              `create the scratch database once by hand:\n` +
              `  createdb ${name}\n` +
              `  psql -d postgres -c 'CREATE DATABASE ${name}'   # or, from inside a container`,
          );
        }
        throw err;
      }
    }
  } finally {
    await admin.end().catch(() => {});
  }
}

if (!(await canConnect(url))) await createDatabase();

// Only now may the application see the redirected address.
process.env['DATABASE_URL'] = url;
const { runMigrations } = await import('../../src/db/migrate.js');
const { closePool } = await import('../../src/db/pool.js');
try {
  await runMigrations();
} finally {
  await closePool();
}
