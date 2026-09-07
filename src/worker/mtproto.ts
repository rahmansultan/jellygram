import { config } from '../config/index.js';
import { getLogger } from '../lib/logger.js';
import { extensionOf, safeJoin, sanitizeFilename } from '../lib/paths.js';
import { withTransaction } from '../db/pool.js';
import { auditRepo, jobsRepo, mtprotoJobsRepo, uploadsRepo, usersRepo } from '../db/repositories.js';
import type { MtprotoJobRow } from '../db/types.js';
import {
  MtprotoCancelledError,
  MtprotoError,
  downloadMedia,
  locateForwardedMedia,
} from '../services/mtproto.js';
import { checkSpaceFor, formatBytes, removeQuietly } from '../services/storage.js';
import { ProgressReporter, esc } from '../services/notifier.js';

/**
 * Worker handler for MTProto ingestion.
 *
 * Locates the media the owner forwarded, streams it to disk, verifies it, and
 * hands the result to the **existing** pipeline by creating an ordinary
 * `uploads` row with `local_source_path` set. Everything after that —
 * identification, TMDB, deduplication, the Jellyfin layout, the library scan,
 * per-user privacy — is unchanged code.
 */

function reporterFor(job: MtprotoJobRow): ProgressReporter {
  return new ProgressReporter(
    job.telegram_chat_id,
    job.progress_message_id,
    job.file_name,
    undefined,
    'mtproto',
  );
}

/**
 * Injectable transport.
 *
 * Only the two calls that touch Telegram are replaceable, and only so tests
 * can drive the handler without a network or a real account. Everything else —
 * the size and disk checks, the status machine, verification, the handoff —
 * runs the production path in tests exactly as it does in service.
 */
export interface MtprotoTransport {
  locate: typeof locateForwardedMedia;
  download: typeof downloadMedia;
}

const defaultTransport: MtprotoTransport = {
  locate: locateForwardedMedia,
  download: downloadMedia,
};

/**
 * Run one MTProto ingestion job.
 *
 * Throws `MtprotoError` so the worker can decide whether a retry is worthwhile.
 */
