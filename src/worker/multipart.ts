import fsp from 'node:fs/promises';
import { config } from '../config/index.js';
import { getLogger } from '../lib/logger.js';
import { safeJoin } from '../lib/paths.js';
import { withTransaction } from '../db/pool.js';
import {
  auditRepo,
  jobsRepo,
  partsRepo,
  sessionsRepo,
  uploadsRepo,
} from '../db/repositories.js';
import type { UploadPartRow, UploadSessionRow } from '../db/types.js';
import {
  DownloadCancelledError,
  TelegramFileError,
  downloadTelegramFile,
  takeLocalFile,
} from '../services/download.js';
import {
  AssemblyCancelledError,
  AssemblyError,
  assembleParts,
  cleanupSessionParts,
  ensureSessionDir,
  partPath,
} from '../services/assembly.js';
import { checkSpaceFor, formatBytes, hashFile, removeQuietly } from '../services/storage.js';
import { isComplete, describeMissing, missingParts } from '../services/multipart.js';
import { ProgressReporter, esc, sendMessage } from '../services/notifier.js';

/**
 * Worker handlers for multi-part uploads.
 *
 * Two job types:
 *   `download-part`     fetch one piece into the session's scratch directory
 *   `assemble-session`  concatenate the pieces and hand the result to the
 *                       ordinary single-file pipeline
 *
 * Everything after assembly — identification, TMDB, deduplication, the Jellyfin
 * layout, the library scan — is the existing pipeline, unchanged.
 */

export class MultipartError extends Error {
  constructor(
    message: string,
    readonly userMessage: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'MultipartError';
  }
}

/** One progress message per session, edited in place. */
function reporterFor(session: UploadSessionRow): ProgressReporter {
  return new ProgressReporter(
    session.telegram_chat_id,
    session.progress_message_id,
    session.base_filename,
    undefined,
    'multipart',
  );
}

