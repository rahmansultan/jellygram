import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Every test file that can reach the database must redirect it first.
 *
 * `tests/helpers/test-database.js` points `DATABASE_URL` at a scratch database
 * before the configuration module reads it. A file that forgets the import
 * does not fail loudly — it quietly runs against whatever `DATABASE_URL` names,
 * which on a developer's machine is their real deployment. That is how
 * `reaper-botapi.test.ts` came to read the live upload, session and MTProto
 * tables: it imported a service, the service imported a repository, and
 * nothing in between said so.
 *
 * Checking imports by eye does not scale, and the reach is transitive: a test
 * importing `services/reaper.js` reaches `db/pool.js` three hops away. So this
 * walks the real import graph from `src/db/pool.ts` — the single door to
 * PostgreSQL — and asserts that every test file with a path to it takes the
 * redirect.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const TESTS = path.join(ROOT, 'tests');

/** Static `from '...'` specifiers, ignoring `import type`. */
function importsOf(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of source.matchAll(/(?:^|\n)\s*import\s+([\s\S]*?)from\s+'([^']+)'/g)) {
    if (/^\s*type\b/.test(m[1] ?? '')) continue; // erased at compile time
    out.push(m[2] as string);
  }
  for (const m of source.matchAll(/(?:^|\n)\s*import\s+'([^']+)'/g)) out.push(m[1] as string);
  return out;
}

/** Resolve a relative specifier written for the build output back to its .ts. */
function resolveFrom(file: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const asTs = path.resolve(path.dirname(file), spec).replace(/\.js$/, '.ts');
  return fs.existsSync(asTs) ? asTs : null;
}

/** Every module under src/ with a transitive path to the database pool. */
function modulesReachingThePool(): Set<string> {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(SRC);

  const edges = new Map<string, string[]>();
  for (const f of files) {
    edges.set(
      f,
      importsOf(f)
        .map((s) => resolveFrom(f, s))
        .filter((x): x is string => x !== null),
    );
  }

  const pool = path.join(SRC, 'db', 'pool.ts');
  assert.ok(fs.existsSync(pool), 'src/db/pool.ts is the door this test watches');

  // Fixed point: a module reaches the pool if it is the pool, or imports
  // something that does.
  const reaches = new Set<string>([pool]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [file, deps] of edges) {
      if (reaches.has(file)) continue;
      if (deps.some((d) => reaches.has(d))) {
        reaches.add(file);
        changed = true;
      }
    }
  }
  return reaches;
}

/**
 * Files that reach the pool by import but never issue a query.
 *
 * `pg.Pool` opens no socket until something calls `query` or `connect`, so a
 * test that imports a pure function from a module which *also* imports the
 * pool touches nothing. These files take `classify`, `parseFilename`,
 * `planUpload`, `formatBytes` and friends, and adding the database helper to
 * them would mean requiring PostgreSQL to run tests that need none.
 *
 * The allowance is not a promise anybody has to remember: the test below
 * re-derives it, and fails if one of these ever gains a repository call.
 */
const NO_QUERY = new Set([
  'errors.test.ts',
  'hardening.test.ts',
  'isolation.test.ts',
  'upload-plan.test.ts',
  'validation.test.ts',
]);

/** Anything that would make `pg` actually connect. */
const QUERY_CALL =
  /\b(?:uploadsRepo|usersRepo|mediaRepo|jobsRepo|sessionsRepo|partsRepo|adminsRepo|settingsRepo|auditRepo|backupsRepo|mtprotoJobsRepo|tokensRepo|librariesRepo)\s*\.|\bquery\s*\(|\bpool\s*\.|\brunMigrations\s*\(/;

function suiteFiles(): string[] {
  return fs
    .readdirSync(TESTS)
    .filter((f) => f.endsWith('.test.ts') || f.endsWith('.e2e.ts'))
    .map((f) => path.join(TESTS, f));
}

test('every test file that can reach the database redirects it first', () => {
  const reaches = modulesReachingThePool();
  const testFiles = suiteFiles();

  assert.ok(testFiles.length > 10, `expected the suite, found ${testFiles.length} files`);

  const offenders: string[] = [];
  for (const file of testFiles) {
    const name = path.basename(file);
    const specs = importsOf(file);
    const touchesDb = specs.some((s) => {
      const resolved = resolveFrom(file, s);
      return resolved !== null && reaches.has(resolved);
    });
    const redirects = specs.some((s) => s.includes('helpers/test-database'));
    if (touchesDb && !redirects && !NO_QUERY.has(name)) offenders.push(name);
  }

  assert.deepEqual(
    offenders,
    [],
    `these import something that reaches src/db/pool.ts but never import ` +
      `helpers/test-database.js, so they would run against DATABASE_URL itself. ` +
      `Add the import, or — only if the file issues no query at all — add it to ` +
      `NO_QUERY here: ${offenders.join(', ')}`,
  );
});

test('a file allowed to skip the redirect still issues no query', () => {
  // What keeps NO_QUERY from becoming a place to silence this test.
  const broken: string[] = [];
  for (const file of suiteFiles()) {
    const name = path.basename(file);
    if (!NO_QUERY.has(name)) continue;
    const body = fs.readFileSync(file, 'utf8');
    if (QUERY_CALL.test(body)) broken.push(name);
  }
  assert.deepEqual(
    broken,
    [],
    `these are listed as issuing no query, but now call one — they need ` +
      `helpers/test-database.js and removal from NO_QUERY: ${broken.join(', ')}`,
  );
});

test('NO_QUERY does not list files that are not in the suite', () => {
  const present = new Set(suiteFiles().map((f) => path.basename(f)));
  const stale = [...NO_QUERY].filter((n) => !present.has(n));
  assert.deepEqual(stale, [], `NO_QUERY names files that no longer exist: ${stale.join(', ')}`);
});

test('the check is not vacuous — it can see the database-backed files', () => {
  // If the import walk broke, `reaches` would be nearly empty and the test
  // above would pass by accident. Pin a file that must be in it.
  const reaches = modulesReachingThePool();
  assert.ok(
    reaches.has(path.join(SRC, 'services', 'reaper.ts')),
    'services/reaper.ts reaches the pool through the repositories; the walk missed it',
  );
  assert.ok(
    reaches.has(path.join(SRC, 'db', 'repositories.ts')),
    'db/repositories.ts imports the pool directly; the walk missed it',
  );
  assert.ok(reaches.size > 5, `only ${reaches.size} modules reach the pool; the walk is broken`);
});
