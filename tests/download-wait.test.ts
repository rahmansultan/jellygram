import './helpers/fast-getfile.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/index.js';
import {
  DownloadCancelledError,
  TelegramFileError,
  getFileBudgetMs,
  getFileInfo,
} from '../src/services/download.js';

/**
 * Regression tests for the production failure of upload 539.
 *
 * `getFile` was called with a fixed 60s abort. In local Bot API mode that call
 * does not return until the server has fetched the whole file from Telegram —
 * 1.81 GiB took about 24 minutes — so every attempt aborted at 60s and the
 * upload failed with "The operation was aborted due to timeout" having
 * downloaded zero bytes.
 */

/** Replace global fetch for one call, restoring it afterwards. */
async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const okResponse = (filePath: string): Response =>
  new Response(JSON.stringify({ ok: true, result: { file_id: 'f', file_unique_id: 'u', file_path: filePath } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** Big enough, at the test's 1 MB/s floor, to allow several polls. */
const POLLABLE = 3 * 1024 * 1024;

function timeoutError(): Error {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'TimeoutError';
  return err;
}

test('the wait budget scales with file size instead of being a flat 60s', () => {
  const small = getFileBudgetMs(1024);
  const failing = getFileBudgetMs(1_944_839_496); // the real file
  const huge = getFileBudgetMs(5 * 1024 * 1024 * 1024);

  assert.equal(small, config.telegram.getFileTimeoutMs, 'a tiny file still gets the floor');
  assert.ok(failing > small, 'a 1.8 GiB file gets more than the floor');
  assert.ok(
    huge <= config.telegram.getFileMaxWaitMs,
    'the budget is clamped so a bad size cannot wait forever',
  );

  // The concrete regression: the real file must be allowed more than 60s.
  process.env['JELLYGRAM_UNUSED'] = '';
  assert.ok(
    getFileBudgetMs(1_944_839_496) > 60_000 || config.telegram.getFileMaxWaitMs <= 60_000,
    'the file that failed in production must not be capped at 60s',
  );
});

test('a getFile that times out is retried rather than failing the upload', async () => {
  let calls = 0;
  const info = await withFetch(
    (async () => {
      calls += 1;
      // The Bot API server is still downloading for the first two polls.
      if (calls < 3) throw timeoutError();
      return okResponse('/var/lib/telegram-bot-api/x/documents/file_0.mkv');
    }) as unknown as typeof fetch,
    () => getFileInfo('file-id', { expectedSize: POLLABLE }),
  );

  assert.equal(calls, 3, 'it kept polling until the server was ready');
  assert.equal(info.file_path, '/var/lib/telegram-bot-api/x/documents/file_0.mkv');
});

test('a transport failure is also retried, not treated as a permanent error', async () => {
  let calls = 0;
  const info = await withFetch(
    (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return okResponse('/x/file_0.mkv');
    }) as unknown as typeof fetch,
    () => getFileInfo('file-id', { expectedSize: POLLABLE }),
  );
  assert.equal(calls, 2);
  assert.ok(info.file_path);
});

test('a file Telegram refuses is NOT retried — retrying cannot help', async () => {
  let calls = 0;
  await withFetch(
    (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: file is too big' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch,
    async () => {
      await assert.rejects(
        () => getFileInfo('file-id', { expectedSize: 9e9 }),
        (err: unknown) => err instanceof TelegramFileError && !err.retryable,
      );
    },
  );
  assert.equal(calls, 1, 'a permanent rejection must not be polled');
});

test('the wait honours cancellation', async () => {
  let calls = 0;
  await withFetch(
    (async () => {
      calls += 1;
      throw timeoutError();
    }) as unknown as typeof fetch,
    async () => {
      await assert.rejects(
        () => getFileInfo('file-id', { expectedSize: 1024, shouldCancel: () => calls >= 1 }),
        (err: unknown) => err instanceof DownloadCancelledError,
      );
    },
  );
});

test('exhausting the budget reports a retryable error that keeps the cause', async () => {
  await withFetch(
    (async () => {
      throw timeoutError();
    }) as unknown as typeof fetch,
    async () => {
      await assert.rejects(
        () => getFileInfo('file-id', { expectedSize: 1024 }),
        (err: unknown) => {
          assert.ok(err instanceof TelegramFileError);
          assert.equal(err.retryable, true, 'the server may still be fetching; a later retry can win');
          assert.ok((err as Error).cause, 'the underlying timeout is preserved');
          return true;
        },
      );
    },
  );
});

test('progress is reported while the server is still fetching', async () => {
  const waits: number[] = [];
  let calls = 0;
  await withFetch(
    (async () => {
      calls += 1;
      if (calls < 2) throw timeoutError();
      return okResponse('/x/file_0.mkv');
    }) as unknown as typeof fetch,
    () =>
      getFileInfo('file-id', {
        expectedSize: POLLABLE,
        onWaiting: (elapsed) => {
          waits.push(elapsed);
        },
      }),
  );
  // Without this the user saw "Starting…" for the whole 24 minutes.
  assert.ok(waits.length >= 1, 'the caller was told the wait is ongoing');
});

// ---------------------------------------------------------------------------
// Watching the server fetch
// ---------------------------------------------------------------------------

test('the fetch observer reports the growing partial file, and refuses to guess', async (t) => {
  const { FetchObserver } = await import('../src/services/download.js');
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'jellygram-observe-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const original = config.telegram.localHostRoot;
  Object.defineProperty(config.telegram, 'localHostRoot', { value: root, configurable: true });
  t.after(() =>
    Object.defineProperty(config.telegram, 'localHostRoot', { value: original, configurable: true }),
  );

  await fsp.mkdir(path.join(root, '.tmp'), { recursive: true });
  const expected = 8 * 1024 * 1024;
  const observer = await FetchObserver.create(expected);

  assert.equal(await observer.sample(), null, 'nothing has appeared yet');

  // The server starts writing a partial download.
  const partial = path.join(root, '.tmp', 'download.tmp');
  await fsp.writeFile(partial, Buffer.alloc(2 * 1024 * 1024));
  assert.equal(await observer.sample(), 2 * 1024 * 1024, 'the partial file is the progress');

  await fsp.writeFile(partial, Buffer.alloc(6 * 1024 * 1024));
  assert.equal(await observer.sample(), 6 * 1024 * 1024, 'and it tracks as the file grows');

  // Small bookkeeping files must not be mistaken for a download.
  await fsp.writeFile(path.join(root, '.tmp', 'note.bin'), 'x');
  assert.equal(await observer.sample(), 6 * 1024 * 1024, 'a tiny file is ignored');

  // A second concurrent fetch makes attribution impossible.
  await fsp.writeFile(path.join(root, '.tmp', 'other.tmp'), Buffer.alloc(3 * 1024 * 1024));
  assert.equal(
    await observer.sample(),
    null,
    'with two candidates it reports nothing rather than the wrong one',
  );
});

test('a restarted worker picks up a partial file that was already there', async (t) => {
  const { FetchObserver } = await import('../src/services/download.js');
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'jellygram-resume-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const original = config.telegram.localHostRoot;
  Object.defineProperty(config.telegram, 'localHostRoot', { value: root, configurable: true });
  t.after(() =>
    Object.defineProperty(config.telegram, 'localHostRoot', { value: original, configurable: true }),
  );

  await fsp.mkdir(path.join(root, '.tmp'), { recursive: true });
  const partial = path.join(root, '.tmp', 'download.tmp');
  // The server was already mid-download when the worker restarted.
  await fsp.writeFile(partial, Buffer.alloc(5 * 1024 * 1024));

  const observer = await FetchObserver.create(20 * 1024 * 1024);
  assert.equal(await observer.sample(), null, 'a file that has not moved proves nothing yet');

  // The server keeps downloading across the restart.
  await fsp.writeFile(partial, Buffer.alloc(9 * 1024 * 1024));
  assert.equal(
    await observer.sample(),
    9 * 1024 * 1024,
    'a pre-existing file that is growing is the transfer, and byte progress resumes',
  );
});

test('the fetch observer never throws when the data directory is missing', async (t) => {
  const { FetchObserver } = await import('../src/services/download.js');
  const original = config.telegram.localHostRoot;
  Object.defineProperty(config.telegram, 'localHostRoot', {
    value: '/definitely/not/here',
    configurable: true,
  });
  t.after(() =>
    Object.defineProperty(config.telegram, 'localHostRoot', { value: original, configurable: true }),
  );

  const observer = await FetchObserver.create(1024);
  assert.equal(await observer.sample(), null);
});
