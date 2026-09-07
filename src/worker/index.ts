import os from 'node:os';
import { config, ensureDirectories } from '../config/index.js';
import { classify } from '../lib/errors.js';
import { backoffMs } from '../lib/backoff.js';
import { createLogger, scrubString } from '../lib/logger.js';
import { runMigrations } from '../db/migrate.js';
import { closePool } from '../db/pool.js';
import { jobsRepo, uploadsRepo, auditRepo, partsRepo, sessionsRepo, mtprotoJobsRepo } from '../db/repositories.js';
import type { JobRow } from '../db/types.js';
import { CancelledError, PipelineError, processUpload } from './pipeline.js';
import {
  MultipartError,
  handleAssembleSession,
  handleDownloadPart,
  sweepIdleSessions,
} from './multipart.js';
import { handleMtprotoDownload } from './mtproto.js';
import { MtprotoError, disconnectClient } from '../services/mtproto.js';
import { reapBotApiData, reapDownloadTmp, reapParts } from '../services/reaper.js';
import { type HealthState, alertFor, runHealthChecks } from '../services/health.js';
import { ProgressReporter, esc, notifyAdmin } from '../services/notifier.js';
import { reportStartupFailure } from '../lib/startup.js';

/**
 * Background worker.
 *
 * Runs as its own process so that a multi-gigabyte download never blocks the
 * bot from answering, or the dashboard from rendering. Jobs are claimed from
 * Postgres with `FOR UPDATE SKIP LOCKED`, so raising WORKER_CONCURRENCY or
 * running a second worker process is safe.
 */

const log = createLogger('worker');
const workerId = `${os.hostname()}:${process.pid}`;

let running = true;
const active = new Set<Promise<void>>();
// Capacity is tracked per lane so a long transfer cannot occupy the slots
// short work depends on. `active` remains the union, for shutdown.
const large = new Set<Promise<void>>();
const small = new Set<Promise<void>>();

/**
 * Turn the upload status the row was left in into something a person reads.
 *
 * The status at the moment of failure *is* the stage, so nothing at the throw
 * sites has to carry a label around.
 */
function stageLabel(status: string): string {
  const map: Record<string, string> = {
    QUEUED: 'Queued',
    DOWNLOADING: 'Fetching from Telegram',
    PROCESSING: 'Identifying',
    ORGANIZING: 'Organizing',
    JELLYFIN_SCAN: 'Jellyfin scan',
  };
  return map[status] ?? status;
}

/** The delay before this job's next attempt. */
function retryDelay(attempts: number): number {
  return backoffMs(attempts, {
    baseMs: config.worker.retryBackoffMs,
    maxMs: config.worker.retryMaxBackoffMs,
  });
}

