import { stdout } from 'node:process';
import { closePool, pingDatabaseDetailed } from '../db/pool.js';

/**
 * Block until PostgreSQL answers, or give up.
 *
 * PostgreSQL runs in a Docker container; the API, bot and worker run as
 * systemd *user* services, which cannot order themselves after a system unit.
 * At every boot all three therefore started before Docker had the database
 * ready and died — `ECONNREFUSED`, then `the database system is starting up` —
 * logging a FATAL each time and relying on `Restart=always` to eventually get
 * lucky. Recovery worked, but every reboot wrote several genuine-looking
 * incidents into the log, and the only thing standing between that and a
 * permanently failed unit was `StartLimitBurst=0`.
 *
 * Run as `ExecStartPre`, this converts "crash until the database appears" into
 * "wait for the database, then start". It deliberately still gives up: a
 * database that never arrives is a real failure and should surface as one
 * rather than as a unit that hangs in `activating` for ever.
 *
 *   node dist/scripts/wait-for-db.js [--timeout-sec 120]
 */

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const timeoutSec = Math.max(1, Number(arg('timeout-sec') ?? 120));
const INTERVAL_MS = 1000;

async function main(): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  let attempts = 0;
  let lastError: Error | null = null;

  for (;;) {
    attempts += 1;
    lastError = await pingDatabaseDetailed().catch((err: unknown) =>
      err instanceof Error ? err : new Error(String(err)),
    );
    if (lastError === null) {
      // One line, only when the wait was real: a service that starts cleanly
      // should not add noise to every boot.
      if (attempts > 1) stdout.write(`Database ready after ${attempts} attempt(s).\n`);
      return;
    }

    if (Date.now() >= deadline) {
      // The reason is the one thing an operator needs here: a wrong password
      // and a container still starting look identical without it. pg's error
      // text names the host and the role, never the password.
      stdout.write(
        `Database did not become ready within ${timeoutSec}s (${attempts} attempts): ${lastError.message}\n`,
      );
      process.exitCode = 1;
      return;
    }

    // Progress at a human pace, so a long wait is visible without a line a
    // second filling the journal.
    if (attempts % 10 === 0) {
      stdout.write(`Still waiting for the database (${attempts}s)…\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

main()
  .catch((err) => {
    stdout.write(`Could not check the database: ${(err as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
