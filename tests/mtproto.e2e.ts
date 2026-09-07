import './helpers/small-disk-reserve.js';
import './helpers/test-database.js';
import './helpers/test-media-root.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { config } from '../src/config/index.js';
import { createLogger } from '../src/lib/logger.js';
import { runMigrations } from '../src/db/migrate.js';
import { closePool, query } from '../src/db/pool.js';
import { mediaRepo, mtprotoJobsRepo, uploadsRepo, usersRepo } from '../src/db/repositories.js';
import { storageSlug } from '../src/lib/paths.js';
import { ensureUserDirectories } from '../src/services/isolation.js';
import { MtprotoError, MtprotoCancelledError } from '../src/services/mtproto.js';
import { handleMtprotoDownload, type MtprotoTransport } from '../src/worker/mtproto.js';
import { processUpload } from '../src/worker/pipeline.js';

/**
 * End-to-end MTProto ingestion against the real database and filesystem.
 *
 * Only the two calls that reach Telegram are stubbed — locating the message and
 * streaming its bytes. Everything else is production code: the size and disk
 * checks, the status machine, verification, the handoff, and then the existing
 * pipeline all the way to the Jellyfin layout.
 *
 * Run with: npm run test:mtproto
 */

const execFileAsync = promisify(execFile);
const log = createLogger('cli');

const GiB = 1024 * 1024 * 1024;
const TEST_CHAT_ID = -999_888_111;
const FFMPEG = ['/usr/lib/jellyfin-ffmpeg/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg'];

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

let videoCounter = 0;

async function makeVideo(target: string): Promise<boolean> {
  videoCounter += 1;
  for (const bin of FFMPEG) {
    try {
      await execFileAsync(
        bin,
        [
          '-v', 'error', '-y',
          '-f', 'lavfi', '-i', `testsrc=duration=2:size=${320 + videoCounter * 4}x240:rate=15`,
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
          target,
        ],
        { timeout: 90_000 },
      );
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return false;
    }
  }
  return false;
}

async function cleanup(): Promise<void> {
  const users = await query<{ id: number; storage_slug: string }>(
    'SELECT id, storage_slug FROM users WHERE telegram_chat_id <= $1 AND telegram_chat_id >= $2',
    [TEST_CHAT_ID, TEST_CHAT_ID - 20],
  );
  for (const u of users.rows) {
    for (const root of [config.storage.moviesRoot, config.storage.tvRoot]) {
      await fsp.rm(path.join(root, u.storage_slug), { recursive: true, force: true });
    }
  }
  await query('DELETE FROM users WHERE telegram_chat_id <= $1 AND telegram_chat_id >= $2', [
    TEST_CHAT_ID,
    TEST_CHAT_ID - 20,
  ]);
}

let userSeq = 0;

async function makeUser(suffix: string) {
  const slug = storageSlug(`mte2e-${suffix}-${Date.now()}-${userSeq}`);
  const user = await usersRepo.create({
    name: `MT E2E ${suffix} ${userSeq}`,
    telegram_chat_id: TEST_CHAT_ID - userSeq,
    jellyfin_username: slug,
    jellyfin_user_id: null,
    storage_slug: slug,
  });
  userSeq += 1;
  await ensureUserDirectories(user);
  return user;
}

/**
 * A transport that serves a real file from disk instead of Telegram.
 *
 * `download` writes to the destination the handler chose, so the containment
 * and naming logic under test is the production logic.
 */
function stubTransport(sourceFile: string, opts: { fileName?: string | null } = {}): MtprotoTransport {
  return {
    locate: async (hints) => ({
      media: { __stub: sourceFile },
      size: (await fsp.stat(sourceFile)).size,
      fileName: opts.fileName === undefined ? hints.fileName : opts.fileName,
      via: 'origin' as const,
    }),
    download: async (media, options) => {
      const src = (media as { __stub: string }).__stub;
      const data = await fsp.readFile(src);

      // Report progress in chunks, as the real streamed download does.
      const chunk = Math.max(1, Math.floor(data.length / 4));
      for (let sent = 0; sent < data.length; sent += chunk) {
        if (await options.shouldCancel?.()) throw new MtprotoCancelledError();
        await options.onProgress?.(Math.min(data.length, sent + chunk), data.length, 1_000_000);
      }

      await fsp.writeFile(options.destination, data);
      return {
        path: options.destination,
        bytes: data.length,
        sha256: crypto.createHash('sha256').update(data).digest('hex'),
      };
    },
  };
}

