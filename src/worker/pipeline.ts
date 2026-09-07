import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { getLogger } from '../lib/logger.js';
import { safeJoin } from '../lib/paths.js';
import { mediaRepo, uploadsRepo, usersRepo, auditRepo, librariesRepo } from '../db/repositories.js';
import type { MediaRow, UploadRow, UserRow } from '../db/types.js';
import {
  DownloadCancelledError,
  TelegramFileError,
  downloadTelegramFile,
  takeLocalFile,
} from '../services/download.js';
import { identify, probeFile, MIN_CONFIDENCE, type Identification } from '../services/identify.js';
import { planPlacement, withCollisionSuffix } from '../services/organize.js';
import {
  checkSpaceFor,
  exists,
  formatBytes,
  hashFile,
  moveFile,
  quarantine,
  removeQuietly,
  ensureDir,
  formatDuration,
} from '../services/storage.js';
import * as jf from '../services/jellyfin.js';
import { ensureUserDirectories } from '../services/isolation.js';
import { ProgressReporter, esc } from '../services/notifier.js';
import type { Route } from '../services/progress.js';
import { classify } from '../lib/errors.js';

/**
 * The upload pipeline:
 *
 *   RECEIVED -> DOWNLOADING -> PROCESSING -> ORGANIZING -> JELLYFIN_SCAN -> COMPLETED
 *
 * Each stage updates the database first and the Telegram message second, so
 * the dashboard is authoritative even if Telegram is unreachable.
 */

export class PipelineError extends Error {
  constructor(
    message: string,
    /** User-facing text; never contains paths or internals. */
    readonly userMessage: string,
    readonly retryable: boolean,
    /** What was wrapped, so the failure is classified by its real cause. */
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PipelineError';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Upload cancelled by administrator');
    this.name = 'CancelledError';
  }
}

interface Context {
  upload: UploadRow;
  user: UserRow;
  reporter: ProgressReporter;
}

export interface PipelineOutcome {
  status: 'COMPLETED' | 'DUPLICATE' | 'CANCELLED' | 'NEEDS_REVIEW';
  mediaId?: number;
  path?: string;
}

/**
 * Injectable collaborators.
 *
 * Only the Telegram fetch is injectable, and only so the end-to-end test can
 * supply bytes from disk instead of the network. Every other stage runs the
 * production code path in tests exactly as it does in service.
 */
export interface PipelineDeps {
  download: typeof downloadTelegramFile;
}

const defaultDeps: PipelineDeps = { download: downloadTelegramFile };

/** Run one upload end to end. Throws `PipelineError` on failure. */
/**
 * Which steps this upload will actually perform.
 *
 * A file already staged on disk (assembled from parts, fetched over MTProto, or
 * pushed by the uploader) is never fetched from Telegram, and a Bot API upload
 * never assembles parts. Listing steps that will not run would misdescribe the
 * work as surely as a made-up percentage would.
 */
function routeFor(upload: UploadRow): Route {
  if (upload.source === 'mtproto') return 'mtproto';
  if (upload.source === 'direct') return 'direct';
  if (upload.local_source_path) return 'multipart';
  return config.telegram.localMode ? 'telegram-local' : 'telegram-cloud';
}

