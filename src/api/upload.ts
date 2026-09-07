import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from '../config/index.js';
import { getLogger } from '../lib/logger.js';
import { verifyInitData } from '../lib/telegram-initdata.js';
import { checkLoginAllowed, recordLoginFailure, recordLoginSuccess } from './auth.js';
import { extensionOf, safeJoin, sanitizeFilename } from '../lib/paths.js';
import {
  auditRepo,
  jobsRepo,
  partsRepo,
  sessionsRepo,
  uploadTokensRepo,
  uploadsRepo,
  usersRepo,
} from '../db/repositories.js';
import type { UserRow } from '../db/types.js';
import { checkQuota } from '../services/quota.js';
import { checkSpaceFor, ensureDir, removeQuietly } from '../services/storage.js';
import { ensureSessionDir, partPath } from '../services/assembly.js';
import { beginAssembly, cancelSession } from '../worker/multipart.js';
import { missingParts } from '../services/multipart.js';

/**
 * Ingest API for the local uploader client.
 *
 * The uploader sends bytes straight to this server rather than through
 * Telegram, so it is not bound by Telegram's per-file ceiling. What it feeds
 * into is unchanged: a small file becomes an ordinary `uploads` row, a large
 * one becomes the same `upload_sessions` / `upload_parts` records the Telegram
 * multi-part flow uses, and both end up in the existing pipeline.
 *
 * Mounted before the JSON body parser so request bodies stream to disk rather
 * than being buffered.
 */

export const uploadRouter = Router();

declare module 'express-serve-static-core' {
  interface Request {
    uploadUser?: UserRow;
  }
}