async function handleJob(job: JobRow | null): Promise<void> {
  if (!job) return;
  // workerId on every line: with more than one worker, "which one" is the
  // first question a failure raises and the hardest to reconstruct later.
  const jobLog = log.child({
    jobId: job.id,
    uploadId: job.upload_id,
    attempt: job.attempts,
    workerId,
  });

  // --- MTProto ingestion ----------------------------------------------------
  if (job.type === 'mtproto-download') {
    const payload = job.payload as { mtprotoJobId?: number };
    try {
      if (typeof payload.mtprotoJobId !== 'number') {
        throw new Error('mtproto-download job has no mtprotoJobId');
      }
      await handleMtprotoDownload(payload.mtprotoJobId);
      await jobsRepo.complete(job.id);
      jobLog.info({ type: job.type }, 'Job finished');
    } catch (err) {
      // The handler has already recorded the outcome and told the sender; the
      // queue only needs to decide whether to try again.
      const retryable = err instanceof MtprotoError ? err.retryable : true;
      const message = (err as Error).message ?? 'Unknown error';
      jobLog.error({ err, retryable, type: job.type }, 'MTProto job failed');

      if (retryable) {
        await jobsRepo.fail(job.id, message, retryDelay(job.attempts));
      } else {
        await jobsRepo.failPermanently(job.id, message);
      }
    }
    return;
  }

  // --- Multi-part jobs ------------------------------------------------------
  if (job.type === 'download-part' || job.type === 'assemble-session') {
    const payload = job.payload as { partId?: number; sessionId?: number };
    try {
      if (job.type === 'download-part') {
        if (typeof payload.partId !== 'number') throw new Error('download-part job has no partId');
        await handleDownloadPart(payload.partId);
      } else {
        if (typeof payload.sessionId !== 'number') {
          throw new Error('assemble-session job has no sessionId');
        }
        await handleAssembleSession(payload.sessionId);
      }
      await jobsRepo.complete(job.id);
      jobLog.info({ type: job.type }, 'Job finished');
    } catch (err) {
      const retryable = err instanceof MultipartError ? err.retryable : true;
      const message = (err as Error).message ?? 'Unknown error';
      jobLog.error({ err, retryable, type: job.type }, 'Multi-part job failed');

      let willRetry = false;
      if (retryable) {
        ({ willRetry } = await jobsRepo.fail(
          job.id,
          message,
          retryDelay(job.attempts),
        ));
      } else {
        await jobsRepo.failPermanently(job.id, message);
      }

      // Only mark the part failed once no attempts remain, so a transient
      // network error does not make the sender resend gigabytes.
      if (!willRetry && job.type === 'download-part' && typeof payload.partId === 'number') {
        await partsRepo.setStatus(payload.partId, 'FAILED', { error_message: message.slice(0, 2000) });
        const part = await partsRepo.byId(payload.partId);
        if (part) {
          const session = await sessionsRepo.byId(part.session_id);
          if (session) {
            const { refreshSessionMessage } = await import('./multipart.js');
            await refreshSessionMessage(session).catch(() => {});
          }
        }
      }
    }
    return;
  }

  if (job.type !== 'process-upload' || job.upload_id === null) {
    jobLog.error({ type: job.type }, 'Unknown job type');
    await jobsRepo.fail(job.id, `Unknown job type: ${job.type}`, config.worker.retryBackoffMs);
    return;
  }

  const uploadId = job.upload_id;
  const startedAt = Date.now();

  try {
    const outcome = await processUpload(uploadId, async (percent) => {
      await jobsRepo.setProgress(job.id, percent);
    });

    if (outcome.status === 'CANCELLED') await jobsRepo.cancel(job.id);
    else await jobsRepo.complete(job.id);

    jobLog.info({ outcome: outcome.status, durationMs: Date.now() - startedAt }, 'Job finished');
  } catch (err) {
    if (err instanceof CancelledError) {
      await jobsRepo.cancel(job.id);
      return;
    }

    const isPipelineError = err instanceof PipelineError;
    // The classifier reads the error rather than replacing it: a throw site
    // that stated its own retryability keeps it, and everything else gains a
    // stable code, a severity, and a sentence written for a person.
    const classified = classify(err);
    const retryable = isPipelineError ? err.retryable : classified.retryable;
    // Scrubbed before it is stored or sent anywhere: the logger redacts on
    // its own, but this text also goes into the database, the sender's chat,
    // the admin alert and the Mini App, and a filesystem error can carry the
    // token-named directory the local Bot API server keeps its files in.
    const message = scrubString((err as Error).message ?? 'Unknown error');

    jobLog.error(
      {
        err,
        retryable,
        errorCode: classified.code,
        severity: classified.severity,
        uploadId,
        workerId,
      },
      'Job failed',
    );

    let willRetry = false;
    if (retryable) {
      ({ willRetry } = await jobsRepo.fail(job.id, message, retryDelay(job.attempts)));
    } else {
      // A bad file or a rejected identification will fail identically on every
      // attempt, so burn the remaining ones rather than waiting them out.
      await jobsRepo.failPermanently(job.id, message);
    }

    if (!willRetry) {
      const upload = await uploadsRepo.byId(uploadId);
      await uploadsRepo.setStatus(uploadId, 'FAILED', {
        error_message: message.slice(0, 2000),
        // The row's status at the moment of failure *is* the stage it reached,
        // so no throw site has to remember to label itself.
        error_stage: upload?.status ?? null,
        error_code: classified.code,
        error_retryable: retryable,
        error_at: new Date(),
        attempts: job.attempts,
        completed_at: new Date(),
        duration_ms: Date.now() - startedAt,
      });

      if (upload) {
        const reporter = new ProgressReporter(
          upload.telegram_chat_id,
          upload.progress_message_id,
          upload.original_filename,
        );

        // The progress message is edited into the failure rather than a new
        // message being sent, so one upload stays one chat entry.
        const label = upload.detected_title
          ? `${upload.detected_title}${upload.detected_year ? ` (${upload.detected_year})` : ''}`
          : upload.original_filename;
        const stageLine = upload.status
          ? `\n\n<b>Stage:</b> ${esc(stageLabel(upload.status))}`
          : '';

        // What the sender can act on: which attempt this was, and whether the
        // system will try again on its own. Saying "will retry" when it will
        // not is the difference between waiting and re-sending.
        const attemptLine =
          job.max_attempts > 1 ? `\n<b>Attempt:</b> ${job.attempts} of ${job.max_attempts}` : '';
        const nextLine = retryable
          ? '\n\n\u{1F504} <i>The system will try again automatically.</i>'
          : '\n\n<i>This will not resolve on its own.</i>';

        // A PipelineError carries text written for the person who sent the
        // file. Anything else is an internal fault they cannot act on, so tell
        // them plainly and escalate it to the administrator instead.
        if (isPipelineError) {
          await reporter.setText(
            `❌ <b>Upload failed</b>\n\n\u{1F3AC} <code>${esc(label)}</code>${stageLine}${attemptLine}\n\n` +
              `${err.userMessage}${nextLine}`,
          );
        } else {
          await reporter.setText(
            `❌ <b>Upload failed</b>\n\n\u{1F3AC} <code>${esc(label)}</code>${stageLine}${attemptLine}\n\n` +
              `${esc(classified.userMessage)}${nextLine}`,
          );
          // The administrator gets what the sender must not: the code, the
          // stage, and what to do about it.
          await notifyAdmin(
            `❌ <b>Upload ${uploadId} failed</b>\n` +
              `<b>${esc(classified.code)}</b> · ${esc(classified.severity)}\n` +
              (classified.action ? `<i>${esc(classified.action)}</i>\n` : '') +
              `<code>${esc(upload.original_filename)}</code>\n` +
              `chat ${upload.telegram_chat_id}\n\n` +
              `<code>${esc(message.slice(0, 500))}</code>`,
          );
        }
      }

      await auditRepo.log({
        actor_type: 'system',
        action: 'upload.failed',
        entity_type: 'upload',
        entity_id: String(uploadId),
        detail: { error: message.slice(0, 500) },
      });
    } else {
      jobLog.info({ nextAttemptIn: retryDelay(job.attempts) }, 'Job will be retried');
    }
  }
}

