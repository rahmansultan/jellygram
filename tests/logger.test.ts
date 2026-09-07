import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config/index.js';
import { scrubString } from '../src/lib/logger.js';

/**
 * Regression tests for the diagnostic blackout.
 *
 * pino runs `formatters.log` BEFORE the `err` serializer. The formatter walked
 * the object with `Object.entries`, and an Error's `message` and `stack` are
 * non-enumerable while `name` lives on the prototype — so every error this
 * application logged came out as `{"message":"","stack":""}`. The real cause of
 * the production failure (a 60s abort on getFile) was invisible for its entire
 * life because of this.
 */

/**
 * A throwaway log directory for the child processes below.
 *
 * The logger writes a dated file per service, so without this every run of the
 * suite appended to the operator's own `logs/` — leaving a `t.log-…` sitting
 * among api, bot and worker as though a fourth service existed. The same rule
 * as the media root: a test writes into its own scratch space, never into the
 * place production keeps its records.
 */
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jellygram-logger-test-'));

test.after(() => {
  fs.rmSync(logDir, { recursive: true, force: true });
});

/** Log one record in a child process and return the parsed JSON line. */
function logRecord(script: string): Record<string, unknown> {
  // `config.projectRoot` walks up to the nearest package.json, so this works
  // from both src/ and the compiled dist-tests/ layout.
  const root = config.projectRoot;
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `import { createLogger } from '${root}/dist/lib/logger.js';\n${script}`],
    {
      encoding: 'utf8',
      cwd: root,
      // Pinned, not inherited. A developer with LOG_LEVEL exported in their
      // shell would otherwise have the child drop the very records these tests
      // read back — the same reason `test-credentials.ts` forces its values
      // rather than defaulting them.
      env: { ...process.env, LOG_DIR: logDir, LOG_LEVEL: 'trace', LOG_TO_FILE: 'true' },
    },
  );
  const line = out.split('\n').find((l) => l.includes('"marker"'));
  assert.ok(line, `no marked log line in output: ${out.slice(0, 400)}`);
  return JSON.parse(line) as Record<string, unknown>;
}

test('a logged Error keeps its message, stack, code and cause', () => {
  const rec = logRecord(`
    const log = createLogger('t');
    const inner = new Error('the underlying cause');
    const err = new Error('outer message');
    err.code = 'EXAMPLE';
    err.cause = inner;
    err.retryable = true;
    log.error({ err, marker: 1 }, 'x');
  `);
  const err = rec['err'] as Record<string, unknown>;

  assert.equal(err['message'], 'outer message', 'message must survive the formatter');
  assert.equal(err['type'], 'Error');
  assert.equal(err['code'], 'EXAMPLE');
  assert.equal(err['retryable'], true, 'own enumerable extras survive too');
  assert.ok(String(err['stack']).includes('outer message'), 'stack must survive');
  assert.equal((err['cause'] as Record<string, unknown>)['message'], 'the underlying cause');
});

test('an Error passed as the first argument is serialized too', () => {
  const rec = logRecord(`
    const log = createLogger('t');
    const err = new Error('direct path');
    log.error(err, 'x');
    log.info({ marker: 1 }, 'x');
  `);
  assert.ok(rec, 'the direct-serializer path did not throw');
});

test('an errno error records the syscall detail an admin needs', () => {
  const rec = logRecord(`
    const log = createLogger('t');
    const fs = await import('node:fs/promises');
    try { await fs.chown('/definitely/not/here', 1000, 117); }
    catch (err) { log.warn({ err, marker: 1 }, 'x'); }
  `);
  const err = rec['err'] as Record<string, unknown>;
  assert.equal(err['code'], 'ENOENT');
  assert.equal(err['syscall'], 'chown');
  assert.ok(String(err['message']).length > 0, 'the errno message is not blanked');
});

test('secrets are still redacted through the Error path', () => {
  const rec = logRecord(`
    const log = createLogger('t');
    const err = new Error('GET https://api.telegram.org/bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/getFile failed');
    err.authorization = 'super-secret-value';
    log.error({ err, marker: 1 }, 'x');
  `);
  const text = JSON.stringify(rec);
  assert.ok(!text.includes('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 'bot token must not survive');
  assert.ok(text.includes('[REDACTED]'));
  assert.ok(!text.includes('super-secret-value'), 'a secret-named key must be redacted');
});

test('scrubString redacts a bot token in a URL', () => {
  const out = scrubString('https://api.telegram.org/bot987654321:ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ/getFile');
  assert.ok(!out.includes('ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'));
});

test('scrubString redacts a Postgres password', () => {
  const out = scrubString('postgres://user:hunter2@127.0.0.1:5432/db');
  assert.ok(!out.includes('hunter2'));
});
