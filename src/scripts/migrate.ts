import { createLogger } from '../lib/logger.js';
import { runMigrations } from '../db/migrate.js';
import { closePool } from '../db/pool.js';
import { ensureDirectories } from '../config/index.js';
import { reportStartupFailure } from '../lib/startup.js';

const log = createLogger('cli');

try {
  ensureDirectories();
  const applied = await runMigrations();
  log.info(
    { applied, count: applied.length },
    applied.length ? 'Migrations applied' : 'Database already up to date',
  );
} catch (err) {
  log.error({ err }, 'Migration run failed');
  reportStartupFailure(err);
  process.exitCode = 1;
} finally {
  await closePool();
}