export async function handleMtprotoDownload(
  jobId: number,
  transport: MtprotoTransport = defaultTransport,
): Promise<void> {
  const log = getLogger().child({ mtprotoJobId: jobId });

  const job = await mtprotoJobsRepo.byId(jobId);
  if (!job) return;

  if (job.cancel_requested || job.status === 'CANCELLED') {
    log.info('Job cancelled before it started');
    return;
  }

  const user = await usersRepo.byId(job.user_id);
  if (!user) {
    await mtprotoJobsRepo.setStatus(jobId, 'FAILED', {
      error_message: 'The owning user no longer exists',
      completed_at: new Date(),
    });
    return;
  }

  // Claim it. If another worker (or a stale queue entry for the same job) got
  // there first, leave it alone rather than downloading the same file twice.
  const claimed = await mtprotoJobsRepo.claimForDownload(jobId);
  if (!claimed) {
    log.info({ status: job.status }, 'Job is already being handled; skipping');
    return;
  }

  const reporter = reporterFor(job);
  const attempts = claimed.attempts;

  let tempPath: string | null = null;

  try {
    // --- 0. Size and disk --------------------------------------------------
    if (job.file_size > config.mtproto.maxFileBytes) {
      throw new MtprotoError(
        `File is ${job.file_size} bytes, above the MTProto ceiling`,
        `❌ That file is ${formatBytes(job.file_size)}, above the ` +
          `${formatBytes(config.mtproto.maxFileBytes)} maximum.`,
        false,
        'config',
      );
    }

    const space = await checkSpaceFor(job.file_size);
    if (!space.ok) {
      throw new MtprotoError(
        `Insufficient disk space: ${space.reason}`,
        `❌ Not enough server storage for this file.\n${esc(space.reason ?? '')}`,
        true,
        'other',
      );
    }

    // --- 1. Locate ----------------------------------------------------------
    await reporter.setText(
      `\u{1F50D} <b>Locating media</b>\n<code>${esc(job.file_name)}</code>\n\n` +
        `Searching your Telegram account…`,
    );

    const located = await transport.locate({
      originKind: job.origin_kind,
      originChat: job.origin_chat,
      originMessageId: job.origin_message_id,
      fileName: job.file_name,
      fileSize: job.file_size,
    });

    // Trust the size MTProto reports over the one the Bot API guessed.
    if (located.size > 0 && located.size !== job.file_size) {
      await mtprotoJobsRepo.patch(jobId, { file_size: located.size });
    }
    const expectedSize = located.size || job.file_size;

    if (expectedSize > config.mtproto.maxFileBytes) {
      throw new MtprotoError(
        `Located file is ${expectedSize} bytes, above the ceiling`,
        `❌ That file is ${formatBytes(expectedSize)}, above the ` +
          `${formatBytes(config.mtproto.maxFileBytes)} maximum.`,
        false,
        'config',
      );
    }

    // --- 2. Download --------------------------------------------------------
    await mtprotoJobsRepo.setStatus(jobId, 'DOWNLOADING');

    // The filename is sanitised before it ever touches the filesystem, and the
    // job id keeps concurrent downloads from colliding on one temp file.
    const safeName = sanitizeFilename(job.file_name, `mtproto-${jobId}`);
    const destination = safeJoin(
      config.storage.downloadTmpDir,
      `mtproto-${jobId}-${Date.now()}-${safeName}`,
    );

    // The same reporter the Bot API route uses, so an MTProto transfer looks
    // identical in the chat and is rate-limited the same way.
    await reporter.setStage('DOWNLOADING');

    const result = await transport.download(located.media, {
      destination,
      expectedSize,
      onProgress: async (bytes, total, speed) => {
        await mtprotoJobsRepo.setProgress(jobId, bytes, speed);
        await reporter.reportTransfer(bytes, total);
      },
      shouldCancel: () => mtprotoJobsRepo.isCancelRequested(jobId),
    });

    tempPath = result.path;

    // --- 3. Verify ----------------------------------------------------------
    await mtprotoJobsRepo.setStatus(jobId, 'VERIFYING');
    await mtprotoJobsRepo.patch(jobId, {
      sha256: result.sha256,
      temp_path: result.path,
      bytes_downloaded: result.bytes,
    });

    log.info({ bytes: result.bytes, via: located.via }, 'MTProto media downloaded');

    // --- 4. Hand off to the existing pipeline -------------------------------
    // The name MTProto reports is preferred: it is the document's real
    // filename, which is what identification should run against.
    const finalName = located.fileName ?? job.file_name;
    const extension = extensionOf(finalName) || extensionOf(job.file_name);

    // One transaction: the upload row, the job that will process it and the
    // status that says so land together or not at all. Written as separate
    // statements, a crash between them left a job with no upload, an upload
    // with no job, or a HANDOFF row nothing would ever finish.
    const upload = await withTransaction(async (client) => {
      await mtprotoJobsRepo.setStatus(jobId, 'HANDOFF', {}, client);
      const created = await uploadsRepo.createFromMtproto(
        {
          user_id: job.user_id,
          telegram_chat_id: job.telegram_chat_id,
          mtproto_job_id: jobId,
          original_filename: finalName,
          safe_filename: sanitizeFilename(finalName, `mtproto-${jobId}`),
          extension,
          file_size: result.bytes,
          local_source_path: result.path,
          progress_message_id: reporter.messageId,
        },
        client,
      );
      await mtprotoJobsRepo.patch(jobId, { upload_id: created.id }, client);
      await jobsRepo.enqueue(
        { type: 'process-upload', upload_id: created.id, max_attempts: config.worker.maxAttempts },
        client,
      );
      await mtprotoJobsRepo.setStatus(jobId, 'COMPLETED', { completed_at: new Date() }, client);
      return created;
    });
    tempPath = null; // now owned by the pipeline

    await auditRepo.log({
      actor_type: 'system',
      action: 'mtproto.downloaded',
      entity_type: 'mtproto_job',
      entity_id: String(jobId),
      detail: { uploadId: upload.id, bytes: result.bytes, via: located.via, attempts },
    });

    log.info({ uploadId: upload.id }, 'Handed MTProto media to the pipeline');
  } catch (err) {
    if (tempPath) await removeQuietly(tempPath);

    if (err instanceof MtprotoCancelledError) {
      await mtprotoJobsRepo.setStatus(jobId, 'CANCELLED', { completed_at: new Date() });
      await reporter.setText(
        `\u{1F6D1} <b>Cancelled</b>\n<code>${esc(job.file_name)}</code>`,
      );
      return;
    }

    const isMtprotoError = err instanceof MtprotoError;
    const kind = isMtprotoError ? err.kind : 'other';
    const retryable = isMtprotoError ? err.retryable : true;
    const message = (err as Error).message ?? 'Unknown error';

    // A message the account cannot reach will not become reachable on a retry.
    const terminal = kind === 'not-found' || kind === 'access' || kind === 'auth' || !retryable;
    const exhausted = attempts >= config.mtproto.maxAttempts;

    if (terminal || exhausted) {
      await mtprotoJobsRepo.setStatus(jobId, kind === 'not-found' ? 'UNAVAILABLE' : 'FAILED', {
        error_message: message.slice(0, 2000),
        completed_at: new Date(),
      });
      await reporter.setText(
        isMtprotoError
          ? `${err.userMessage}\n\n<code>${esc(job.file_name)}</code>`
          : `❌ Could not fetch that media.\n<code>${esc(job.file_name)}</code>`,
      );
      await auditRepo.log({
        actor_type: 'system',
        action: 'mtproto.failed',
        entity_type: 'mtproto_job',
        entity_id: String(jobId),
        detail: { kind, attempts, error: message.slice(0, 500) },
      });
    } else {
      await mtprotoJobsRepo.setStatus(jobId, 'PENDING', { error_message: message.slice(0, 2000) });
      await reporter.setText(
        `\u{1F504} <b>Retrying</b>\n<code>${esc(job.file_name)}</code>\n\n` +
          `Attempt ${attempts} of ${config.mtproto.maxAttempts} was interrupted.`,
      );
    }

    // Rethrown so the worker applies its own backoff and retry accounting.
    throw err;
  }
}

/** Requeue a failed job from the dashboard. */
export async function retryMtprotoJob(jobId: number): Promise<boolean> {
  const job = await mtprotoJobsRepo.byId(jobId);
  if (!job) return false;
  if (['PENDING', 'LOCATING', 'DOWNLOADING', 'VERIFYING', 'HANDOFF'].includes(job.status)) {
    return false;
  }

  await mtprotoJobsRepo.setStatus(jobId, 'PENDING', { error_message: null, completed_at: null });
  // A fresh budget: the failed run's attempts would otherwise make the very
  // first transient error of the retry a terminal one.
  await mtprotoJobsRepo.patch(jobId, { cancel_requested: false, bytes_downloaded: 0, attempts: 0 });

  await jobsRepo.enqueue({
    type: 'mtproto-download',
    upload_id: null,
    mtproto_job_id: jobId,
    payload: { mtprotoJobId: jobId },
    max_attempts: config.mtproto.maxAttempts,
  });
  return true;
}
