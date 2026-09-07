import './helpers/test-media-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config/index.js';
import {
  MtprotoCancelledError,
  MtprotoError,
  MtprotoStalledError,
  downloadMedia,
} from '../src/services/mtproto.js';

/**
 * What a large MTProto transfer does when it goes wrong.
 *
 * A 2–5 GiB download runs for tens of minutes over a connection nobody
 * controls, so the interesting behaviour is entirely in the failure paths: a
 * connection that goes quiet, a stream that stops short, a cancellation
 * half-way. Every one of those must leave nothing behind — a partial file in
 * the staging tree is invisible until the reaper's grace expires a day later,
 * and on a disk sized for the library rather than for debris, several of them
 * are what fills it.
 *
 * `downloadMedia` takes a client override precisely so this can be driven
 * without Telegram, a network, or a real file of that size.
 */

const stagingDir = config.storage.downloadTmpDir;

/** A fake Telegram client whose iterator behaves however the test needs. */
function clientYielding(chunks: Array<Buffer | 'stall'>): unknown {
  return {
    iterDownload() {
      return (async function* () {
        for (const chunk of chunks) {
          if (chunk === 'stall') {
            // Never resolves: exactly what a dead connection looks like to
            // `for await`, which is why the timeout has to be external.
            await new Promise(() => {});
          }
          yield chunk;
        }
      })();
    },
  };
}

async function destination(name: string): Promise<string> {
  await fsp.mkdir(stagingDir, { recursive: true });
  return path.join(stagingDir, `mtdl-${name}-${process.pid}.bin`);
}

const exists = (p: string) => fs.existsSync(p);

test('a stalled connection fails within the timeout instead of parking forever', async () => {
  const dest = await destination('stall');
  const started = Date.now();

  await assert.rejects(
    () =>
      downloadMedia(
        {},
        { destination: dest, expectedSize: 4096, stallTimeoutMs: 300 },
        clientYielding([Buffer.alloc(64, 1), 'stall']),
      ),
    (err: unknown) => {
      // The worker slot must be released with a retryable failure, not held.
      assert.ok(err instanceof MtprotoError, `got ${(err as Error).name}`);
      assert.equal(err.retryable, true, 'a stall is transient by definition');
      assert.equal(err.kind, 'network');
      assert.match(err.message, /stalled/i);
      return true;
    },
  );

  assert.ok(Date.now() - started < 5000, 'it gave up promptly rather than hanging');
  assert.ok(!exists(dest), 'the partial file was removed');
});

test('the stall timer is per chunk, so a slow but live download is not killed', async () => {
  const dest = await destination('slow');
  const slowClient = {
    iterDownload() {
      return (async function* () {
        for (let i = 0; i < 4; i += 1) {
          // Each gap is under the timeout; the total is over it. A cumulative
          // timer would fail this download, and a 5 GiB transfer is nothing
          // but a long series of gaps like these.
          await new Promise((r) => setTimeout(r, 120));
          yield Buffer.alloc(256, i);
        }
      })();
    },
  };

  const result = await downloadMedia(
    {},
    { destination: dest, expectedSize: 1024, stallTimeoutMs: 300 },
    slowClient,
  );

  assert.equal(result.bytes, 1024);
  assert.ok(exists(dest), 'a healthy download keeps its file');
  await fsp.rm(dest, { force: true });
});

test('a download that stops short is discarded rather than filed', async () => {
  // Half a film is worse than none: it would be identified, filed and served.
  const dest = await destination('short');

  await assert.rejects(
    () =>
      downloadMedia(
        {},
        { destination: dest, expectedSize: 10_000 },
        clientYielding([Buffer.alloc(4096, 7)]),
      ),
    (err: unknown) => {
      assert.ok(err instanceof MtprotoError);
      assert.equal(err.retryable, true, 'a truncated transfer is worth retrying');
      assert.match(err.message, /Truncated|expected/i);
      return true;
    },
  );

  assert.ok(!exists(dest), 'the short file was removed');
});

test('cancelling mid-transfer leaves nothing behind', async () => {
  const dest = await destination('cancel');
  let seen = 0;

  await assert.rejects(
    () =>
      downloadMedia(
        {},
        {
          destination: dest,
          expectedSize: 4096,
          shouldCancel: () => {
            seen += 1;
            return seen > 2;
          },
        },
        clientYielding([Buffer.alloc(512, 1), Buffer.alloc(512, 2), Buffer.alloc(512, 3), Buffer.alloc(512, 4)]),
      ),
    (err: unknown) => {
      // Cancellation is a decision, not a fault: it must not be wrapped into a
      // retryable error, or the worker would immediately start again.
      assert.ok(err instanceof MtprotoCancelledError, `got ${(err as Error).name}`);
      return true;
    },
  );

  assert.ok(!exists(dest), 'a cancelled download leaves no partial file');
});

test('an expected size of zero accepts whatever arrived', async () => {
  // Some forwarded media reports no size; the transfer is still valid.
  const dest = await destination('unknown-size');
  const result = await downloadMedia(
    {},
    { destination: dest, expectedSize: 0 },
    clientYielding([Buffer.alloc(300, 9)]),
  );
  assert.equal(result.bytes, 300);
  await fsp.rm(dest, { force: true });
});

test('a stale file at the destination is replaced, not appended to', async () => {
  // A previous attempt's remains must not be counted as part of this one.
  const dest = await destination('stale');
  await fsp.writeFile(dest, Buffer.alloc(9999, 0xff));

  const result = await downloadMedia(
    {},
    { destination: dest, expectedSize: 128 },
    clientYielding([Buffer.alloc(128, 3)]),
  );

  assert.equal(result.bytes, 128);
  assert.equal((await fsp.stat(dest)).size, 128, 'the old bytes are gone');
  await fsp.rm(dest, { force: true });
});

test('the destination is forced inside the staging directory', async () => {
  // The path comes from a job row; a traversal in it must not escape.
  await assert.rejects(
    () =>
      downloadMedia(
        {},
        { destination: path.join(stagingDir, '..', '..', 'etc', 'escaped.bin'), expectedSize: 1 },
        clientYielding([Buffer.alloc(1)]),
      ),
    /escape|outside|Path/i,
  );
  assert.ok(!exists('/srv/etc/escaped.bin'));
});

test('progress is reported with a total the receiver can use', async () => {
  const dest = await destination('progress');
  const seen: Array<{ bytes: number; total: number }> = [];

  await downloadMedia(
    {},
    {
      destination: dest,
      expectedSize: 2048,
      onProgress: (bytes, total) => {
        seen.push({ bytes, total });
      },
    },
    clientYielding([Buffer.alloc(1024, 1), Buffer.alloc(1024, 2)]),
  );

  assert.ok(seen.length >= 1, 'progress was reported at least once');
  const last = seen.at(-1)!;
  assert.equal(last.bytes, 2048, 'the final report is the complete size');
  assert.equal(last.total, 2048);
  await fsp.rm(dest, { force: true });
});
