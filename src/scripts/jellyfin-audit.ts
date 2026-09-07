import { stdout } from 'node:process';
import { createLogger } from '../lib/logger.js';
import { closePool } from '../db/pool.js';
import { auditIsolation, enforceIsolation } from '../services/isolation.js';

/**
 * Check — and optionally repair — per-user media isolation from the command
 * line, so the guarantee can be verified without opening the dashboard.
 *
 *   npm run jellyfin:audit
 *   npm run jellyfin:audit -- --fix
 */

const log = createLogger('cli');

async function main(): Promise<void> {
  if (process.argv.includes('--fix')) {
    stdout.write('Re-applying isolation for every managed user...\n\n');
    const result = await enforceIsolation();
    for (const name of result.repaired) stdout.write(`  provisioned ${name}\n`);
    for (const warning of result.warnings) stdout.write(`  ! ${warning}\n`);
    stdout.write('\n');
  }

  const report = await auditIsolation();

  if (!report.checked) {
    stdout.write('Isolation could not be verified.\n');
    for (const f of report.findings) stdout.write(`  ${f.severity}: ${f.message}\n`);
    process.exitCode = 2;
    return;
  }

  stdout.write(`Managed libraries: ${report.managedLibraries}\n`);
  stdout.write(`Checked at: ${report.checkedAt}\n\n`);

  if (report.findings.length === 0) {
    stdout.write('No findings. Every account sees only its own libraries.\n');
  }
  for (const f of report.findings) {
    const marker = f.severity === 'error' ? 'FAIL' : f.severity === 'warning' ? 'WARN' : 'INFO';
    stdout.write(`  [${marker}] ${f.message}\n`);
  }

  stdout.write(`\nIsolation ${report.ok ? 'OK' : 'BROKEN'}\n`);
  if (!report.ok) process.exitCode = 1;
}

main()
  .catch((err) => {
    log.error({ err }, 'Audit failed');
    stdout.write(`Failed: ${(err as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
