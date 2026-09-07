import './helpers/small-disk-reserve.js';
import './helpers/test-database.js';
import './helpers/test-media-root.js';
import './helpers/test-worker.js';
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
import {
  jobsRepo,
  mediaRepo,
  partsRepo,
  sessionsRepo,
  uploadsRepo,
  usersRepo,
} from '../src/db/repositories.js';
import { sanitizeFilename, storageSlug } from '../src/lib/paths.js';
import { ensureUserDirectories } from '../src/services/isolation.js';
import { parsePartFilename } from '../src/services/multipart.js';
import { ensureSessionDir, partPath, sessionPartsDir } from '../src/services/assembly.js';
import { handleAssembleSession, beginAssembly } from '../src/worker/multipart.js';
import { processUpload } from '../src/worker/pipeline.js';

/**
 * End-to-end multi-part upload against the real database and filesystem.
 *
 * A real video is split into pieces, each piece is registered and placed
 * exactly where the part downloader would leave it, and the genuine worker
 * handlers reassemble it and drive it through the ordinary pipeline. Only the
 * Telegram fetch is bypassed; identification, deduplication, the Jellyfin
 * layout and every database write are the production code paths.
 *
 * Run with: npm run test:multipart
 */

const execFileAsync = promisify(execFile);
const log = createLogger('cli');

const TEST_CHAT_ID = -999_333_444;
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

async function makeTestVideo(target: string, seconds: number): Promise<boolean> {
  for (const bin of FFMPEG_CANDIDATES) {
    try {
      await execFileAsync(
        bin,
        [
          '-v', 'error', '-y',
          '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=640x480:rate=25`,
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
          target,
        ],
        { timeout: 120_000 },
      );
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return false;
    }
  }
  return false;
}

/** Split a file into `count` pieces, exactly as a sender would locally. */
async function splitFile(source: string, outDir: string, baseName: string, count: number) {
  const data = await fsp.readFile(source);
  const chunkSize = Math.ceil(data.length / count);
  const pieces: Array<{ filename: string; path: string; size: number }> = [];

  for (let i = 0; i < count; i += 1) {
    const slice = data.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, data.length));
    const filename = `${baseName}.part${i + 1}`;
    const target = path.join(outDir, filename);
    await fsp.writeFile(target, slice);
    pieces.push({ filename, path: target, size: slice.length });
  }
  return pieces;
}

async function cleanup(): Promise<void> {
  const users = await query<{ id: number; storage_slug: string }>(
    'SELECT id, storage_slug FROM users WHERE telegram_chat_id IN ($1, $2)',
    [TEST_CHAT_ID, TEST_CHAT_ID - 1],
  );
  for (const u of users.rows) {
    for (const root of [config.storage.moviesRoot, config.storage.tvRoot]) {
      await fsp.rm(path.join(root, u.storage_slug), { recursive: true, force: true });
    }
  }
  await query('DELETE FROM users WHERE telegram_chat_id IN ($1, $2)', [TEST_CHAT_ID, TEST_CHAT_ID - 1]);
}

/**
 * Register a part and place its bytes where the downloader would.
 *
 * This is the one shortcut: Telegram is not involved, so the part file is
 * copied into the session directory and marked READY, exactly as
 * `handleDownloadPart` would leave it.
 */
async function deliverPart(
  sessionId: number,
  piece: { filename: string; path: string; size: number },
): Promise<void> {
  const parsed = parsePartFilename(piece.filename);
  assert.ok(parsed, `${piece.filename} should parse as a part`);

  const { part } = await partsRepo.upsert({
    session_id: sessionId,
    part_number: parsed.partNumber,
    original_filename: piece.filename,
    telegram_file_id: `test-${sessionId}-${parsed.partNumber}`,
    telegram_file_unique_id: `uniq-${sessionId}-${parsed.partNumber}`,
    telegram_message_id: null,
    file_size: piece.size,
  });

  await ensureSessionDir(sessionId);
  const stored = partPath(sessionId, parsed.partNumber);
  await fsp.copyFile(piece.path, stored);

  const checksum = crypto.createHash('sha256').update(await fsp.readFile(stored)).digest('hex');
  await partsRepo.setStatus(part.id, 'READY', {
    stored_path: stored,
    checksum_sha256: checksum,
    file_size: piece.size,
    completed_at: new Date(),
  });
  await sessionsRepo.refreshCounters(sessionId);
}

