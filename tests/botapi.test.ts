import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config/index.js';
import {
  LOCAL_BOT_API_FILE_LIMIT,
  PUBLIC_BOT_API_FILE_LIMIT,
  botApiFileLimit,
  effectiveMaxFileSize,
  toHostPath,
  takeLocalFile,
  TelegramFileError,
} from '../src/services/download.js';

/**
 * Local Bot API server behaviour: the size ceilings and the container-to-host
 * path translation that makes local mode work at all.
 */

// ---------------------------------------------------------------------------
// Size limits
// ---------------------------------------------------------------------------

test('the public Bot API ceiling is 20 MB', () => {
  assert.equal(PUBLIC_BOT_API_FILE_LIMIT, 20 * 1024 * 1024);
});

test('the local Bot API ceiling is 2000 MB, not 5 GB', () => {
  assert.equal(LOCAL_BOT_API_FILE_LIMIT, 2000 * 1024 * 1024);
  assert.equal(LOCAL_BOT_API_FILE_LIMIT, 2_097_152_000);
  assert.ok(LOCAL_BOT_API_FILE_LIMIT < 5 * 1024 * 1024 * 1024);
});

test('the transport ceiling follows the configured mode', () => {
  assert.equal(
    botApiFileLimit(),
    config.telegram.localMode ? LOCAL_BOT_API_FILE_LIMIT : PUBLIC_BOT_API_FILE_LIMIT,
  );
});

test('the enforced ceiling never exceeds what the transport can fetch', () => {
  assert.ok(
    effectiveMaxFileSize() <= botApiFileLimit(),
    'accepting a file the transport cannot fetch would fail late, after the upload',
  );
});

test('the enforced ceiling never exceeds the configured ceiling', () => {
  assert.ok(effectiveMaxFileSize() <= config.storage.maxFileSizeBytes);
});

test('MAX_FILE_SIZE_BYTES is configured for 2000 MB', () => {
  assert.equal(
    config.storage.maxFileSizeBytes,
    LOCAL_BOT_API_FILE_LIMIT,
    'the configured ceiling should match the local Bot API server ceiling',
  );
});

test('a 100 MB file is above the public ceiling and below the local one', () => {
  const size = 100 * 1024 * 1024;
  assert.ok(size > PUBLIC_BOT_API_FILE_LIMIT);
  assert.ok(size < LOCAL_BOT_API_FILE_LIMIT);
});

test('a 1.5 GB file fits under the local ceiling', () => {
  assert.ok(1.5 * 1024 * 1024 * 1024 < LOCAL_BOT_API_FILE_LIMIT);
});

test('a 2.5 GB file is refused even in local mode', () => {
  assert.ok(2.5 * 1024 * 1024 * 1024 > LOCAL_BOT_API_FILE_LIMIT);
});

// ---------------------------------------------------------------------------
// Container-to-host path translation
// ---------------------------------------------------------------------------

test('a container path is rewritten to the host bind-mount path', () => {
  const fileRoot = path.resolve(config.telegram.localFileRoot);
  const hostRoot = path.resolve(config.telegram.localHostRoot);

  const containerPath = path.join(fileRoot, '12345:TOKEN', 'videos', 'file_0.mp4');
  const expected = path.join(hostRoot, '12345:TOKEN', 'videos', 'file_0.mp4');

  assert.equal(toHostPath(containerPath), expected);
});

test('translation is a no-op when both roots are the same', () => {
  const same = path.resolve(config.telegram.localFileRoot);
  if (same !== path.resolve(config.telegram.localHostRoot)) return; // not this deployment
  assert.equal(toHostPath(path.join(same, 'a', 'b.mp4')), path.join(same, 'a', 'b.mp4'));
});

test('a path outside the mapped root is returned untouched', () => {
  // Guessing at an unmapped path would be worse than letting the caller's
  // existence check report a clear error.
  assert.equal(toHostPath('/somewhere/else/file.mp4'), '/somewhere/else/file.mp4');
});

test('translation cannot be tricked into escaping the host root', () => {
  const fileRoot = path.resolve(config.telegram.localFileRoot);
  const hostRoot = path.resolve(config.telegram.localHostRoot);

  for (const attempt of ['../../etc/passwd', 'a/../../../../etc/shadow', './../../root/.ssh/id_rsa']) {
    const translated = toHostPath(path.join(fileRoot, attempt));
    // `path.join` normalises the traversal away before translation, so a
    // hostile file_path can only ever land inside one of the two roots.
    assert.ok(
      translated.startsWith(hostRoot + path.sep) ||
        translated === hostRoot ||
        !translated.startsWith(fileRoot),
      `${attempt} produced ${translated}`,
    );
  }
});

test('the two mount roots are configured and absolute', () => {
  assert.ok(path.isAbsolute(config.telegram.localFileRoot));
  assert.ok(path.isAbsolute(config.telegram.localHostRoot));
});

// ---------------------------------------------------------------------------
// Consistency between mode and endpoint
// ---------------------------------------------------------------------------