function jobFor(userId: number, overrides: Record<string, unknown> = {}) {
  return {
    user_id: userId,
    telegram_chat_id: TEST_CHAT_ID,
    bot_message_id: Math.floor(Math.random() * 100_000_000),
    progress_message_id: null,
    origin_kind: 'channel' as const,
    origin_chat: '@movies',
    origin_message_id: 777,
    origin_title: 'Movies Channel',
    file_name: 'Interstellar.2014.2160p.BluRay.mkv',
    file_size: 3 * GiB,
    mime_type: 'video/x-matroska',
    telegram_file_unique_id: `uniq-${Math.random().toString(36).slice(2)}`,
    caption: null,
    ...overrides,
  };
}

async function main(): Promise<void> {
  await runMigrations();
  await cleanup();

  process.stdout.write('\nMTProto ingestion end-to-end\n============================\n\n');

  const workdir = await fsp.mkdtemp(path.join(config.storage.downloadTmpDir, 'mte2e-'));
  // Registered for removal before anything can throw. The teardown at the end
  // only runs when every check passed, so an aborted run used to leave its
  // scratch directory in the staging tree — where the reaper deliberately does
  // not recurse, so nothing ever collected it.
  process.on('exit', () => {
    try {
      fs.rmSync(workdir, { recursive: true, force: true });
    } catch {
      /* best effort on the way out */
    }
  });
  const source = path.join(workdir, 'source.mp4');
  const haveFfmpeg = await makeVideo(source);
  if (!haveFfmpeg) {
    process.stdout.write('ffmpeg unavailable; using synthetic bytes.\n');
    await fsp.writeFile(source, crypto.randomBytes(512 * 1024));
  }
  const sourceBytes = await fsp.readFile(source);
  const sourceSha = crypto.createHash('sha256').update(sourceBytes).digest('hex');

  // =========================================================================
  process.stdout.write('1. Forwarded media over 2 GiB reaches the pipeline\n');
  const user = await makeUser('main');
  const job = await mtprotoJobsRepo.create(
    jobFor(user.id, { file_size: sourceBytes.length }),
  );

  await handleMtprotoDownload(job.id, stubTransport(source));
  const done = await mtprotoJobsRepo.byId(job.id);

  check('the job completed', () => assert.equal(done?.status, 'COMPLETED'));
  check('a SHA-256 was recorded during the download', () =>
    assert.equal(done?.sha256, sourceSha),
  );
  check('the byte count matches the source', () =>
    assert.equal(done?.bytes_downloaded, sourceBytes.length),
  );
  check('an upload row was created for the pipeline', () => assert.ok(done?.upload_id));
  check('completed_at was stamped', () => assert.ok(done?.completed_at));

  const upload = await uploadsRepo.byId(done!.upload_id!);
  check('the upload is marked as the mtproto route', () => assert.equal(upload?.source, 'mtproto'));
  check('the upload links back to the job', () =>
    assert.equal(upload?.mtproto_job_id, job.id),
  );
  check('the upload carries no Bot API file id', () =>
    assert.equal(upload?.telegram_file_id, null),
  );
  check('the upload points at the downloaded file', () =>
    assert.ok(upload?.local_source_path && fs.existsSync(upload.local_source_path)),
  );

  // =========================================================================
  process.stdout.write('\n2. The existing pipeline takes it from there\n');
  // The MTProto handoff queues the pipeline run; this test performs it
  // directly. The live worker shares this database and would otherwise claim
  // the same job and run it against the real media root rather than the
  // scratch one, filing test fixtures among real films.
  await query(`DELETE FROM jobs WHERE type = 'process-upload' AND upload_id = $1`, [done!.upload_id!]);

  const outcome = await processUpload(done!.upload_id!, async () => {});
  check('the pipeline completed', () => assert.equal(outcome.status, 'COMPLETED'));

  const finished = await uploadsRepo.byId(done!.upload_id!);
  const media = finished?.stored_path ? await mediaRepo.byPath(finished.stored_path) : null;

  check('a media row was created', () => assert.ok(media));
  check('TMDB/filename identification ran', () => assert.equal(media?.title, 'Interstellar'));
  check('the year was identified', () => assert.equal(media?.year, 2014));
  check('it landed in the Jellyfin movie layout', () =>
    assert.equal(
      path.relative(config.storage.mediaRoot, media!.path),
      path.join('movies', user.storage_slug, 'Interstellar (2014)', 'Interstellar (2014).mkv'),
    ),
  );
  check('the final bytes are the original bytes', () => {
    const got = crypto.createHash('sha256').update(fs.readFileSync(media!.path)).digest('hex');
    assert.equal(got, sourceSha);
  });
  check('the temporary download was consumed', () =>
    assert.ok(!fs.existsSync(upload!.local_source_path!)),
  );

  // =========================================================================
  process.stdout.write('\n3. Ownership and privacy\n');
  check('the media belongs to the forwarding user', () =>
    assert.equal(media?.user_id, user.id),
  );
  check("it lives under that user's own directory", () =>
    assert.ok(media!.path.includes(`${path.sep}${user.storage_slug}${path.sep}`)),
  );

  const other = await makeUser('other');
  check('another user has a separate directory', () =>
    assert.ok(!media!.path.includes(`${path.sep}${other.storage_slug}${path.sep}`)),
  );

  // =========================================================================
  process.stdout.write('\n4. A file above 5 GiB is refused\n');
  const tooBigUser = await makeUser('toobig');
  const tooBig = await mtprotoJobsRepo.create(
    jobFor(tooBigUser.id, { file_size: 5 * GiB + 1, file_name: 'Huge.2020.mkv' }),
  );

  let refusedMessage = '';
  try {
    await handleMtprotoDownload(tooBig.id, stubTransport(source));
  } catch (err) {
    refusedMessage = (err as Error).message;
  }
  const tooBigAfter = await mtprotoJobsRepo.byId(tooBig.id);

  check('the oversized job failed', () => assert.equal(tooBigAfter?.status, 'FAILED'));
  check('the reason names the ceiling', () =>
    assert.match(refusedMessage, /above the MTProto ceiling/i),
  );
  check('nothing was downloaded', () => assert.equal(tooBigAfter?.bytes_downloaded, 0));

  // Exactly 5 GiB must not be refused by the same check.
  const atLimit = await mtprotoJobsRepo.create(
    jobFor((await makeUser('atlimit')).id, { file_size: 5 * GiB, file_name: 'Exactly.2020.mkv' }),
  );
  let atLimitError = '';
  try {
    // The stub reports the real (small) size, so this proves the *declared*
    // 5 GiB passes the ceiling check before the transport is consulted.
    await handleMtprotoDownload(atLimit.id, stubTransport(source));
  } catch (err) {
    atLimitError = (err as Error).message;
  }
  check('exactly 5 GiB is not refused by the ceiling', () =>
    assert.ok(!/above the MTProto ceiling/i.test(atLimitError), atLimitError),
  );

  // =========================================================================
  process.stdout.write('\n5. The original message is no longer reachable\n');
  const goneUser = await makeUser('gone');
  const gone = await mtprotoJobsRepo.create(
    jobFor(goneUser.id, { file_size: sourceBytes.length, file_name: 'Deleted.2019.mkv' }),
  );

  const notFound: MtprotoTransport = {
    locate: async () => {
      throw new MtprotoError(
        'No matching message',
        'I could not find that media in your Telegram account.',
        false,
        'not-found',
      );
    },
    download: async () => {
      throw new Error('should not be reached');
    },
  };

  try {
    await handleMtprotoDownload(gone.id, notFound);
  } catch {
    /* expected */
  }
  const goneAfter = await mtprotoJobsRepo.byId(gone.id);

  check('the job is marked unavailable, not failed', () =>
    assert.equal(goneAfter?.status, 'UNAVAILABLE'),
  );
  check('the reason is recorded', () => assert.match(goneAfter?.error_message ?? '', /matching/i));
  check('no upload row was created', () => assert.equal(goneAfter?.upload_id, null));

  // =========================================================================
  process.stdout.write('\n6. A transient failure retries, then gives up\n');
  const flakyUser = await makeUser('flaky');
  const flaky = await mtprotoJobsRepo.create(
    jobFor(flakyUser.id, { file_size: sourceBytes.length, file_name: 'Flaky.2018.mkv' }),
  );

  let attemptsSeen = 0;
  const flakyTransport: MtprotoTransport = {
    locate: stubTransport(source).locate,
    download: async () => {
      attemptsSeen += 1;
      throw new MtprotoError('connection reset', 'The download was interrupted.', true, 'network');
    },
  };

  for (let i = 0; i < config.mtproto.maxAttempts; i += 1) {
    try {
      await handleMtprotoDownload(flaky.id, flakyTransport);
    } catch {
      /* expected */
    }
  }

  const flakyAfter = await mtprotoJobsRepo.byId(flaky.id);
  check('every attempt was made', () => assert.equal(attemptsSeen, config.mtproto.maxAttempts));
  check('the attempt count is recorded', () =>
    assert.equal(flakyAfter?.attempts, config.mtproto.maxAttempts),
  );
  check('it ends as failed once attempts are exhausted', () =>
    assert.equal(flakyAfter?.status, 'FAILED'),
  );
  check('no partial file is left behind', () =>
    assert.ok(!flakyAfter?.temp_path || !fs.existsSync(flakyAfter.temp_path)),
  );

  // A retry from the dashboard puts it back on the queue.
  const { retryMtprotoJob } = await import('../src/worker/mtproto.js');
  const requeued = await retryMtprotoJob(flaky.id);
  const retried = await mtprotoJobsRepo.byId(flaky.id);
  check('an admin retry requeues the job', () => assert.equal(requeued, true));
  check('the retried job is pending again', () => assert.equal(retried?.status, 'PENDING'));
  check('the progress counter was reset', () => assert.equal(retried?.bytes_downloaded, 0));

  // Now let it succeed, proving recovery works.
  await handleMtprotoDownload(flaky.id, stubTransport(source));
  const recovered = await mtprotoJobsRepo.byId(flaky.id);
  check('a later attempt succeeds', () => assert.equal(recovered?.status, 'COMPLETED'));

  // =========================================================================
  process.stdout.write('\n7. A truncated download is rejected\n');
  const truncUser = await makeUser('trunc');
  const trunc = await mtprotoJobsRepo.create(
    jobFor(truncUser.id, { file_size: sourceBytes.length, file_name: 'Short.2017.mkv' }),
  );

  const truncating: MtprotoTransport = {
    locate: stubTransport(source).locate,
    download: async () => {
      throw new MtprotoError(
        'Truncated download: expected more bytes',
        'The download finished short of the expected size, so it was discarded.',
        true,
        'network',
      );
    },
  };

  for (let i = 0; i < config.mtproto.maxAttempts; i += 1) {
    try {
      await handleMtprotoDownload(trunc.id, truncating);
    } catch {
      /* expected */
    }
  }
  const truncAfter = await mtprotoJobsRepo.byId(trunc.id);
  check('a truncated download never reaches the pipeline', () =>
    assert.equal(truncAfter?.upload_id, null),
  );
  check('it is recorded as failed', () => assert.equal(truncAfter?.status, 'FAILED'));

  // =========================================================================
  process.stdout.write('\n8. Cancellation\n');
  const cancelUser = await makeUser('cancel');
  const cancelJob = await mtprotoJobsRepo.create(
    jobFor(cancelUser.id, { file_size: sourceBytes.length, file_name: 'Cancelled.2016.mkv' }),
  );
  await mtprotoJobsRepo.requestCancel(cancelJob.id);

  await handleMtprotoDownload(cancelJob.id, stubTransport(source));
  const cancelled = await mtprotoJobsRepo.byId(cancelJob.id);

  check('a cancelled job does not download', () =>
    assert.equal(cancelled?.bytes_downloaded, 0),
  );
  check('no upload row is created for a cancelled job', () =>
    assert.equal(cancelled?.upload_id, null),
  );

  // =========================================================================
  process.stdout.write('\n9. Concurrent downloads stay separate\n');
  const userA = await makeUser('conc-a');
  const userB = await makeUser('conc-b');

  const fileA = path.join(workdir, 'a.mp4');
  const fileB = path.join(workdir, 'b.mp4');
  if (!(await makeVideo(fileA))) await fsp.writeFile(fileA, crypto.randomBytes(300 * 1024));
  if (!(await makeVideo(fileB))) await fsp.writeFile(fileB, crypto.randomBytes(301 * 1024));

  const jobA = await mtprotoJobsRepo.create(
    jobFor(userA.id, {
      file_size: (await fsp.stat(fileA)).size,
      file_name: 'Arrival.2016.1080p.mkv',
      telegram_chat_id: userA.telegram_chat_id,
    }),
  );
  const jobB = await mtprotoJobsRepo.create(
    jobFor(userB.id, {
      file_size: (await fsp.stat(fileB)).size,
      file_name: 'Dune.2021.1080p.mkv',
      telegram_chat_id: userB.telegram_chat_id,
    }),
  );

  await Promise.all([
    handleMtprotoDownload(jobA.id, stubTransport(fileA)),
    handleMtprotoDownload(jobB.id, stubTransport(fileB)),
  ]);

  const [doneA, doneB] = await Promise.all([
    mtprotoJobsRepo.byId(jobA.id),
    mtprotoJobsRepo.byId(jobB.id),
  ]);

  check('both concurrent jobs completed', () => {
    assert.equal(doneA?.status, 'COMPLETED');
    assert.equal(doneB?.status, 'COMPLETED');
  });
  check('they wrote to different temporary files', () =>
    assert.notEqual(doneA?.temp_path, doneB?.temp_path),
  );
  check('each has its own checksum', () => assert.notEqual(doneA?.sha256, doneB?.sha256));
  check('ownership is not crossed', () => {
    assert.equal(doneA?.user_id, userA.id);
    assert.equal(doneB?.user_id, userB.id);
  });

  const uploadA = await uploadsRepo.byId(doneA!.upload_id!);
  const uploadB = await uploadsRepo.byId(doneB!.upload_id!);
  check('each upload belongs to its own user', () => {
    assert.equal(uploadA?.user_id, userA.id);
    assert.equal(uploadB?.user_id, userB.id);
  });

  // =========================================================================
  process.stdout.write('\n10. Hostile filename from Telegram\n');
  const evilUser = await makeUser('evil');
  const evil = await mtprotoJobsRepo.create(
    jobFor(evilUser.id, {
      file_size: sourceBytes.length,
      file_name: '../../../../etc/cron.d/evil.2020.mkv',
    }),
  );

  await handleMtprotoDownload(evil.id, stubTransport(source, { fileName: null }));
  const evilAfter = await mtprotoJobsRepo.byId(evil.id);

  check('the hostile job still terminated cleanly', () =>
    assert.ok(['COMPLETED', 'FAILED'].includes(evilAfter?.status ?? '')),
  );
  if (evilAfter?.temp_path) {
    check('the download stayed inside the temp directory', () =>
      assert.ok(
        path.resolve(evilAfter.temp_path!).startsWith(config.storage.downloadTmpDir + path.sep),
      ),
    );
  }
  check('nothing was written to /etc', () =>
    assert.ok(!fs.existsSync('/etc/cron.d/evil.2020.mkv')),
  );

  if (evilAfter?.upload_id) {
    const evilUpload = await uploadsRepo.byId(evilAfter.upload_id);
    const evilFinished = evilUpload?.stored_path ? await mediaRepo.byPath(evilUpload.stored_path) : null;
    if (evilFinished) {
      check('the filed media stayed inside the media root', () =>
        assert.ok(evilFinished.path.startsWith(config.storage.mediaRoot + path.sep)),
      );
    }
  }

  // --- Teardown -------------------------------------------------------------
  await cleanup();

  process.stdout.write(
    `\n============================\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    log.error({ err }, 'MTProto end-to-end test failed');
    process.stdout.write(`\nFATAL: ${(err as Error).message}\n${(err as Error).stack}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