export async function processUpload(
  uploadId: number,
  onProgress: (percent: number) => Promise<void>,
  deps: PipelineDeps = defaultDeps,
): Promise<PipelineOutcome> {
  const log = getLogger().child({ uploadId });
  const startedAt = Date.now();

  const upload = await uploadsRepo.byId(uploadId);
  if (!upload) throw new PipelineError(`Upload ${uploadId} not found`, 'Upload record is missing.', false);

  const user = await usersRepo.byId(upload.user_id);
  if (!user) throw new PipelineError(`User ${upload.user_id} missing`, 'Your account was removed.', false);

  const reporter = new ProgressReporter(
    upload.telegram_chat_id,
    upload.progress_message_id,
    upload.original_filename,
    // The dashboard is not rate-limited the way the Telegram edit is, so every
    // state change is published here even when no message is sent.
    async (snapshot) => {
      // Persist the message id the first time one exists, so a restart resumes
      // the same message rather than starting a second one.
      if (snapshot.messageId !== null && upload.progress_message_id === null) {
        upload.progress_message_id = snapshot.messageId;
        await uploadsRepo.patch(uploadId, { progress_message_id: snapshot.messageId });
      }
      await uploadsRepo.setProgressSnapshot(uploadId, snapshot);
    },
    routeFor(upload),
  );
  const ctx: Context = { upload, user, reporter };

  const checkCancel = async () => {
    if (await uploadsRepo.isCancelRequested(uploadId)) throw new CancelledError();
  };

  let tempPath: string | null = null;

  try {
    await checkCancel();

    // --- 0. Already filed? --------------------------------------------------
    // A worker restarted after the file was moved into the library but before
    // the upload was marked done comes back here with the upload re-queued.
    // Re-running from the top fetched the whole file again and then found the
    // earlier attempt's own media row as a "duplicate" — or, if the restart
    // fell between the move and the row, filed a second copy. The row is
    // written before the move now, so a row whose file exists means the
    // filing is done and only the Jellyfin step and the bookkeeping remain.
    const prior = await mediaRepo.byUploadId(uploadId);
    if (prior) {
      if (await exists(prior.path)) {
        log.info({ mediaId: prior.id, path: prior.path }, 'Already filed by an earlier attempt; resuming');
        return finishFiled(ctx, prior, startedAt, log);
      }
      // The reservation outlived the file it reserved: the move never
      // happened, so the row says nothing true and would only block the
      // re-run's own insert.
      log.warn({ mediaId: prior.id, path: prior.path }, 'Earlier attempt left a media row with no file; removing it');
      await mediaRepo.remove(prior.id);
    }

    // --- 1. Disk space ------------------------------------------------------
    // A file already staged on this filesystem — assembled parts, an MTProto
    // fetch, a direct upload — is moved into place, not copied, so it needs
    // only the safety margin; charging its size again refused large uploads
    // near the floor after the sender had already transferred everything.
    const space = await checkSpaceFor(upload.local_source_path ? 0 : upload.file_size);
    if (!space.ok) {
      throw new PipelineError(
        `Insufficient disk space: ${space.reason}`,
        `❌ Not enough server storage for this file.\n${esc(space.reason ?? '')}`,
        // Space may free up; allow the retry schedule to try again.
        true,
      );
    }

    // --- 2. Download --------------------------------------------------------
    await uploadsRepo.setStatus(uploadId, 'DOWNLOADING');
    await ensureDir(config.storage.downloadTmpDir, config.storage.mediaRoot);
    reporter.resetTimers();
    await reporter.setStage('DOWNLOADING');

    const tempName = `${upload.id}-${Date.now()}-${upload.safe_filename}`;
    const destination = safeJoin(config.storage.downloadTmpDir, tempName);

    let downloaded;
    let fetchStage: string | null = null;
    try {
      if (upload.local_source_path) {
        // Assembled from a multi-part session: the bytes are already on this
        // machine, so they are moved into place rather than fetched again.
        await reporter.setStage('ASSEMBLING');
        downloaded = await takeLocalFile(upload.local_source_path, destination, {
          onProgress: async (bytes, total) => {
            await onProgress(total > 0 ? (bytes / total) * 40 : 0);
            await reporter.reportTransfer(bytes, total);
          },
        });
      } else {
        if (!upload.telegram_file_id) {
          throw new PipelineError(
            'Upload has no telegram_file_id',
            '❌ Missing Telegram file reference.',
            false,
          );
        }
        downloaded = await deps.download({
          fileId: upload.telegram_file_id,
          destination,
          expectedSize: upload.file_size,
          // In local Bot API mode nothing is copyable until the server has
          // pulled the whole file from Telegram, which for a 2 GB movie is
          // tens of minutes. `observedBytes` is the real size of the partial
          // file on disk when it could be attributed to this fetch; when it
          // could not, the elapsed time is shown and no percentage at all.
          onWaiting: async (elapsedMs, budgetMs, observedBytes) => {
            if (fetchStage !== 'FETCHING') {
              fetchStage = 'FETCHING';
              await reporter.setStage('FETCHING');
            }
            if (observedBytes !== null && upload.file_size > 0) {
              await reporter.reportTransfer(observedBytes, upload.file_size);
              await onProgress(Math.min(40, (observedBytes / upload.file_size) * 40));
            } else {
              await reporter.reportUnmeasured(
                `Telegram is still sending this file to the server (up to ${formatDuration(budgetMs)}).`,
              );
            }
          },
          onProgress: async (bytes, total) => {
            await onProgress(total > 0 ? (bytes / total) * 40 : 0);
            await reporter.reportTransfer(bytes, total);
          },
          shouldCancel: () => uploadsRepo.isCancelRequested(uploadId),
        });
      }
    } catch (err) {
      if (err instanceof DownloadCancelledError) throw new CancelledError();
      if (err instanceof TelegramFileError) {
        throw new PipelineError(err.message, `❌ Download failed.\n${esc(err.message)}`, err.retryable, {
          cause: err,
        });
      }
      throw err;
    }

    tempPath = downloaded.path;
    await uploadsRepo.patch(uploadId, {
      file_size: downloaded.bytes,
      bytes_downloaded: downloaded.bytes,
      // The staged copy has moved into the scratch directory. Recorded so a
      // retry looks where the file now is; before this, any failure after the
      // take deleted the only copy and the retry blamed the Bot API mount.
      ...(upload.local_source_path ? { local_source_path: downloaded.path } : {}),
    });
    if (upload.local_source_path) upload.local_source_path = downloaded.path;
    log.info({ bytes: downloaded.bytes }, 'Download complete');
    await checkCancel();

    // --- 3. Identify --------------------------------------------------------
    await uploadsRepo.setStatus(uploadId, 'PROCESSING');
    await onProgress(45);
    await reporter.setStage('IDENTIFYING');

    const probe = await probeFile(tempPath);
    if (probe && !probe.isVideo) {
      throw new PipelineError(
        'File contains no video stream',
        '❌ That file contains no video stream. Only video files are accepted.',
        false,
      );
    }

    await reporter.setStage('TMDB');
    const identification = await identify(upload.original_filename);
    log.info(
      {
        type: identification.type,
        title: identification.title,
        year: identification.year,
        season: identification.season,
        episode: identification.episode,
        source: identification.source,
        confidence: identification.confidence,
      },
      'Identified media',
    );

    await uploadsRepo.patch(uploadId, {
      media_type: identification.type,
      detected_title: identification.title,
      detected_year: identification.year,
      detected_season: identification.season,
      detected_episode: identification.episode,
    });

    // Identification too weak to file safely: park it, never delete it.
    if (identification.confidence < MIN_CONFIDENCE) {
      // Declining to guess is the system working, not failing. Recording it as
      // FAILED buried these among real failures and gave an administrator no
      // way to list what was actually waiting on them.
      const parked = await quarantine(tempPath, upload.safe_filename);
      tempPath = null;
      await uploadsRepo.patch(uploadId, { stored_path: parked });
      await uploadsRepo.setStatus(uploadId, 'NEEDS_REVIEW', {
        error_message:
          `Identification confidence ${identification.confidence.toFixed(2)} is below the ` +
          `${MIN_CONFIDENCE} threshold; parked for review rather than guessed at`,
        completed_at: new Date(),
        duration_ms: Date.now() - startedAt,
      });

      await reporter.setText(
        `\u{26A0}\u{FE0F} <b>Needs a closer look</b>\n\n` +
          `<code>${esc(upload.original_filename)}</code>\n\n` +
          `I could not confidently work out what this is, so I saved it for the administrator ` +
          `rather than filing it somewhere wrong. Nothing was deleted.\n\n` +
          `<i>Renaming it closer to its release title and sending it again usually works.</i>`,
      );

      await auditRepo.log({
        actor_type: 'system',
        action: 'upload.needs_review',
        entity_type: 'upload',
        entity_id: String(uploadId),
        detail: { confidence: identification.confidence, parked },
      });

      return { status: 'NEEDS_REVIEW' };
    }

    await onProgress(55);
    await checkCancel();

    // --- 4. Duplicate detection --------------------------------------------
    const checksum = await hashFile(tempPath);
    await uploadsRepo.patch(uploadId, { checksum_sha256: checksum });

    const duplicate = await mediaRepo.findDuplicate({
      user_id: user.id,
      type: identification.type,
      title: identification.title,
      year: identification.year,
      season: identification.season,
      episode: identification.episode,
      checksum,
    });

    // A media row whose file has since gone — removed outside the app, or by
    // Jellyfin — is not a duplicate of anything. Left in place it blocked the
    // title forever and threw away every re-upload with a false explanation.
    if (duplicate && !(await exists(duplicate.path))) {
      log.warn({ mediaId: duplicate.id, path: duplicate.path }, 'Duplicate match points at a missing file; dropping the stale record');
      await mediaRepo.remove(duplicate.id);
      await auditRepo.log({
        actor_type: 'system',
        action: 'media.stale_removed',
        entity_type: 'media',
        entity_id: String(duplicate.id),
        detail: { path: duplicate.path, replacedByUpload: uploadId },
      });
    } else if (duplicate) {
      await removeQuietly(tempPath);
      tempPath = null;
      await uploadsRepo.setStatus(uploadId, 'DUPLICATE', {
        completed_at: new Date(),
        duration_ms: Date.now() - startedAt,
        error_message: `Duplicate of media #${duplicate.id}`,
      });
      await reporter.setText(
        `⚠️ <b>This media already exists.</b>\n\n` +
          `<b>${esc(duplicate.title)}</b>${duplicate.year ? ` (${duplicate.year})` : ''}\n` +
          `<code>${esc(path.relative(config.storage.mediaRoot, duplicate.path))}</code>\n\n` +
          `Nothing was changed. The existing file was kept.`,
      );
      await auditRepo.log({
        actor_type: 'system',
        action: 'upload.duplicate',
        entity_type: 'upload',
        entity_id: String(uploadId),
        detail: { duplicateOf: duplicate.id },
      });
      return { status: 'DUPLICATE' };
    }

    await onProgress(65);
    await checkCancel();

    // --- 5. Organise --------------------------------------------------------
    await uploadsRepo.setStatus(uploadId, 'ORGANIZING');
    reporter.setTitle(
      `${identification.title}${identification.year ? ` (${identification.year})` : ''}`,
    );
    await reporter.setStage('ORGANIZING');

    await ensureUserDirectories(user);
    const placement = planPlacement(user, identification, upload.extension, upload.safe_filename);
    await ensureDir(placement.targetDir, placement.root);

    // Same title, different file: keep both rather than overwrite.
    let finalPath = placement.targetPath;
    for (let attempt = 0; attempt < 50 && (await exists(finalPath)); attempt += 1) {
      finalPath = withCollisionSuffix(placement.targetPath, attempt + 1);
    }
    if (await exists(finalPath)) {
      throw new PipelineError(
        'Could not find a free destination filename',
        '❌ Could not find a free filename in your library.',
        false,
      );
    }

    // The row first, then the move. The row's unique keys — one file per
    // path, one title per user — are the reservation: a second upload of the
    // same title running at the same moment fails here, before any file lands,
    // and its retry finds this row as a duplicate. Moved first, a failed
    // insert left a file in the library that nothing knew about.
    const stat = await fsp.stat(tempPath);
    const media = await mediaRepo.create({
      user_id: user.id,
      upload_id: uploadId,
      title: identification.title,
      original_title: identification.originalTitle,
      year: identification.year,
      type: identification.type,
      season: identification.season,
      episode: identification.episode,
      episode_title: identification.episodeTitle,
      path: finalPath,
      file_size: stat.size,
      checksum_sha256: checksum,
      tmdb_id: identification.tmdbId,
      overview: identification.overview,
      poster_path: identification.posterPath,
      jellyfin_item_id: null,
      jellyfin_verified: false,
    });

    try {
      await moveFile(tempPath, finalPath, placement.root);
    } catch (err) {
      // No file arrived, so the reservation is released; the temp file is
      // still where it was and the retry schedule applies to the move.
      await mediaRepo.remove(media.id).catch(() => {});
      throw err;
    }
    tempPath = null;
    await uploadsRepo.patch(uploadId, { stored_path: finalPath });
    log.info({ finalPath, mediaId: media.id }, 'Filed media');

    await onProgress(80);
    return finishFiled(ctx, media, startedAt, log, identification, stat.size);
  } catch (err) {
    // A partial download is worthless; a filed media file is not, and by this
    // point it is already recorded in `media`. A *staged* file — the only copy
    // of an assembled, fetched or directly uploaded file — is kept when the
    // failure will be retried, since the retry has nowhere else to get it;
    // the reaper removes it once the upload is terminal.
    if (tempPath) {
      const willRetry =
        !(err instanceof CancelledError) &&
        (err instanceof PipelineError ? err.retryable : classify(err).retryable);
      const staged = Boolean(upload.local_source_path) && tempPath === upload.local_source_path;
      if (!(staged && willRetry)) await removeQuietly(tempPath);
    }

    if (err instanceof CancelledError) {
      await uploadsRepo.setStatus(uploadId, 'CANCELLED', {
        completed_at: new Date(),
        duration_ms: Date.now() - startedAt,
        error_message: 'Cancelled by administrator',
      });
      await reporter.setText(
        `\u{1F6D1} <b>Upload cancelled</b>\n<code>${esc(upload.original_filename)}</code>`,
      );
      return { status: 'CANCELLED' };
    }
    throw err;
  }
}