function h(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

/**
 * The filename a header carried.
 *
 * HTTP headers are bytes, not text: a browser refuses to set one containing
 * anything above U+00FF, so an Amharic or Cyrillic title could not be uploaded
 * from the Mini App at all, and the CLI percent-encodes such names — which
 * were then stored encoded and filed under a title like `%D0%A4%D0%B8`. The
 * header is therefore defined as percent-encoded, and decoded here; a name
 * that was never encoded decodes to itself.
 */
function filenameFromHeader(req: Request): string {
  const raw = String(req.get('x-upload-filename') ?? '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** A positive safe integer, or null: ids come from the URL and NaN would reach a bigint column as a 500. */
function idParam(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Authenticate a media user, by either credential they can hold.
 *
 * Deliberately separate from the admin session: whichever credential is
 * presented, it belongs to a media user and can do nothing but add media to
 * that user's own library. Every route below then constrains itself to
 * `req.uploadUser.id`, so *this* function is the only place identity is
 * decided and the routes need not care which way it was established.
 *
 * Two forms are accepted:
 *
 *   Authorization: Bearer <upload token>   the command-line uploader
 *   Authorization: tma <initData>          the Telegram Mini App
 *
 * The second was added so the Mini App could reuse this ingest pipeline whole
 * — planning, resumable multi-part, quota, disk checks, deduplication — rather
 * than growing a second implementation of the same thing beside it. The token
 * path is untouched: an `Authorization` header that does not begin with `tma `
 * takes exactly the branch it always did.
 */
async function resolveUploadUser(req: Request): Promise<
  | { ok: true; user: UserRow }
  | { ok: false; status: number; error: string; countsAsAttempt: boolean }
> {
  const header = req.get('authorization') ?? '';

  if (header.startsWith('tma ')) {
    if (!config.miniapp.enabled) {
      return { ok: false, status: 503, error: 'The Mini App is disabled', countsAsAttempt: false };
    }
    const verified = verifyInitData(header.slice(4).trim(), config.telegram.botToken, {
      maxAgeSec: config.miniapp.maxAgeSec,
      futureSkewSec: 300,
    });
    if (!verified.ok) {
      getLogger().warn({ ip: req.ip, reason: verified.reason }, 'Rejected upload with invalid Mini App credential');
      return {
        ok: false,
        status: 401,
        error: verified.reason === 'expired' ? 'This session has expired' : 'Invalid Mini App credential',
        // An expired credential is the ordinary end of a session, not a guess.
        countsAsAttempt: verified.reason !== 'expired' && verified.reason !== 'missing',
      };
    }
    const user = await usersRepo.byTelegramChatId(verified.user.id);
    if (!user) {
      getLogger().warn({ telegramChatId: verified.user.id }, 'Upload attempted by an unregistered Telegram account');
      return {
        ok: false,
        status: 403,
        error: 'This Telegram account is not registered',
        countsAsAttempt: false,
      };
    }
    return { ok: true, user };
  }

  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    return { ok: false, status: 401, error: 'An upload token is required', countsAsAttempt: false };
  }

  const user = await uploadTokensRepo.authenticate(token);
  if (!user) {
    getLogger().warn({ ip: req.ip }, 'Rejected upload with an unknown token');
    return { ok: false, status: 401, error: 'Invalid upload token', countsAsAttempt: true };
  }
  return { ok: true, user };
}

/**
 * Answer a rejected upload without tearing down the connection first.
 *
 * On PUT /single and PUT /part the request body *is* the file, still
 * arriving. Responding without draining it aborts the socket mid-transfer, so
 * the client sees a dropped connection rather than the 401 explaining that its
 * session expired — the same discipline the part-already-received
 * short-circuit already applies.
 */
function rejectUpload(req: Request, res: Response, status: number, error: string): void {
  req.resume();
  res.status(status).json({ error });
}

async function requireUploadToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  // This endpoint accepts a bearer token from the open internet, so a wrong one
  // is throttled exactly as a wrong password is. The credential is checked
  // before the throttle is consulted, so a working uploader is never turned
  // away for someone else's guessing.
  const limiterKey = `upload:${req.ip ?? 'unknown'}`;
  const resolved = await resolveUploadUser(req);
  if (!resolved.ok) {
    if (resolved.countsAsAttempt) {
      const gate = checkLoginAllowed(limiterKey);
      if (!gate.allowed) {
        // Answered without draining the body: a client that has spent its
        // budget on wrong credentials has not earned the bandwidth, and the
        // courtesy exists for uploads that were going to be accepted.
        res.setHeader('Retry-After', String(gate.retryAfterSec));
        res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
        return;
      }
      recordLoginFailure(limiterKey);
    }
    rejectUpload(req, res, resolved.status, resolved.error);
    return;
  }
  recordLoginSuccess(limiterKey);

  const user = resolved.user;
  // Applied to both credentials: a deactivated account cannot upload however
  // it authenticated.
  if (!user.active) {
    rejectUpload(req, res, 403, 'This account is deactivated');
    return;
  }
  if (!user.upload_enabled) {
    rejectUpload(req, res, 403, 'Uploading is disabled for this account');
    return;
  }

  req.uploadUser = user;
  next();
}

uploadRouter.use(requireUploadToken);

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export type UploadMode = 'single' | 'multipart' | 'reject';

export interface UploadPlan {
  mode: UploadMode;
  fileSize: number;
  partCount: number;
  partSize: number;
  reason?: string;
}

/**
 * Decide how a file of `size` should be sent, from its size alone.
 *
 * At or below the single-upload ceiling it goes whole; above it, in parts;
 * above the assembled ceiling it is refused outright. The uploader asks for
 * this before reading a byte, so the decision is made on the original file.
 */
export function planUpload(size: number): UploadPlan {
  const partSize = Math.min(config.upload.partBytes, config.upload.partMaxBytes);

  if (!Number.isFinite(size) || size <= 0) {
    return { mode: 'reject', fileSize: size, partCount: 0, partSize, reason: 'The file is empty.' };
  }

  if (size > config.multipart.maxAssembledBytes) {
    return {
      mode: 'reject',
      fileSize: size,
      partCount: 0,
      partSize,
      reason: `The file is larger than the ${config.multipart.maxAssembledBytes} byte maximum.`,
    };
  }

  if (size <= config.upload.singleMaxBytes) {
    return { mode: 'single', fileSize: size, partCount: 1, partSize: size };
  }

  const partCount = Math.ceil(size / partSize);
  if (partCount > config.multipart.maxParts) {
    return {
      mode: 'reject',
      fileSize: size,
      partCount,
      partSize,
      reason: `The file would need ${partCount} parts, above the ${config.multipart.maxParts} limit.`,
    };
  }

  return { mode: 'multipart', fileSize: size, partCount, partSize };
}

/** Reject a filename the pipeline could not process anyway. */
function validateFilename(filename: string): { ok: true; extension: string } | { ok: false; error: string } {
  const extension = extensionOf(filename);
  if (!extension) return { ok: false, error: 'The filename has no extension.' };
  if (!config.storage.allowedExtensions.includes(extension)) {
    return {
      ok: false,
      error: `Unsupported file type (.${extension}). Accepted: ${config.storage.allowedExtensions.join(', ')}.`,
    };
  }
  return { ok: true, extension };
}

/**
 * Stream a request body to disk, refusing anything longer than `maxBytes`.
 *
 * The body is never buffered, so a 2 GiB part costs the same memory as a small
 * one, and an over-long body is cut off rather than filling the disk.
 */
async function streamToFile(
  req: Request,
  destination: string,
  maxBytes: number,
): Promise<{ bytes: number; sha256: string }> {
  const hash = crypto.createHash('sha256');
  let bytes = 0;

  const sink = fs.createWriteStream(destination, { mode: config.storage.fileMode });

  try {
    await pipeline(
      req,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            throw new Error(`Body exceeds the ${maxBytes} byte limit`);
          }
          hash.update(chunk);
          yield chunk;
        }
      },
      sink,
    );
  } catch (err) {
    sink.destroy();
    await removeQuietly(destination);
    throw err;
  }

  return { bytes, sha256: hash.digest('hex') };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Identity and limits, so the uploader can validate its token and configure itself. */
