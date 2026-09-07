import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * A worker of this suite's own, for suites that put jobs on the queue and wait
 * for them to be claimed and finished.
 *
 * It runs against this process's environment, which the database and media
 * helpers have already pointed at the test database and the scratch tree — so
 * it can only ever see this suite's jobs and only ever write under the scratch
 * root. The live worker is not involved at all: it watches a different
 * database. (An earlier version stopped the live worker with systemctl to keep
 * it from claiming shared jobs; two suites doing that at once restarted it in
 * the middle of the other's run and it filed a fixture into the real library.)
 *
 * Started un-paused deliberately: the suite's own process enqueues in drain
 * mode so that *it* never competes with this worker for the same job.
 *
 * The compiled tree under `dist-tests/src` is used rather than `dist/`, so the
 * worker runs exactly the code the suite was built against.
 */
let replacement: ChildProcess | null = null;

function start(): void {
  replacement = spawn(
    process.execPath,
    [path.join(process.cwd(), 'dist-tests', 'src', 'worker', 'index.js')],
    {
      cwd: process.cwd(),
      env: { ...process.env, QUEUE_PAUSED: 'false', LOG_TO_FILE: 'false', LOG_LEVEL: 'warn' },
      stdio: 'ignore',
    },
  );
  replacement.unref();
}

function stop(): void {
  if (!replacement) return;
  const child = replacement;
  replacement = null;
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
}

start();
process.on('exit', stop);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    stop();
    process.exit(1);
  });
}
