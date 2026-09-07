import './helpers/small-disk-reserve.js';
import './helpers/test-database.js';
import './helpers/test-media-root.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { config } from '../src/config/index.js';
import { createLogger } from '../src/lib/logger.js';
import { runMigrations } from '../src/db/migrate.js';
import { closePool, query } from '../src/db/pool.js';
import { mediaRepo, uploadsRepo, usersRepo } from '../src/db/repositories.js';
import { extensionOf, sanitizeFilename, storageSlug } from '../src/lib/paths.js';
import { ensureUserDirectories } from '../src/services/isolation.js';
import { processUpload } from '../src/worker/pipeline.js';
import { probeFile } from '../src/services/identify.js';

/**
 * End-to-end exercise of the real pipeline against the real database and the
 * real filesystem, with the Telegram download step stubbed by pre-placing the
 * file where the downloader would have put it.
 *
 * Run with: npm run test:e2e
 */

const execFileAsync = promisify(execFile);
const log = createLogger('cli');

const TEST_CHAT_ID = -999_111_222;
const FFMPEG_CANDIDATES = ['/usr/lib/jellyfin-ffmpeg/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg'];

let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${(err as Error).message}\n`);
  }
}

/**
 * Build a tiny real video so ffprobe and the organiser see genuine content.
 *
 * Each call varies the source pattern so the files differ byte for byte:
 * reusing one file everywhere would make checksum duplicate detection fire on
 * every case after the first, which is correct behaviour but a useless test.
 */
let videoCounter = 0;

async function makeTestVideo(target: string, seconds = 1): Promise<boolean> {
  videoCounter += 1;
  const pattern = `testsrc=duration=${seconds}:size=${300 + videoCounter * 4}x240:rate=10`;
  for (const bin of FFMPEG_CANDIDATES) {
    try {
      await execFileAsync(
        bin,
        [
          '-v', 'error', '-y',
          '-f', 'lavfi', '-i', pattern,
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
          target,
        ],
        { timeout: 60_000 },
      );
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      process.stdout.write(`  note: ${bin} failed: ${(err as Error).message}\n`);
      return false;
    }
  }
  return false;
}

async function cleanup(): Promise<void> {
  const users = await query<{ id: number; storage_slug: string }>(
    'SELECT id, storage_slug FROM users WHERE telegram_chat_id = $1',
    [TEST_CHAT_ID],
  );
  for (const u of users.rows) {
    for (const root of [config.storage.moviesRoot, config.storage.tvRoot]) {
      await fsp.rm(path.join(root, u.storage_slug), { recursive: true, force: true });
    }
  }
  await query('DELETE FROM users WHERE telegram_chat_id = $1', [TEST_CHAT_ID]);
}

async function main(): Promise<void> {
  await runMigrations();
  await cleanup();

  process.stdout.write('\nEnd-to-end pipeline test\n========================\n\n');

  // --- Fixtures -------------------------------------------------------------
  const slug = storageSlug(`e2e-${Date.now()}`);
  const user = await usersRepo.create({
    name: 'E2E Tester',
    telegram_chat_id: TEST_CHAT_ID,
    jellyfin_username: slug,
    jellyfin_user_id: null,
    storage_slug: slug,
  });
  await ensureUserDirectories(user);
  process.stdout.write(`Created test user "${user.name}" (slug ${slug})\n\n`);

  const workdir = await fsp.mkdtemp(path.join(config.storage.downloadTmpDir, 'e2e-'));
  const sampleMovie = path.join(workdir, 'sample-movie.mp4');
  const hasFfmpeg = await makeTestVideo(sampleMovie);

  if (!hasFfmpeg) {
    process.stdout.write('ffmpeg is unavailable; writing a placeholder file instead.\n');
    await fsp.writeFile(sampleMovie, Buffer.alloc(64 * 1024, 7));
  }

  /** A fresh, byte-distinct sample for one upload. */
  const freshSample = async (name: string): Promise<string> => {
    const target = path.join(workdir, `${name}.mp4`);
    if (!(await makeTestVideo(target))) {
      // Without ffmpeg, vary the filler bytes so checksums still differ.
      await fsp.writeFile(target, Buffer.alloc(64 * 1024, videoCounter % 251));
    }
    return target;
  };

  process.stdout.write('1. ffprobe container inspection\n');
  const probe = await probeFile(sampleMovie);
  check('ffprobe returns a result', () => assert.ok(probe !== null || !hasFfmpeg));
  if (hasFfmpeg && probe) {
    check('the sample is recognised as video', () => assert.equal(probe.isVideo, true));
    check('resolution is read from the container', () => assert.ok((probe.width ?? 0) >= 300));
  }

  // ------------------------------------------------------------------------
  // A movie through the full pipeline
  // ------------------------------------------------------------------------
  process.stdout.write('\n2. Movie upload\n');
  const movieResult = await runPipelineFor(
    user.id,
    'Interstellar.2014.1080p.BluRay.x264-TEST.mkv',
    await freshSample('movie'),
  );

  check('the movie upload completes', () => assert.equal(movieResult.outcome.status, 'COMPLETED'));
  check('a media row is created', () => assert.ok(movieResult.media));
  check('it is identified as a movie', () => assert.equal(movieResult.media?.type, 'movie'));
  check('the title is parsed', () => assert.equal(movieResult.media?.title, 'Interstellar'));
  check('the year is parsed', () => assert.equal(movieResult.media?.year, 2014));
  check('the file lands in the Jellyfin movie layout', () =>
    assert.equal(
      path.relative(config.storage.mediaRoot, movieResult.media!.path),
      path.join('movies', slug, 'Interstellar (2014)', 'Interstellar (2014).mkv'),
    ),
  );
  check('the file exists on disk', () => assert.ok(fs.existsSync(movieResult.media!.path)));
  check('a checksum was recorded', () =>
    assert.equal(movieResult.media?.checksum_sha256?.length, 64),
  );
  check('the temp file was consumed', () => assert.ok(!fs.existsSync(movieResult.tempPath)));

  // ------------------------------------------------------------------------
  // The worker restarted after the file was filed: the re-run must resume,
  // not fetch the file again and then call its own earlier work a duplicate.
  // ------------------------------------------------------------------------
  process.stdout.write('\n2b. Resume after a restart mid-pipeline\n');
  const filedUploadId = movieResult.media!.upload_id!;
  await uploadsRepo.setStatus(filedUploadId, 'QUEUED');
  let fetchedAgain = false;
  const resumed = await processUpload(filedUploadId, async () => {}, {
    download: async () => {
      fetchedAgain = true;
      throw new Error('a filed upload must not be downloaded again');
    },
  });
  check('the resumed run completes', () => assert.equal(resumed.status, 'COMPLETED'));
  check('it did not fetch the file again', () => assert.equal(fetchedAgain, false));
  check('it kept the same media row', () => assert.equal(resumed.mediaId, movieResult.media!.id));
  check('the library directory holds exactly one file', () => {
    const dir = path.dirname(movieResult.media!.path);
    assert.deepEqual(fs.readdirSync(dir), [path.basename(movieResult.media!.path)]);
  });
  check('the upload is marked complete again', async () => {
    assert.equal((await uploadsRepo.byId(filedUploadId))?.status, 'COMPLETED');
  });

  // ------------------------------------------------------------------------
  // The same movie again: duplicate detection
  // ------------------------------------------------------------------------
  process.stdout.write('\n3. Duplicate movie\n');
  // A different release of the same film: different bytes, same title and
   // year, which is exactly the case title-based duplicate detection exists for.
  const dupResult = await runPipelineFor(
    user.id,
    'Interstellar.2014.720p.WEB-DL-OTHER.mkv',
    await freshSample('movie-redux'),
  );
  check('the re-upload is reported as a duplicate', () =>
    assert.equal(dupResult.outcome.status, 'DUPLICATE'),
  );
  check('no second media row is created', async () => {
    assert.equal(dupResult.media, null);
  });
  check('the original file is untouched', () => assert.ok(fs.existsSync(movieResult.media!.path)));
  check('the duplicate leaves nothing in the temp directory', () =>
    assert.ok(!fs.existsSync(dupResult.tempPath)),
  );

  // ------------------------------------------------------------------------
  // A TV episode
  // ------------------------------------------------------------------------
  process.stdout.write('\n4. TV episode upload\n');
  const tvResult = await runPipelineFor(
    user.id,
    'Breaking.Bad.S02E03.1080p.TEST.mkv',
    await freshSample('episode'),
  );

  check('the episode upload completes', () => assert.equal(tvResult.outcome.status, 'COMPLETED'));
  check('it is identified as TV', () => assert.equal(tvResult.media?.type, 'tv'));
  check('the show name is parsed', () => assert.equal(tvResult.media?.title, 'Breaking Bad'));
  check('the season is parsed', () => assert.equal(tvResult.media?.season, 2));
  check('the episode is parsed', () => assert.equal(tvResult.media?.episode, 3));
  check('the file lands in the Jellyfin TV layout', () =>
    assert.equal(
      path.relative(config.storage.mediaRoot, tvResult.media!.path),
      path.join('tv', slug, 'Breaking Bad', 'Season 02', 'Breaking Bad - S02E03.mkv'),
    ),
  );

  // ------------------------------------------------------------------------
  // Path traversal through a hostile filename
  // ------------------------------------------------------------------------
  process.stdout.write('\n5. Hostile filename\n');
  const evilResult = await runPipelineFor(
    user.id,
    '../../../../etc/cron.d/evil.2020.mkv',
    await freshSample('hostile'),
  );
  check('the hostile upload still terminates cleanly', () =>
    assert.ok(['COMPLETED', 'DUPLICATE'].includes(evilResult.outcome.status)),
  );
  if (evilResult.media) {
    check('nothing escapes the media root', () =>
      assert.ok(evilResult.media!.path.startsWith(config.storage.mediaRoot + path.sep)),
    );
    check("nothing escapes the user's own directory", () =>
      assert.ok(evilResult.media!.path.includes(`${path.sep}${slug}${path.sep}`)),
    );
    check('no file was written to /etc', () => assert.ok(!fs.existsSync('/etc/cron.d/evil.2020.mkv')));
  }

  // ------------------------------------------------------------------------
  // Per-user isolation on disk
  // ------------------------------------------------------------------------
  process.stdout.write('\n6. On-disk isolation\n');
  const otherSlug = storageSlug(`e2e-other-${Date.now()}`);
  const other = await usersRepo.create({
    name: 'E2E Other',
    telegram_chat_id: TEST_CHAT_ID - 1,
    jellyfin_username: otherSlug,
    jellyfin_user_id: null,
    storage_slug: otherSlug,
  });
  await ensureUserDirectories(other);
  const otherResult = await runPipelineFor(
    other.id,
    'Interstellar.2014.1080p.mkv',
    await freshSample('other-user'),
  );

  check("the other user's identical film is not a duplicate", () =>
    assert.equal(otherResult.outcome.status, 'COMPLETED'),
  );
  check('the two users store the film in different directories', () =>
    assert.notEqual(otherResult.media!.path, movieResult.media!.path),
  );
  check("neither path is inside the other user's directory", () => {
    assert.ok(!otherResult.media!.path.includes(`${path.sep}${slug}${path.sep}`));
    assert.ok(!movieResult.media!.path.includes(`${path.sep}${otherSlug}${path.sep}`));
  });

  process.stdout.write('\n7. Filesystem permissions\n');
  const movieStat = await fsp.stat(movieResult.media!.path);
  const dirStat = await fsp.stat(path.dirname(movieResult.media!.path));
  check('media files are not world-readable', () => assert.equal(movieStat.mode & 0o007, 0));
  check('media directories are not world-readable', () => assert.equal(dirStat.mode & 0o007, 0));

  // --- Teardown -------------------------------------------------------------
  await query('DELETE FROM users WHERE telegram_chat_id IN ($1, $2)', [TEST_CHAT_ID, TEST_CHAT_ID - 1]);
  for (const s of [slug, otherSlug]) {
    for (const root of [config.storage.moviesRoot, config.storage.tvRoot]) {
      await fsp.rm(path.join(root, s), { recursive: true, force: true });
    }
  }
  await fsp.rm(workdir, { recursive: true, force: true });

  process.stdout.write(
    `\n========================\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