/** What the Jellyfin step and the success message need to know about a title. */
type Titled = Pick<Identification, 'type' | 'title' | 'year' | 'season' | 'episode' | 'episodeTitle' | 'source'>;

/** The same description, recovered from a media row when no fresh identification exists. */
function titledFrom(media: MediaRow): Titled {
  return {
    type: media.type,
    title: media.title,
    year: media.year,
    season: media.season,
    episode: media.episode,
    episodeTitle: media.episode_title,
    source: media.tmdb_id ? 'tmdb' : 'filename',
  };
}

/**
 * Steps 6 and 7: make the filed media visible in Jellyfin and mark the upload
 * done. Shared by the ordinary run and by a resumed one, so a restart between
 * the move and the finish neither repeats the download nor skips the scan.
 */
async function finishFiled(
  ctx: Context,
  media: MediaRow,
  startedAt: number,
  log: ReturnType<typeof getLogger>,
  identification: Titled = titledFrom(media),
  size: number = Number(media.file_size),
): Promise<PipelineOutcome> {
  const { upload, user, reporter } = ctx;
  const relativePath = path.relative(config.storage.mediaRoot, media.path);

  reporter.setTitle(`${identification.title}${identification.year ? ` (${identification.year})` : ''}`);
  await reporter.setStage('JELLYFIN_SCAN');

  // --- 6. Jellyfin ----------------------------------------------------------
  await uploadsRepo.setStatus(upload.id, 'JELLYFIN_SCAN');
  await reporter.setText(
    `\u{1F4FA} <b>Adding to Jellyfin</b>\n<code>${esc(identification.title)}</code>\n\nScanning library…`,
  );

  const jellyfinNote = await addToJellyfin(ctx, media.id, media.path, identification);

  // --- 7. Done --------------------------------------------------------------
  const durationMs = Date.now() - startedAt;
  await uploadsRepo.setStatus(upload.id, 'COMPLETED', {
    completed_at: new Date(),
    duration_ms: durationMs,
  });

  await reporter.setText(renderSuccess(user, identification, relativePath, size, durationMs, jellyfinNote));

  await auditRepo.log({
    actor_type: 'system',
    action: 'upload.completed',
    entity_type: 'upload',
    entity_id: String(upload.id),
    detail: {
      mediaId: media.id,
      type: identification.type,
      title: identification.title,
      durationMs,
    },
  });

  log.info({ mediaId: media.id, durationMs }, 'Upload completed');
  return { status: 'COMPLETED', mediaId: media.id, path: media.path };
}