uploadRouter.get(
  '/hello',
  h(async (req, res) => {
    const user = req.uploadUser!;
    res.json({
      user: { id: user.id, name: user.name },
      limits: {
        singleMaxBytes: config.upload.singleMaxBytes,
        maxAssembledBytes: config.multipart.maxAssembledBytes,
        partBytes: Math.min(config.upload.partBytes, config.upload.partMaxBytes),
        partMaxBytes: config.upload.partMaxBytes,
        maxParts: config.multipart.maxParts,
        allowedExtensions: config.storage.allowedExtensions,
      },
    });
  }),
);

const beginSchema = z.object({
  filename: z.string().min(1).max(500),
  size: z.coerce.number().int().positive(),
});

/**
 * Decide the mode for a file and, for a large one, open the session.
 *
 * Returning an existing open session here is what makes the uploader
 * resumable: a re-run of the same file rejoins rather than starting again.
 */
uploadRouter.post(
  '/begin',
  h(async (req, res) => {
    const user = req.uploadUser!;

    // The body is small JSON, read manually because this router runs before
    // the global JSON parser.
    const raw = await readJsonBody(req).catch(() => null);
    const parsed = beginSchema.safeParse(raw);
    if (!parsed.success) {
      return void res.status(422).json({ error: 'filename and size are required' });
    }

    const { filename, size } = parsed.data;
    const valid = validateFilename(filename);
    if (!valid.ok) return void res.status(422).json({ error: valid.error });

    const plan = planUpload(size);
    if (plan.mode === 'reject') {
      return void res.status(413).json({ error: plan.reason, plan });
    }

    // Room for the pieces and the assembled result side by side.
    // Quota is charged before anything expensive begins, so a user over
    // their limit learns immediately rather than after a long transfer.
    const quota = await checkQuota(user, size);
    if (!quota.ok) {
      return void res.status(413).json({
        error: quota.reason ?? 'Storage quota exceeded',
        quota: {
          quotaBytes: quota.status.quotaBytes,
          usedBytes: quota.status.usedBytes,
          reservedBytes: quota.status.reservedBytes,
          remainingBytes: quota.status.remainingBytes,
        },
      });
    }

    const space = await checkSpaceFor(plan.mode === 'multipart' ? size * 2 : size);
    if (!space.ok) {
      return void res.status(507).json({ error: `Not enough server storage. ${space.reason ?? ''}` });
    }

    if (plan.mode === 'single') {
      return void res.json({ mode: 'single', plan });
    }

    const safeBase = sanitizeFilename(filename, `upload-${Date.now()}`);

    // An open session for this name is rejoined only if it is the same file.
    // A same-named file of a different size — re-downloaded, re-encoded — is
    // a different file: rejoining used to either refuse every part beyond the
    // old total or, worse, assemble the new parts with stale ones.
    const open = await sessionsRepo.findOpen(user.id, safeBase);
    if (
      open &&
      ((open.expected_bytes !== null && open.expected_bytes !== size) ||
        (open.expected_parts !== null && open.expected_parts !== plan.partCount))
    ) {
      if (open.status === 'COLLECTING' || open.status === 'READY') {
        await cancelSession(open.id, 'Replaced by a new upload of the same name with a different size');
      } else {
        return void res.status(409).json({
          error: `A different file with this name is still being processed (session ${open.id}). Wait for it to finish, or rename this one.`,
        });
      }
    }

    const session = await sessionsRepo.findOrCreate({
      user_id: user.id,
      telegram_chat_id: user.telegram_chat_id,
      base_filename: filename,
      safe_base_filename: safeBase,
      extension: valid.extension,
      expected_parts: plan.partCount,
      expected_bytes: size,
      source: 'direct',
    });

    const received = await partsRepo.readyNumbers(session.id);

    getLogger().info(
      { sessionId: session.id, userId: user.id, size, parts: plan.partCount, resumed: received.length },
      'Direct multi-part upload begun',
    );

    res.json({
      mode: 'multipart',
      plan,
      sessionId: session.id,
      receivedParts: received,
      missingParts: missingParts(received, plan.partCount),
    });
  }),
);