/**
 * Drive one upload through the pipeline.
 *
 * The Telegram fetch is bypassed by copying the sample into the temp directory
 * under the exact name the downloader would have used, and pointing the
 * pipeline at a local Bot API root.
 */
async function runPipelineFor(
  userId: number,
  filename: string,
  sampleFile: string,
): Promise<{
  outcome: Awaited<ReturnType<typeof processUpload>>;
  media: Awaited<ReturnType<typeof mediaRepo.byPath>>;
  tempPath: string;
}> {
  const safe = sanitizeFilename(filename, 'upload');
  const size = (await fsp.stat(sampleFile)).size;

  const upload = await uploadsRepo.create({
    user_id: userId,
    telegram_chat_id: TEST_CHAT_ID,
    telegram_message_id: null,
    telegram_file_id: `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    telegram_file_unique_id: null,
    original_filename: filename,
    safe_filename: safe,
    extension: extensionOf(filename),
    mime_type: 'video/x-matroska',
    file_size: size,
  });

  let tempPath = '';

  // Only the network fetch is replaced. Probing, identification, hashing,
  // duplicate detection, the move and every database write below run the
  // production code path unchanged.
  const outcome = await processUpload(upload.id, async () => {}, {
    download: async (opts) => {
      tempPath = opts.destination;
      await fsp.copyFile(sampleFile, opts.destination);
      const { size: written } = await fsp.stat(opts.destination);
      await opts.onProgress?.(written, written);
      return { path: opts.destination, bytes: written };
    },
  });

  const finished = await uploadsRepo.byId(upload.id);
  const media = finished?.stored_path ? await mediaRepo.byPath(finished.stored_path) : null;

  return { outcome, media, tempPath };
}

main()
  .catch((err) => {
    log.error({ err }, 'End-to-end test failed');
    process.stdout.write(`\nFATAL: ${(err as Error).message}\n${(err as Error).stack}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
