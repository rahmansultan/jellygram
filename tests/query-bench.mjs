import { performance } from 'node:perf_hooks';

/**
 * Query timings against a dataset large enough to matter.
 *
 * Production holds a few hundred rows, where every plan looks fast and every
 * missing index is invisible. This points the *real* repository functions at a
 * scratch database seeded to the scale the system is meant to reach, so what is
 * measured is the SQL that actually ships.
 *
 * Refuses to run against anything but a database whose name ends in `_perf`:
 * some of these queries are deliberately expensive and none of them belong
 * near real data.
 *
 * Usage: DATABASE_URL=postgres://…/jellygram_perf node tests/query-bench.mjs
 */

const url = process.env.DATABASE_URL ?? '';
const dbName = url.split('/').pop()?.split('?')[0] ?? '';
if (!dbName.endsWith('_perf')) {
  process.stdout.write(
    `Refusing to run: DATABASE_URL must name a scratch database ending in "_perf" (got "${dbName}").\n`,
  );
  process.exit(2);
}

const { uploadsRepo, mediaRepo, auditRepo, usersRepo, jobsRepo, sessionsRepo, librariesRepo } =
  await import('../dist/db/repositories.js');
const { pool, closePool } = await import('../dist/db/pool.js');

/** The slowest of several runs, because a p50 hides the plan that matters. */
async function time(label, budgetMs, fn) {
  await fn(); // warm the plan cache and the buffer pool
  const samples = [];
  for (let i = 0; i < 5; i += 1) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  const worst = Math.max(...samples);
  const median = samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  const ok = worst <= budgetMs;
  if (!ok) failures += 1;
  process.stdout.write(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${median.toFixed(1).padStart(7)}ms median  ${worst
      .toFixed(1)
      .padStart(7)}ms worst  (budget ${budgetMs}ms)\n`,
  );
}

let failures = 0;

const counts = await pool.query(
  `SELECT
     (SELECT count(*) FROM uploads)::int AS uploads,
     (SELECT count(*) FROM media)::int AS media,
     (SELECT count(*) FROM audit_logs)::int AS audit,
     (SELECT count(*) FROM jobs)::int AS jobs,
     (SELECT count(*) FROM users)::int AS users`,
);
const size = counts.rows[0];
process.stdout.write(
  `\nQuery benchmark\n===============\n\n${size.uploads} uploads · ${size.media} media · ${size.audit} audit rows · ${size.jobs} jobs · ${size.users} users\n\n`,
);

process.stdout.write('Lists the dashboard polls every few seconds\n');
await time('uploads: first page, unfiltered', 60, () =>
  uploadsRepo.search({ limit: 25, offset: 0 }),
);
await time('uploads: filtered by user', 60, () =>
  uploadsRepo.search({ userId: 7, limit: 25, offset: 0 }),
);
await time('uploads: filtered by status', 60, () =>
  uploadsRepo.search({ status: 'FAILED', limit: 25, offset: 0 }),
);
await time('uploads: user + status', 60, () =>
  uploadsRepo.search({ userId: 7, status: 'COMPLETED', limit: 25, offset: 0 }),
);
await time('uploads: text search', 150, () =>
  uploadsRepo.search({ q: 'Movie 12345', limit: 25, offset: 0 }),
);
await time('uploads: deep page (offset 10000)', 250, () =>
  uploadsRepo.search({ limit: 25, offset: 10_000 }),
);
await time('uploads: status counts', 150, () => uploadsRepo.statusCounts());
await time('uploads: recent 10', 40, () => uploadsRepo.recent(10));

process.stdout.write('\nThe user page\n');
await time('user: status counts for one user', 60, () => uploadsRepo.statusCountsForUser(7));
await time('user: first/last/median activity', 120, () => uploadsRepo.activityForUser(7));
await time('user: media counts', 80, () => mediaRepo.countsForUser(7));
await time('user: their uploads, page 1', 60, () =>
  uploadsRepo.search({ userId: 7, limit: 10, offset: 0 }),
);
await time('user: their audit trail', 40, () =>
  auditRepo.search({ entityType: 'user', entityId: '7', limit: 20, offset: 0 }),
);

process.stdout.write('\nMedia and storage\n');
await time('media: first page', 60, () => mediaRepo.search({ limit: 25, offset: 0 }));
await time('media: filtered by user and type', 60, () =>
  mediaRepo.search({ userId: 7, type: 'movie', limit: 25, offset: 0 }),
);
await time('media: global counts', 200, () => mediaRepo.counts());
await time('storage: usage for every user', 200, () => usersRepo.storageUsage());
await time('users: the list the dashboard caches', 200, () =>
  Promise.all([usersRepo.list(), usersRepo.storageUsage(), librariesRepo.listAll()]),
);

process.stdout.write('\nActivity\n');
await time('audit: first page', 60, () => auditRepo.search({ limit: 25, offset: 0 }));
await time('audit: filtered by actor', 100, () =>
  auditRepo.search({ actorType: 'admin', limit: 25, offset: 0 }),
);
await time('audit: filtered by action prefix', 100, () =>
  auditRepo.search({ action: 'upload.', limit: 25, offset: 0 }),
);
await time('audit: distinct actions for the filter', 200, () => auditRepo.actions());

process.stdout.write('\nQueue\n');
await time('jobs: stats', 150, () => jobsRepo.stats());
await time('jobs: waiting uploads', 60, () => jobsRepo.waitingUploadJobs(50));
await time('sessions: status counts', 80, () => sessionsRepo.statusCounts());

process.stdout.write(
  `\n===============\n${failures === 0 ? 'ALL QUERIES WITHIN BUDGET' : `${failures} QUERY/QUERIES OVER BUDGET`}\n\n`,
);
await closePool();
if (failures > 0) process.exitCode = 1;