function progressBar(done: number, total: number): string {
  const width = 18;
  const ratio = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  const filled = Math.round(ratio * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** The status line the sender sees while parts are still arriving. */
async function renderCollecting(session: UploadSessionRow): Promise<string> {
  const ready = await partsRepo.readyNumbers(session.id);
  const failed = await partsRepo.failedCount(session.id);
  const expected = session.expected_parts;
  const missing = missingParts(ready, expected);

  const head =
    `\u{1F9E9} <b>Collecting parts</b>\n<code>${esc(session.base_filename)}</code>\n\n` +
    (expected
      ? `<code>${progressBar(ready.length, expected)}</code> ${ready.length}/${expected}\n`
      : `Parts received: <b>${ready.length}</b>\n`) +
    `${formatBytes(session.received_bytes)} so far\n`;

  const tail = missing.length
    ? `\n\u{23F3} Waiting for part${missing.length > 1 ? 's' : ''}: ${describeMissing(missing)}`
    : expected
      ? ''
      : `\n\nSend the next part, or /finish when the last one is in.`;

  const failures = failed > 0 ? `\n\u{26A0}\u{FE0F} ${failed} part(s) failed — /retry to try again` : '';

  return head + tail + failures;
}

/** Push the current collecting state into the session's Telegram message. */
export async function refreshSessionMessage(session: UploadSessionRow): Promise<void> {
  const reporter = reporterFor(session);
  await reporter.setText(await renderCollecting(session));
  if (reporter.messageId !== null && session.progress_message_id === null) {
    await sessionsRepo.patch(session.id, { progress_message_id: reporter.messageId });
  }
}

// ---------------------------------------------------------------------------
// download-part
// ---------------------------------------------------------------------------

export async function handleDownloadPart(partId: number): Promise<void> {
  const log = getLogger().child({ partId });

  const part = await partsRepo.byId(partId);
  if (!part) return;

  const session = await sessionsRepo.byId(part.session_id);
  if (!session) return;

  if (session.cancel_requested || session.status === 'CANCELLED') {
    log.info({ sessionId: session.id }, 'Session cancelled; skipping part');
    return;
  }

  // A part that will not fit is refused before anything is written.
  const space = await checkSpaceFor(part.file_size);
  if (!space.ok) {
    throw new MultipartError(
      `Insufficient disk space for part ${part.part_number}: ${space.reason}`,
      `❌ Not enough server storage for part ${part.part_number}.\n${esc(space.reason ?? '')}`,
      true,
    );
  }

  // Only Telegram parts are fetched here. A part the uploader streamed
  // directly is already on disk and was marked READY on arrival.
  if (!part.telegram_file_id) {
    throw new MultipartError(
      `Part ${part.part_number} has no Telegram file id and cannot be downloaded`,
      `❌ Part ${part.part_number} is missing its source reference.`,
      false,
    );
  }

  await partsRepo.setStatus(part.id, 'DOWNLOADING');
  await ensureSessionDir(session.id);

  const destination = partPath(session.id, part.part_number);
  // The scratch directory is the download target for parts, so the generic
  // downloader's containment check is satisfied by staging through it.
  const staging = safeJoin(config.storage.downloadTmpDir, `part-${part.id}-${Date.now()}`);

  let bytes = 0;
  try {
    const result = await downloadTelegramFile({
      fileId: part.telegram_file_id,
      destination: staging,
      expectedSize: part.file_size,
      onProgress: async (received) => {
        await partsRepo.setProgress(part.id, received);
      },
      shouldCancel: async () => {
        const current = await sessionsRepo.byId(session.id);
        return current?.cancel_requested === true;
      },
    });
    bytes = result.bytes;

    // Move into the session directory only once it is complete, so a partial
    // download can never be mistaken for a finished part.
    await takeLocalFile(staging, destination);
  } catch (err) {
    await removeQuietly(staging);

    if (err instanceof DownloadCancelledError) {
      await partsRepo.setStatus(part.id, 'PENDING');
      return;
    }

    const retryable = err instanceof TelegramFileError ? err.retryable : true;
    throw new MultipartError(
      `Part ${part.part_number} download failed: ${(err as Error).message}`,
      `❌ Part ${part.part_number} could not be downloaded.\n${esc((err as Error).message)}`,
      retryable,
    );
  }

  const checksum = await hashFile(destination);
  await partsRepo.setStatus(part.id, 'READY', {
    stored_path: destination,
    checksum_sha256: checksum,
    file_size: bytes,
    completed_at: new Date(),
  });

  const refreshed = await sessionsRepo.refreshCounters(session.id);
  log.info({ sessionId: session.id, partNumber: part.part_number, bytes }, 'Part ready');

  if (refreshed) await maybeFinalise(refreshed);
}

/**
 * Move a session to assembly when every part has arrived.
 *
 * Only sessions with a declared total finalise on their own; without one the
 * server cannot know whether more parts are coming, so it waits for /finish or
 * the idle sweep.
 */
export async function maybeFinalise(session: UploadSessionRow): Promise<boolean> {
  if (session.status !== 'COLLECTING') return false;

  const ready = await partsRepo.readyNumbers(session.id);

  if (session.expected_parts !== null && isComplete(ready, session.expected_parts)) {
    await beginAssembly(session);
    return true;
  }

  await refreshSessionMessage(session);
  return false;
}

/**
 * Mark a session ready and queue the assembly job.
 *
 * Safe to call twice: the status guard in `claimForAssembly` means only one
 * worker ever concatenates a given session.
 */
export async function beginAssembly(session: UploadSessionRow): Promise<void> {
  const ready = await partsRepo.readyNumbers(session.id);
  const missing = missingParts(ready, session.expected_parts);

  if (ready.length === 0) {
    throw new MultipartError(
      'Cannot assemble a session with no parts',
      '❌ No parts have been received yet.',
      false,
    );
  }
  if (missing.length > 0) {
    throw new MultipartError(
      `Session ${session.id} is missing parts ${missing.join(', ')}`,
      `❌ Cannot assemble yet — missing part${missing.length > 1 ? 's' : ''}: ${describeMissing(missing)}`,
      false,
    );
  }

  const updated = await sessionsRepo.setStatus(session.id, 'READY');
  if (!updated) return;

  await jobsRepo.enqueue({
    type: 'assemble-session',
    upload_id: null,
    session_id: session.id,
    payload: { sessionId: session.id },
    // Ahead of part downloads: finishing a started file beats starting another.
    priority: 50,
    max_attempts: config.worker.maxAttempts,
  });

  const reporter = reporterFor(updated);
  await reporter.setText(
    `\u{1F9E9} <b>All parts received</b>\n<code>${esc(updated.base_filename)}</code>\n\n` +
      `${ready.length} parts • ${formatBytes(updated.received_bytes)}\n\nReassembling…`,
  );
}

// ---------------------------------------------------------------------------
// assemble-session
// ---------------------------------------------------------------------------

/**
 * Which part the assembler is inside, from the byte offset it has reached.
 *
 * Derived from the parts' own sizes rather than tracked separately, so it
 * cannot drift out of step with the bytes actually written.
 */
function partIndexAt(parts: UploadPartRow[], written: number): number {
  let offset = 0;
  for (let i = 0; i < parts.length; i += 1) {
    offset += parts[i]?.file_size ?? 0;
    if (written <= offset) return i + 1;
  }
  return parts.length;
}

export async function handleAssembleSession(sessionId: number): Promise<void> {
  const log = getLogger().child({ sessionId });

  const claimed = await sessionsRepo.claimForAssembly(sessionId);
  if (!claimed) {
    log.debug('Session is not in READY state; another worker has it');
    return;
  }

  const reporter = reporterFor(claimed);

  try {
    if (claimed.cancel_requested) throw new AssemblyCancelledError();

    const parts = (await partsRepo.listForSession(claimed.id)).filter((p) => p.status === 'READY');
    const totalBytes = parts.reduce((sum, p) => sum + p.file_size, 0);

    // Assembly needs room for the output alongside the parts still on disk.
    const space = await checkSpaceFor(totalBytes);
    if (!space.ok) {
      throw new MultipartError(
        `Insufficient disk space to assemble: ${space.reason}`,
        `❌ Not enough server storage to reassemble this file.\n${esc(space.reason ?? '')}`,
        true,
      );
    }

    const destination = safeJoin(
      config.storage.downloadTmpDir,
      `assembled-${claimed.id}-${Date.now()}-${claimed.safe_base_filename}`,
    );

    await reporter.setStage('ASSEMBLING');
    const result = await assembleParts(parts as UploadPartRow[], destination, {
      onProgress: async (written, total) => {
        // Which piece is being written, alongside the overall byte progress.
        const index = partIndexAt(parts as UploadPartRow[], written);
        reporter.setPart(index, parts.length);
        await reporter.reportTransfer(written, total);
      },
      shouldCancel: async () => {
        const current = await sessionsRepo.byId(claimed.id);
        return current?.cancel_requested === true;
      },
    });

    // --- Verify -------------------------------------------------------------
    await sessionsRepo.setStatus(claimed.id, 'VERIFYING');
    await reporter.setText(
      `\u{1F50E} <b>Verifying</b>\n<code>${esc(claimed.base_filename)}</code>\n\n` +
        `${formatBytes(result.bytes)} assembled from ${parts.length} parts.`,
    );

    if (result.bytes !== totalBytes) {
      throw new MultipartError(
        `Assembled ${result.bytes} bytes, parts totalled ${totalBytes}`,
        '❌ The reassembled file did not match the size of its parts.',
        true,
      );
    }

    await sessionsRepo.patch(claimed.id, {
      assembled_path: result.path,
      assembled_size: result.bytes,
      assembled_sha256: result.sha256,
    });

    // --- Hand off to the ordinary pipeline ----------------------------------
    // One transaction: the upload row, the job that will process it and the
    // session's final status land together or not at all. As separate
    // statements, a crash between them left an upload with no job (stuck at
    // QUEUED with no way to retry) or a HANDOFF session that blocked its
    // filename and protected its parts and assembled file forever.
    const upload = await withTransaction(async (client) => {
      await sessionsRepo.setStatus(claimed.id, 'HANDOFF', {}, client);
      const created = await uploadsRepo.createFromSession(
        {
          user_id: claimed.user_id,
          telegram_chat_id: claimed.telegram_chat_id,
          session_id: claimed.id,
          original_filename: claimed.base_filename,
          safe_filename: claimed.safe_base_filename,
          extension: claimed.extension,
          file_size: result.bytes,
          local_source_path: result.path,
          progress_message_id: claimed.progress_message_id,
          source: claimed.source,
        },
        client,
      );
      await sessionsRepo.patch(claimed.id, { upload_id: created.id }, client);
      await jobsRepo.enqueue(
        { type: 'process-upload', upload_id: created.id, max_attempts: config.worker.maxAttempts },
        client,
      );
      await sessionsRepo.setStatus(claimed.id, 'COMPLETED', { completed_at: new Date() }, client);
      return created;
    });

    // The parts are redundant once the assembled file exists and is queued.
    await cleanupSessionParts(claimed.id);

    await auditRepo.log({
      actor_type: 'system',
      action: 'multipart.assembled',
      entity_type: 'session',
      entity_id: String(claimed.id),
      detail: { parts: parts.length, bytes: result.bytes, uploadId: upload.id },
    });

    log.info({ uploadId: upload.id, bytes: result.bytes, parts: parts.length }, 'Session assembled');
  } catch (err) {
    if (err instanceof AssemblyCancelledError) {
      await sessionsRepo.setStatus(claimed.id, 'CANCELLED', { completed_at: new Date() });
      await cleanupSessionParts(claimed.id);
      await reporter.setText(
        `\u{1F6D1} <b>Upload cancelled</b>\n<code>${esc(claimed.base_filename)}</code>`,
      );
      return;
    }

    const userMessage =
      err instanceof AssemblyError || err instanceof MultipartError
        ? err.userMessage
        : '❌ Could not reassemble this upload.';
    const retryable =
      err instanceof AssemblyError || err instanceof MultipartError ? err.retryable : true;

    // Parts are deliberately kept on a failure so a retry does not require
    // re-uploading gigabytes.
    await sessionsRepo.setStatus(claimed.id, retryable ? 'READY' : 'FAILED', {
      error_message: (err as Error).message.slice(0, 2000),
      completed_at: retryable ? null : new Date(),
    });
    await reporter.setText(
      `${userMessage}\n\nYour parts are still on the server; /retry to try again.`,
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Idle sweep
// ---------------------------------------------------------------------------

/**
 * Finalise or expire sessions that have gone quiet.
 *
 * A session whose parts form a complete 1..N run is assembled — the sender
 * simply never said /finish. One with gaps is expired, and its parts removed,
 * so an abandoned upload cannot hold gigabytes indefinitely.
 */
export async function sweepIdleSessions(): Promise<{ assembled: number; expired: number }> {
  const log = getLogger();
  let assembled = 0;
  let expired = 0;

  for (const session of await sessionsRepo.idleSessions(config.multipart.idleMinutes)) {
    const ready = await partsRepo.readyNumbers(session.id);
    const missing = missingParts(ready, session.expected_parts);

    if (ready.length > 0 && missing.length === 0) {
      try {
        await beginAssembly(session);
        assembled += 1;
        log.info({ sessionId: session.id }, 'Idle session had all parts; assembling');
      } catch (err) {
        log.warn({ err, sessionId: session.id }, 'Could not assemble idle session');
      }
      continue;
    }

    await sessionsRepo.setStatus(session.id, 'EXPIRED', {
      error_message: missing.length
        ? `Expired after ${config.multipart.idleMinutes} minutes; missing parts ${missing.join(', ')}`
        : `Expired after ${config.multipart.idleMinutes} minutes with no parts`,
      completed_at: new Date(),
    });
    await cleanupSessionParts(session.id);
    expired += 1;

    await sendMessage(
      session.telegram_chat_id,
      `\u{23F0} <b>Upload expired</b>\n<code>${esc(session.base_filename)}</code>\n\n` +
        (missing.length
          ? `Never received part${missing.length > 1 ? 's' : ''} ${describeMissing(missing)}.`
          : 'No parts were received.') +
        `\n\nThe parts that did arrive have been removed. Start again when you are ready.`,
    );
    log.info({ sessionId: session.id, missing }, 'Session expired');
  }

  return { assembled, expired };
}

/** Remove a cancelled session's parts and tell the sender. */
export async function cancelSession(sessionId: number, reason: string): Promise<void> {
  const session = await sessionsRepo.byId(sessionId);
  if (!session) return;

  await sessionsRepo.setStatus(sessionId, 'CANCELLED', {
    error_message: reason,
    completed_at: new Date(),
  });
  await cleanupSessionParts(sessionId);

  if (session.assembled_path) await removeQuietly(session.assembled_path);

  await sendMessage(
    session.telegram_chat_id,
    `\u{1F6D1} <b>Upload cancelled</b>\n<code>${esc(session.base_filename)}</code>\n\n${esc(reason)}`,
  );
}

/** Requeue every failed part, and reassemble if that completes the set. */
export async function retrySession(sessionId: number): Promise<{ requeued: number }> {
  const session = await sessionsRepo.byId(sessionId);
  if (!session) return { requeued: 0 };

  if (session.status === 'FAILED' || session.status === 'EXPIRED') {
    await sessionsRepo.setStatus(sessionId, 'COLLECTING', { error_message: null });
  }
  await sessionsRepo.patch(sessionId, { cancel_requested: false });

  const reset = await partsRepo.resetFailed(sessionId);
  for (const part of reset) {
    await jobsRepo.enqueue({
      type: 'download-part',
      upload_id: null,
      session_id: sessionId,
      payload: { partId: part.id, sessionId },
      max_attempts: config.worker.maxAttempts,
    });
  }

  if (reset.length === 0) {
    const refreshed = await sessionsRepo.byId(sessionId);
    if (refreshed) await beginAssembly(refreshed).catch(() => {});
  }

  await fsp.mkdir(config.multipart.partsDir, { recursive: true }).catch(() => {});
  return { requeued: reset.length };
}