async function main(): Promise<void> {
  await runMigrations();
  await cleanup();

  process.stdout.write('\nMulti-part upload end-to-end\n============================\n\n');

  const slug = storageSlug(`mp-${Date.now()}`);
  const user = await usersRepo.create({
    name: 'Multipart Tester',
    telegram_chat_id: TEST_CHAT_ID,
    jellyfin_username: slug,
    jellyfin_user_id: null,
    storage_slug: slug,
  });
  await ensureUserDirectories(user);

  const workdir = await fsp.mkdtemp(path.join(config.storage.downloadTmpDir, 'mp-e2e-'));
  const source = path.join(workdir, 'source.mp4');

  const haveFfmpeg = await makeTestVideo(source, 3);
  if (!haveFfmpeg) {
    process.stdout.write('ffmpeg unavailable; using synthetic bytes.\n');
    await fsp.writeFile(source, crypto.randomBytes(2 * 1024 * 1024));
  }

  const originalBytes = await fsp.readFile(source);
  const originalSha = crypto.createHash('sha256').update(originalBytes).digest('hex');
  process.stdout.write(
    `Source: ${originalBytes.length} bytes, sha256 ${originalSha.slice(0, 16)}…\n\n`,
  );

  // -------------------------------------------------------------------------
  process.stdout.write('1. Splitting and part recognition\n');
  const baseName = 'Interstellar.2014.1080p.BluRay.mkv';
  const pieces = await splitFile(source, workdir, baseName, 4);

  check('the file split into 4 pieces', () => assert.equal(pieces.length, 4));
  check('the pieces sum to the original size', () =>
    assert.equal(
      pieces.reduce((sum, p) => sum + p.size, 0),
      originalBytes.length,
    ),
  );
  check('each piece is recognised as a part of the same file', () => {
    for (const piece of pieces) {
      const parsed = parsePartFilename(piece.filename);
      assert.ok(parsed, `${piece.filename} not parsed`);
      assert.equal(parsed.baseFilename, baseName);
    }
  });

  // -------------------------------------------------------------------------
  process.stdout.write('\n2. Session collects parts out of order\n');
  const session = await sessionsRepo.findOrCreate({
    user_id: user.id,
    telegram_chat_id: TEST_CHAT_ID,
    base_filename: baseName,
    safe_base_filename: sanitizeFilename(baseName, 'upload'),
    extension: 'mkv',
    expected_parts: null,
  });

  // Deliberately out of order, and with a gap left until last.
  for (const index of [2, 4, 1]) await deliverPart(session.id, pieces[index - 1]!);

  const partial = await sessionsRepo.byId(session.id);
  check('three parts are recorded', () => assert.equal(partial?.received_parts, 3));
  const readyWithGap = await partsRepo.readyNumbers(session.id);
  check('the gap is detected', () => assert.deepEqual(readyWithGap, [1, 2, 4]));

  const withGap = (await sessionsRepo.byId(session.id))!;
  let refusedGap = false;
  try {
    await beginAssembly(withGap);
  } catch (err) {
    refusedGap = /missing/i.test((err as Error).message);
  }
  check('assembly refuses while part 3 is missing', () =>
    assert.ok(refusedGap, 'a session with a gap must not assemble'),
  );
  const afterRefusal = await sessionsRepo.byId(session.id);
  check('the session is still collecting after the refusal', () =>
    assert.equal(afterRefusal?.status, 'COLLECTING'),
  );

  // -------------------------------------------------------------------------
  process.stdout.write('\n3. Duplicate part is ignored\n');
  const dupBefore = await partsRepo.readyNumbers(session.id);
  await deliverPart(session.id, pieces[0]!); // resend part 1
  const dupAfter = await partsRepo.readyNumbers(session.id);
  check('resending a part does not add a new one', () =>
    assert.deepEqual(dupAfter, dupBefore),
  );

  // -------------------------------------------------------------------------
  process.stdout.write('\n4. Completing the set triggers assembly\n');
  await deliverPart(session.id, pieces[2]!); // the missing part 3

  const complete = await sessionsRepo.byId(session.id);
  check('all four parts are present', () => assert.equal(complete?.received_parts, 4));

  await beginAssembly(complete!);
  const readied = await sessionsRepo.byId(session.id);
  check('the session moved to READY', () => assert.equal(readied?.status, 'READY'));

  // `beginAssembly` queues the work for a worker; this test then does that work
  // itself. The live worker shares this database, so leaving the job claimable
  // lets both run: whichever calls `claimForAssembly` first wins and the other
  // silently does nothing, which showed up as an intermittent
  // "Upload null not found". Removing the queued job leaves exactly one
  // assembler — this test — and keeps production's assembly out of a scratch
  // media root it knows nothing about.
  const queued = await query<{ id: number }>(
    `DELETE FROM jobs WHERE type = 'assemble-session' AND payload->>'sessionId' = $1 RETURNING id`,
    [String(session.id)],
  );
  check('assembly was queued for a worker', () => assert.ok(queued.rows.length >= 1));

  await handleAssembleSession(session.id);
  const assembled = await sessionsRepo.byId(session.id);

  check('the session completed', () => assert.equal(assembled?.status, 'COMPLETED'));
  check('the assembled size matches the original', () =>
    assert.equal(assembled?.assembled_size, originalBytes.length),
  );
  check('the assembled checksum matches the original', () =>
    assert.equal(assembled?.assembled_sha256, originalSha),
  );
  check('an upload row was created for the pipeline', () => assert.ok(assembled?.upload_id));
  check('the parts directory was cleaned up', () =>
    assert.ok(!fs.existsSync(sessionPartsDir(session.id))),
  );

  // -------------------------------------------------------------------------
  process.stdout.write('\n5. Handoff into the existing pipeline\n');
  const uploadId = assembled!.upload_id!;
  const upload = await uploadsRepo.byId(uploadId);

  check('the upload points at the assembled file', () =>
    assert.ok(upload?.local_source_path?.length),
  );
  check('the upload is linked back to its session', () =>
    assert.equal(upload?.session_id, session.id),
  );
  check('the upload carries no Telegram file id', () =>
    assert.equal(upload?.telegram_file_id, null),
  );

  // Assembly queues the pipeline run; this test performs it directly. The live
  // worker would otherwise claim the same job and run it against the real media
  // root, where the assembled file — which lives in the scratch root — does not
  // exist. Removing the queued job leaves exactly one runner.
  await query(`DELETE FROM jobs WHERE type = 'process-upload' AND upload_id = $1`, [uploadId]);

  const outcome = await processUpload(uploadId, async () => {});
  check('the pipeline completed the assembled file', () =>
    assert.equal(outcome.status, 'COMPLETED'),
  );

  const finished = await uploadsRepo.byId(uploadId);
  const media = finished?.stored_path ? await mediaRepo.byPath(finished.stored_path) : null;

  check('a media row was created', () => assert.ok(media));
  check('TMDB/filename identification ran', () => assert.equal(media?.title, 'Interstellar'));
  check('the year was identified', () => assert.equal(media?.year, 2014));
  check('it landed in the Jellyfin movie layout', () =>
    assert.equal(
      path.relative(config.storage.mediaRoot, media!.path),
      path.join('movies', slug, 'Interstellar (2014)', 'Interstellar (2014).mkv'),
    ),
  );
  const finalOnDisk = await fsp.readFile(media!.path);
  check('the final file is the same length as the original', () =>
    assert.equal(finalOnDisk.length, originalBytes.length),
  );
  check('final content matches the source exactly', () =>
    assert.equal(
      crypto.createHash('sha256').update(finalOnDisk).digest('hex'),
      originalSha,
      'the reassembled media must be the original bytes',
    ),
  );
  check('the assembled temp file was consumed', () =>
    assert.ok(!fs.existsSync(upload!.local_source_path!)),
  );

  // -------------------------------------------------------------------------
  process.stdout.write('\n6. Isolation between simultaneous sessions\n');
  const otherSlug = storageSlug(`mp-other-${Date.now()}`);
  const other = await usersRepo.create({
    name: 'Multipart Other',
    telegram_chat_id: TEST_CHAT_ID - 1,
    jellyfin_username: otherSlug,
    jellyfin_user_id: null,
    storage_slug: otherSlug,
  });
  await ensureUserDirectories(other);

  const otherSession = await sessionsRepo.findOrCreate({
    user_id: other.id,
    telegram_chat_id: TEST_CHAT_ID - 1,
    base_filename: baseName,
    safe_base_filename: sanitizeFilename(baseName, 'upload'),
    extension: 'mkv',
    expected_parts: 4,
  });

  check('two users can hold sessions for the same filename', () =>
    assert.notEqual(otherSession.id, session.id),
  );
  check('each session has its own parts directory', () =>
    assert.notEqual(sessionPartsDir(otherSession.id), sessionPartsDir(session.id)),
  );

  await deliverPart(otherSession.id, pieces[0]!);
  const otherParts = await partsRepo.listForSession(otherSession.id);
  const firstParts = await partsRepo.listForSession(session.id);

  check("one session's parts do not leak into another", () => {
    assert.deepEqual(
      otherParts.map((p) => p.part_number),
      [1],
      'the second session should see only its own single part',
    );
    // The first session's rows are deliberately retained after completion so
    // the dashboard can still show what arrived; only the files are removed.
    assert.equal(firstParts.length, 4);
    for (const part of firstParts) assert.equal(part.session_id, session.id);
    for (const part of otherParts) assert.equal(part.session_id, otherSession.id);
  });

  check("the completed session's part files are gone from disk", () => {
    for (const part of firstParts) {
      assert.ok(!fs.existsSync(part.stored_path!), `${part.stored_path} should be deleted`);
    }
  });

  check("the second session's part file is still on disk", () => {
    assert.ok(fs.existsSync(otherParts[0]!.stored_path!));
  });

  // -------------------------------------------------------------------------
  process.stdout.write('\n7. Single-file uploads are unaffected\n');
  check('an ordinary filename still takes the single-file path', () =>
    assert.equal(parsePartFilename('Breaking.Bad.S02E03.1080p.mkv'), null),
  );

  // --- Teardown -------------------------------------------------------------
  await query('DELETE FROM jobs WHERE upload_id = $1', [uploadId]);
  await cleanup();
  await fsp.rm(workdir, { recursive: true, force: true });
  await fsp.rm(sessionPartsDir(otherSession.id), { recursive: true, force: true });

  process.stdout.write(
    `\n============================\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    log.error({ err }, 'Multi-part end-to-end test failed');
    process.stdout.write(`\nFATAL: ${(err as Error).message}\n${(err as Error).stack}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