test('local mode and the API endpoint agree', () => {
  const pointsAtCloud = /api\.telegram\.org/i.test(config.telegram.apiRoot);
  assert.equal(
    config.telegram.localMode,
    !pointsAtCloud,
    'TELEGRAM_LOCAL_MODE must be true exactly when TELEGRAM_API_ROOT is a local server',
  );
});

// ---------------------------------------------------------------------------
// Taking a file the local Bot API server has written
// ---------------------------------------------------------------------------

async function withTempDirs<T>(fn: (dirs: { src: string; dst: string }) => Promise<T>): Promise<T> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'jellygram-botapi-'));
  const src = path.join(base, 'server');
  const dst = path.join(base, 'incoming');
  await fsp.mkdir(src, { recursive: true });
  await fsp.mkdir(dst, { recursive: true });
  try {
    return await fn({ src, dst });
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
}

test('a local file is moved to the destination and removed from the server directory', async () => {
  await withTempDirs(async ({ src, dst }) => {
    const source = path.join(src, 'file_0.mp4');
    const destination = path.join(dst, 'taken.mp4');
    const payload = Buffer.alloc(3 * 1024 * 1024, 9);
    await fsp.writeFile(source, payload);

    const result = await takeLocalFile(source, destination);

    assert.equal(result.path, destination);
    assert.equal(result.bytes, payload.length);
    assert.ok(fs.existsSync(destination), 'destination should exist');
    assert.ok(!fs.existsSync(source), "the server's copy should be gone");
    assert.equal((await fsp.stat(destination)).size, payload.length);
  });
});

test('the moved file keeps its exact contents', async () => {
  await withTempDirs(async ({ src, dst }) => {
    const source = path.join(src, 'file_1.mp4');
    const destination = path.join(dst, 'taken.mp4');
    const payload = Buffer.from('the quick brown fox'.repeat(5000));
    await fsp.writeFile(source, payload);

    await takeLocalFile(source, destination);
    assert.deepEqual(await fsp.readFile(destination), payload);
  });
});

test('progress is reported once, at completion', async () => {
  await withTempDirs(async ({ src, dst }) => {
    const source = path.join(src, 'file_2.mp4');
    await fsp.writeFile(source, Buffer.alloc(1024, 1));

    const reports: Array<[number, number]> = [];
    await takeLocalFile(source, path.join(dst, 'taken.mp4'), {
      onProgress: (bytes, total) => {
        reports.push([bytes, total]);
      },
    });

    assert.equal(reports.length, 1, 'a move is instant, so one final report is correct');
    assert.deepEqual(reports[0], [1024, 1024]);
  });
});

test('a missing source file produces a clear, non-retryable error', async () => {
  await withTempDirs(async ({ dst }) => {
    // A path the Bot API server would have reported — under its data root —
    // that this host cannot see points at the bind mount.
    const underBotApi = path.join(path.resolve(config.telegram.localHostRoot), 'nope', 'documents', 'absent.mp4');
    await assert.rejects(
      () => takeLocalFile(underBotApi, path.join(dst, 'x.mp4')),
      (err: unknown) => {
        assert.ok(err instanceof TelegramFileError);
        assert.equal(err.retryable, false, 'a mount misconfiguration will not fix itself on retry');
        assert.match(err.message, /TELEGRAM_LOCAL_HOST_ROOT/);
        return true;
      },
    );
  });
});

test('a missing staged file is described as that, not as a Bot API mount problem', async () => {
  // Assembled parts, MTProto fetches and direct uploads come through the same
  // door from the staging directory; blaming the container mount for one of
  // those sent the operator to check a setting that had nothing to do with it.
  await withTempDirs(async ({ src, dst }) => {
    await assert.rejects(
      () => takeLocalFile(path.join(src, 'absent.mp4'), path.join(dst, 'x.mp4')),
      (err: unknown) => {
        assert.ok(err instanceof TelegramFileError);
        assert.equal(err.retryable, false);
        assert.doesNotMatch(err.message, /TELEGRAM_LOCAL_HOST_ROOT/);
        assert.match(err.message, /no longer on the server/);
        return true;
      },
    );
  });
});

test('the move never reads the file into memory', async () => {
  // A 24 MB payload moved with a heap ceiling far below it: a rename touches
  // no bytes, so this passes regardless of file size.
  await withTempDirs(async ({ src, dst }) => {
    const source = path.join(src, 'big.mp4');
    const destination = path.join(dst, 'big.mp4');
    await fsp.writeFile(source, Buffer.alloc(24 * 1024 * 1024, 3));

    const before = process.memoryUsage().heapUsed;
    const result = await takeLocalFile(source, destination);
    const growth = process.memoryUsage().heapUsed - before;

    assert.equal(result.bytes, 24 * 1024 * 1024);
    assert.ok(
      growth < 8 * 1024 * 1024,
      `heap grew by ${Math.round(growth / 1024 / 1024)} MB; the file should never be buffered`,
    );
  });
});