/**
 * Make the new file visible in Jellyfin and confirm that it actually is.
 *
 * A targeted library refresh is used where possible; a full `/Library/Refresh`
 * is the fallback. Jellyfin is never restarted.
 */
async function addToJellyfin(
  ctx: Context,
  mediaId: number,
  filePath: string,
  identification: Pick<Identification, 'type' | 'title'>,
): Promise<string> {
  const log = getLogger().child({ uploadId: ctx.upload.id });

  if (!config.jellyfin.configured) {
    return 'Jellyfin API key not configured — scan not triggered.';
  }

  try {
    const libraries = await librariesRepo.listForUser(ctx.user.id);
    const library = libraries.find((l) => l.media_type === identification.type);

    await jf.requestScan(library?.jellyfin_item_id ?? null);

    if (!ctx.user.jellyfin_user_id) {
      return 'Added to disk. Link a Jellyfin account to verify visibility.';
    }

    await ctx.reporter.setStage('JELLYFIN_VERIFY');

    // Poll until Jellyfin reports the item, so "added to Jellyfin" is a fact
    // rather than a hope.
    const deadline = Date.now() + config.jellyfin.verifyTimeoutSec * 1000;
    while (Date.now() < deadline) {
      const item = await jf.findItemByPath(ctx.user.jellyfin_user_id, filePath, identification.title);
      if (item) {
        await mediaRepo.setJellyfinItem(mediaId, item.id, true);
        log.info({ jellyfinItemId: item.id }, 'Verified in Jellyfin');
        return 'Verified visible in Jellyfin.';
      }
      await new Promise((r) => setTimeout(r, config.jellyfin.verifyIntervalSec * 1000));
    }

    log.warn({ filePath }, 'Jellyfin did not surface the item before the timeout');
    return 'Saved. Jellyfin has not indexed it yet — it will appear after the next scan.';
  } catch (err) {
    // Jellyfin problems must not lose a file that is already correctly filed.
    log.warn({ err }, 'Jellyfin integration step failed');
    return `Saved to disk, but the Jellyfin scan failed: ${(err as Error).message}`;
  }
}

function renderSuccess(
  user: UserRow,
  id: Titled,
  relativePath: string,
  size: number,
  durationMs: number,
  jellyfinNote: string,
): string {
  const heading =
    id.type === 'movie'
      ? `\u{1F3AC} <b>${esc(id.title)}</b>${id.year ? ` (${id.year})` : ''}`
      : `\u{1F4FA} <b>${esc(id.title)}</b> — S${String(id.season ?? 0).padStart(2, '0')}E${String(
          id.episode ?? 0,
        ).padStart(2, '0')}${id.episodeTitle ? `\n<i>${esc(id.episodeTitle)}</i>` : ''}`;

  return (
    `✅ <b>Upload complete!</b>\n\n` +
    `${heading}\n\n` +
    `\u{1F464} ${esc(user.name)}\n` +
    `\u{1F4C1} <code>${esc(relativePath)}</code>\n` +
    `\u{1F4BE} ${formatBytes(size)} • ${Math.round(durationMs / 1000)}s\n` +
    `\u{1F50E} Identified via ${id.source === 'tmdb' ? 'TMDB' : 'filename'}\n\n` +
    `${esc(jellyfinNote)}`
  );
}