/** Stream a whole file that fits under the single-upload ceiling. */
uploadRouter.put(
  '/single',
  h(async (req, res) => {
    const user = req.uploadUser!;

    const filename = filenameFromHeader(req);
    const declared = Number(req.get('x-upload-size') ?? '0');

    const valid = validateFilename(filename);
    if (!valid.ok) return void res.status(422).json({ error: valid.error });

    const plan = planUpload(declared);
    if (plan.mode !== 'single') {
      return void res.status(413).json({
        error:
          plan.mode === 'reject'
            ? plan.reason
            : 'This file is above the single-upload ceiling; use the multi-part flow.',
        plan,
      });
    }

    // Quota is charged before anything expensive begins, so a user over
    // their limit learns immediately rather than after a long transfer.
    const quota = await checkQuota(user, declared);
    if (!quota.ok) {
      return void res.status(413).json({
        error: quota.reason ?? 'Storage quota exceeded',
        quota: {
          quotaBytes: quota.status.quotaBytes,
          usedBytes: quota.status.usedBytes,
          reservedBytes: quota.status.reservedBytes,
          remainingBytes: quota.status.remainingBytes,
        },
      });
    }

    const space = await checkSpaceFor(declared);
    if (!space.ok) {
      return void res.status(507).json({ error: `Not enough server storage. ${space.reason ?? ''}` });
    }

    await ensureDir(config.storage.downloadTmpDir, config.storage.mediaRoot);
    const safeName = sanitizeFilename(filename, `upload-${Date.now()}`);
    const destination = safeJoin(
      config.storage.downloadTmpDir,
      `direct-${user.id}-${Date.now()}-${safeName}`,
    );

    let written;
    try {
      written = await streamToFile(req, destination, config.upload.singleMaxBytes);
    } catch (err) {
      return void res.status(400).json({ error: `Upload failed: ${(err as Error).message}` });
    }

    if (declared > 0 && written.bytes !== declared) {
      await removeQuietly(destination);
      return void res
        .status(400)
        .json({ error: `Incomplete upload: expected ${declared} bytes, received ${written.bytes}` });
    }

    const upload = await uploadsRepo.createDirect({
      user_id: user.id,
      telegram_chat_id: user.telegram_chat_id,
      original_filename: filename,
      safe_filename: safeName,
      extension: valid.extension,
      file_size: written.bytes,
      local_source_path: destination,
    });

    await jobsRepo.enqueue({
      type: 'process-upload',
      upload_id: upload.id,
      max_attempts: config.worker.maxAttempts,
    });

    await auditRepo.log({
      actor_type: 'system',
      action: 'upload.direct.single',
      entity_type: 'upload',
      entity_id: String(upload.id),
      detail: { userId: user.id, filename, bytes: written.bytes },
      ip_address: req.ip ?? null,
    });

    getLogger().info(
      { uploadId: upload.id, userId: user.id, bytes: written.bytes },
      'Direct single upload accepted',
    );

    res.status(201).json({ uploadId: upload.id, bytes: written.bytes, sha256: written.sha256 });
  }),
);

/**
 * Stream one part of a large file.
 *
 * A part that is already present is accepted as a no-op so a resumed or
 * retried upload never has to re-send bytes the server already holds.
 */