/**
 * Claim work, keeping each lane within its own capacity.
 *
 * The large lane is tried first so a long transfer is not left waiting behind
 * a steady trickle of short jobs; the small lane is tried whether or not the
 * large one is full, which is the whole point — a short upload always has
 * somewhere to run.
 */
async function claimNext(): Promise<JobRow | null> {
  const largeBytes = config.worker.largeUploadBytes;

  if (large.size < config.worker.largeConcurrency) {
    const job = await jobsRepo.claimForLane(workerId, 'large', largeBytes);
    if (job) return job;
  }
  if (small.size < config.worker.smallConcurrency) {
    const job = await jobsRepo.claimForLane(workerId, 'small', largeBytes);
    if (job) return job;
  }
  return null;
}

/** Which lane a claimed job belongs to, matching the SQL predicate. */
async function laneOf(job: NonNullable<JobRow | null>): Promise<'large' | 'small'> {
  if (job.type === 'mtproto-download' || job.type === 'assemble-session') return 'large';
  if (job.type !== 'process-upload' || job.upload_id === null) return 'small';
  const upload = await uploadsRepo.byId(job.upload_id).catch(() => null);
  return (upload?.file_size ?? 0) >= config.worker.largeUploadBytes ? 'large' : 'small';
}

async function loop(): Promise<void> {
  while (running) {
    try {
      if (large.size >= config.worker.largeConcurrency && small.size >= config.worker.smallConcurrency) {
        await Promise.race([...large, ...small]);
        continue;
      }

      const job = await claimNext();
      if (!job) {
        await sleep(config.worker.pollIntervalMs);
        continue;
      }

      const lane = (await laneOf(job)) === 'large' ? large : small;
      const task = handleJob(job).finally(() => lane.delete(task));
      lane.add(task);
      active.add(task);
      void task.finally(() => active.delete(task));
    } catch (err) {
      log.error({ err }, 'Worker loop error');
      await sleep(config.worker.pollIntervalMs * 2);
    }
  }

  await Promise.allSettled([...active]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How often the staging directory is swept for orphaned scratch files. */
const REAP_INTERVAL_MS = 60 * 60 * 1000;

/** The reaper is housekeeping: a failure must never stop the worker. */
/**
 * Keep queued uploads' Telegram messages showing their real position.
 *
 * Nothing runs on behalf of a job that has not been claimed yet, so without
 * this a queued upload's message would sit unchanged for as long as it waited.
 * That is the whole "it looks frozen" problem: the fix is not a spinner, it is
 * telling the user where they actually are.
 *
 * Cheap by construction — one query for the batch, and the reporter skips the
 * Telegram edit entirely when a position has not moved.
 */
/**
 * One reporter per waiting upload, kept between sweeps.
 *
 * The reporter is what remembers the last position it showed and when it last
 * edited; built fresh on every sweep it remembered nothing, so every queued
 * upload was re-edited every ten seconds and told it had been waiting 0s.
 */
const queuedReporters = new Map<number, ProgressReporter>();

async function refreshQueuePositions(): Promise<void> {
  const waiting = await jobsRepo.waitingUploadJobs();
  const seen = new Set<number>();

  for (const job of waiting) {
    try {
      const upload = await uploadsRepo.byId(job.upload_id);
      // Only uploads that already have a message to edit; never send a new one
      // from here, which would turn a queue into a stream of notifications.
      if (!upload || upload.progress_message_id === null || upload.status !== 'QUEUED') continue;
      seen.add(upload.id);

      const position = await jobsRepo.queuePosition(job.id);
      if (!position) continue;

      let reporter = queuedReporters.get(upload.id);
      if (!reporter) {
        reporter = new ProgressReporter(
          upload.telegram_chat_id,
          upload.progress_message_id,
          upload.original_filename,
          (snapshot) => uploadsRepo.setProgressSnapshot(upload.id, snapshot),
          undefined,
          { startedAt: new Date(upload.created_at).getTime() },
        );
        queuedReporters.set(upload.id, reporter);
      }
      await reporter.reportQueued(position.ahead, position.active);
    } catch (err) {
      // A queue display must never disturb the queue.
      log.debug({ err, jobId: job.id }, 'Could not refresh a queue position');
    }
  }

  // Forgotten once an upload leaves the queue, so the map tracks only what is
  // waiting right now.
  for (const id of queuedReporters.keys()) if (!seen.has(id)) queuedReporters.delete(id);
}

/**
 * Remembered health, so alerts fire on a change rather than on a timer.
 *
 * Repeating "disk is low" every ten minutes is how an operator learns to
 * ignore the channel. A message is sent when a check gets worse, and one is
 * sent when it recovers — that second message is what makes the first
 * trustworthy, because silence then genuinely means nothing is wrong.
 *
 * In memory on purpose: a worker restart re-announces anything still broken,
 * which is the right behaviour after a restart.
 */
const lastHealth = new Map<string, HealthState>();

async function sweepHealth(): Promise<void> {
  const checks = await runHealthChecks();

  for (const check of checks) {
    const previous = lastHealth.get(check.id) ?? 'ok';
    lastHealth.set(check.id, check.state);
    if (check.state === previous) continue;

    const transition = alertFor(previous, check.state);
    if (transition === null) continue;

    if (transition === 'worsened') {
      log.warn({ check: check.id, state: check.state, detail: check.detail }, 'Health check degraded');
      await notifyAdmin(
        `${check.state === 'down' ? '\u{1F534}' : '\u{1F7E0}'} <b>${esc(check.label)}</b>\n` +
          `${esc(check.detail)}` +
          (check.action ? `\n\n<i>${esc(check.action)}</i>` : ''),
      );
    } else {
      log.info({ check: check.id }, 'Health check recovered');
      await notifyAdmin(`\u{1F7E2} <b>${esc(check.label)}</b> recovered\n${esc(check.detail)}`);
    }
  }
}

async function reap(): Promise<void> {
  try {
    await reapDownloadTmp();
  } catch (err) {
    log.warn({ err }, 'Staging directory reap failed');
  }
  try {
    // A local Bot API server keeps every file it fetches. An upload that is
    // abandoned after the fetch completed leaves that copy behind forever.
    await reapBotApiData();
  } catch (err) {
    log.warn({ err }, 'Bot API data reap failed');
  }
  try {
    // Assembly removes a session's parts inline on success, cancellation and
    // expiry; this is the backstop for the two cases it cannot cover — a
    // permanently failed session nobody retried, and a directory whose row
    // vanished.
    await reapParts();
  } catch (err) {
    log.warn({ err }, 'Parts reap failed');
  }
}

async function main(): Promise<void> {
  ensureDirectories();
  await runMigrations();

  // A previous worker may have died mid-job; put that work back on the queue.
  const orphans = await jobsRepo.releaseOrphans();
  const stale = await uploadsRepo.resetStale();
  const staleParts = await partsRepo.resetStale();
  const staleSessions = await sessionsRepo.resetStale();
  const staleMtproto = await mtprotoJobsRepo.resetStale();
  if (orphans || stale || staleParts || staleSessions || staleMtproto) {
    log.warn(
      { orphans, stale, staleParts, staleSessions, staleMtproto },
      'Recovered work left by a previous run',
    );
  }

  // Scratch files left by a failed, cancelled or killed ingestion. Run once at
  // startup — right after the recovery above, so anything still owed to a job
  // it just requeued is visible in the database — and then hourly, which is
  // frequent enough given that nothing becomes reapable for hours anyway.
  await reap();
  const reaping = setInterval(() => void reap(), REAP_INTERVAL_MS);
  reaping.unref();

  const queueTicker = setInterval(
    () => void refreshQueuePositions().catch(() => {}),
    config.worker.queueRefreshMs,
  );
  queueTicker.unref();

  // Establishes the baseline before the first interval, so a condition that is
  // already bad at startup is announced rather than waited out.
  await sweepHealth().catch((err) => log.warn({ err }, 'Initial health sweep failed'));
  const healthTicker = setInterval(
    () => void sweepHealth().catch((err) => log.warn({ err }, 'Health sweep failed')),
    config.worker.healthIntervalMs,
  );
  healthTicker.unref();

  // Sessions whose sender stopped mid-upload are finalised or expired here, so
  // abandoned parts cannot occupy the disk indefinitely.
  const sweep = setInterval(
    () => {
      sweepIdleSessions()
        .then(({ assembled, expired }) => {
          if (assembled || expired) log.info({ assembled, expired }, 'Idle session sweep');
        })
        .catch((err) => log.warn({ err }, 'Idle session sweep failed'));
    },
    5 * 60 * 1000,
  );
  sweep.unref();

  log.info(
    {
      workerId,
      lanes: {
        large: config.worker.largeConcurrency,
        small: config.worker.smallConcurrency,
        largeAtBytes: config.worker.largeUploadBytes,
      },
      mediaRoot: config.storage.mediaRoot,
      jellyfinConfigured: config.jellyfin.configured,
      tmdbConfigured: config.tmdb.configured,
    },
    'Worker started',
  );

  await loop();
}

async function shutdown(signal: string): Promise<void> {
  if (!running) return;
  running = false;
  log.info({ signal, inFlight: active.size }, 'Shutting down; finishing in-flight jobs');
  // A transfer can legitimately outlast any reasonable wait, and the job it
  // was doing is put back on the queue at the next start (`releaseOrphans`,
  // `resetStale`), attempt refunded. That is the designed path, not a
  // failure — so it exits 0, and systemd does not record every deploy that
  // overlapped a download as a crashed unit.
  const timeout = setTimeout(() => {
    log.warn({ inFlight: active.size }, 'Shutdown timed out; the in-flight work will be requeued on the next start');
    process.exit(0);
  }, 60_000);
  timeout.unref();

  await Promise.allSettled([...active]);
  await disconnectClient().catch(() => {});
  await closePool();
  clearTimeout(timeout);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => log.error({ err: reason }, 'Unhandled rejection'));
process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

main().catch((err) => {
  log.fatal({ err }, 'Worker failed to start');
  reportStartupFailure(err);
  process.exit(1);
});