uploadRouter.put(
  '/part/:sessionId/:partNumber',
  h(async (req, res) => {
    const user = req.uploadUser!;
    const sessionId = Number(req.params['sessionId']);
    const partNumber = Number(req.params['partNumber']);

    if (!Number.isInteger(sessionId) || !Number.isInteger(partNumber) || partNumber < 1) {
      return void res.status(400).json({ error: 'Invalid session or part number' });
    }

    const session = await sessionsRepo.byId(sessionId);
    if (!session || session.user_id !== user.id) {
      // Not disclosing whether another user's session exists.
      return void res.status(404).json({ error: 'Session not found' });
    }
    if (session.status !== 'COLLECTING') {
      return void res
        .status(409)
        .json({ error: `Session is ${session.status} and no longer accepting parts` });
    }
    if (session.expected_parts !== null && partNumber > session.expected_parts) {
      return void res
        .status(400)
        .json({ error: `Part ${partNumber} is beyond the declared total of ${session.expected_parts}` });
    }

    const existing = await partsRepo.byNumber(sessionId, partNumber);
    if (existing?.status === 'READY') {
      // Already held; let the client move on without resending.
      req.resume();
      return void res.status(200).json({ ok: true, alreadyPresent: true, bytes: existing.file_size });
    }

    const declared = Number(req.get('x-upload-size') ?? '0');
    const space = await checkSpaceFor(declared || config.upload.partMaxBytes);
    if (!space.ok) {
      return void res.status(507).json({ error: `Not enough server storage. ${space.reason ?? ''}` });
    }

    await ensureSessionDir(sessionId);
    const destination = partPath(sessionId, partNumber);

    // Recorded as PENDING before a byte arrives, so the idle sweep can see a
    // part in flight: it counts nothing but finished parts otherwise, and a
    // slow gigabyte used to get its session expired — and its directory
    // deleted — underneath the open stream.
    const { part } = await partsRepo.upsert({
      session_id: sessionId,
      part_number: partNumber,
      original_filename: `${session.base_filename}.part${partNumber}`,
      telegram_file_id: null,
      telegram_file_unique_id: null,
      telegram_message_id: null,
      file_size: declared,
    });

    // Streamed into a name of this request's own and renamed into place once
    // it is whole. Two requests for the same part number — a retry after a
    // dropped connection, with the first still draining server-side — used to
    // share one path, and the loser's cleanup unlinked the winner's finished
    // part.
    const inflight = `${destination}.${crypto.randomUUID()}.tmp`;
    let written;
    try {
      written = await streamToFile(req, inflight, config.upload.partMaxBytes);
    } catch (err) {
      await partsRepo.setStatus(part.id, 'FAILED', { error_message: (err as Error).message.slice(0, 500) });
      return void res.status(400).json({ error: `Part upload failed: ${(err as Error).message}` });
    }

    if (declared > 0 && written.bytes !== declared) {
      await removeQuietly(inflight);
      await partsRepo.setStatus(part.id, 'FAILED', {
        error_message: `Incomplete part: expected ${declared} bytes, received ${written.bytes}`,
      });
      return void res
        .status(400)
        .json({ error: `Incomplete part: expected ${declared} bytes, received ${written.bytes}` });
    }

    await fsp.rename(inflight, destination);

    // The bytes are already here, so the part is READY on arrival: no
    // download job, unlike a part that came in through Telegram.
    await partsRepo.setStatus(part.id, 'READY', {
      stored_path: destination,
      checksum_sha256: written.sha256,
      file_size: written.bytes,
      completed_at: new Date(),
    });

    const refreshed = await sessionsRepo.refreshCounters(sessionId);
    const received = await partsRepo.readyNumbers(sessionId);

    getLogger().info(
      { sessionId, partNumber, bytes: written.bytes, received: received.length },
      'Direct part received',
    );

    res.status(201).json({
      ok: true,
      bytes: written.bytes,
      sha256: written.sha256,
      receivedParts: received,
      missingParts: missingParts(received, refreshed?.expected_parts ?? session.expected_parts),
    });
  }),
);

/** Tell the server every part has been sent. */
uploadRouter.post(
  '/complete/:sessionId',
  h(async (req, res) => {
    const user = req.uploadUser!;
    const sessionId = Number(req.params['sessionId']);

    const session = await sessionsRepo.byId(sessionId);
    if (!session || session.user_id !== user.id) {
      return void res.status(404).json({ error: 'Session not found' });
    }
    if (session.status !== 'COLLECTING') {
      return void res.json({ ok: true, status: session.status, alreadyFinalised: true });
    }

    const received = await partsRepo.readyNumbers(sessionId);
    const missing = missingParts(received, session.expected_parts);
    if (missing.length > 0) {
      return void res.status(409).json({ error: 'Parts are still missing', missingParts: missing });
    }

    try {
      await beginAssembly(session);
    } catch (err) {
      return void res.status(409).json({ error: (err as Error).message });
    }

    await auditRepo.log({
      actor_type: 'system',
      action: 'upload.direct.completed',
      entity_type: 'session',
      entity_id: String(sessionId),
      detail: { userId: user.id, parts: received.length },
      ip_address: req.ip ?? null,
    });

    res.json({ ok: true, sessionId, parts: received.length });
  }),
);

/** Session progress, used for resuming and for the uploader's final wait. */
uploadRouter.get(
  '/session/:sessionId',
  h(async (req, res) => {
    const user = req.uploadUser!;
    const sessionId = idParam(req.params['sessionId']);
    const session = sessionId === null ? null : await sessionsRepo.byId(sessionId);
    if (!session || session.user_id !== user.id) {
      return void res.status(404).json({ error: 'Session not found' });
    }

    const received = await partsRepo.readyNumbers(session.id);
    const upload = session.upload_id ? await uploadsRepo.byId(session.upload_id) : null;

    res.json({
      sessionId: session.id,
      status: session.status,
      expectedParts: session.expected_parts,
      receivedParts: received,
      missingParts: missingParts(received, session.expected_parts),
      receivedBytes: session.received_bytes,
      assembledSize: session.assembled_size,
      assembledSha256: session.assembled_sha256,
      errorMessage: session.error_message,
      upload: upload
        ? { id: upload.id, status: upload.status, detectedTitle: upload.detected_title, error: upload.error_message }
        : null,
    });
  }),
);

/** Progress of a single (non-part) upload, so the uploader can report the outcome. */
uploadRouter.get(
  '/upload/:uploadId',
  h(async (req, res) => {
    const user = req.uploadUser!;
    const uploadId = idParam(req.params['uploadId']);
    const upload = uploadId === null ? null : await uploadsRepo.byId(uploadId);
    if (!upload || upload.user_id !== user.id) {
      return void res.status(404).json({ error: 'Upload not found' });
    }
    res.json({
      id: upload.id,
      status: upload.status,
      detectedTitle: upload.detected_title,
      mediaType: upload.media_type,
      error: upload.error_message,
      bytes: upload.file_size,
    });
  }),
);

uploadRouter.post(
  '/cancel/:sessionId',
  h(async (req, res) => {
    const user = req.uploadUser!;
    const sessionId = idParam(req.params['sessionId']);
    const session = sessionId === null ? null : await sessionsRepo.byId(sessionId);
    if (!session || session.user_id !== user.id) {
      return void res.status(404).json({ error: 'Session not found' });
    }
    // A session nobody is working on is ended here and now — parts removed,
    // sender told. Only one mid-assembly needs the cooperative flag, which the
    // assembler honours at its next checkpoint. Setting the flag alone left a
    // "cancelled" COLLECTING session accepting parts and holding disk until it
    // idled out.
    if (session.status === 'COLLECTING' || session.status === 'READY') {
      await cancelSession(session.id, 'Cancelled by the uploader');
      return void res.json({ ok: true, status: 'CANCELLED' });
    }
    await sessionsRepo.requestCancel(session.id);
    res.json({ ok: true, status: session.status });
  }),
);

uploadRouter.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

/** Read a small JSON body without the global parser, which is not mounted here. */
async function readJsonBody(req: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) throw new Error('Body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Directory the ingest routes write into; created at startup. */
export async function ensureUploadDirs(): Promise<void> {
  await fsp.mkdir(config.storage.downloadTmpDir, { recursive: true, mode: config.storage.dirMode });
  await fsp.mkdir(config.multipart.partsDir, { recursive: true, mode: config.storage.dirMode });
}
