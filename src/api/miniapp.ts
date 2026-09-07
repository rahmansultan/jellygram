import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from '../config/index.js';
import { getLogger } from '../lib/logger.js';
import { verifyInitData, type InitDataUser } from '../lib/telegram-initdata.js';
import { checkLoginAllowed, recordLoginFailure, recordLoginSuccess } from './auth.js';
import {
  auditRepo,
  jobsRepo,
  librariesRepo,
  mediaRepo,
  uploadsRepo,
  usersRepo,
} from '../db/repositories.js';
import { quotaStatus } from '../services/quota.js';
import { announceCancelled } from '../services/notifier.js';
import { ERROR_CODES, RULES, type ErrorCode } from '../lib/errors.js';
import type { MediaRow, UploadRow, UserRow } from '../db/types.js';

/**
 * The Telegram Mini App's API.
 *
 * A second *interface*, not a second system: every query here runs through the
 * same repositories the dashboard and the worker use, and every upload goes
 * through the existing ingest router. What is genuinely new is only the way a
 * caller proves who they are.
 *
 * The rule that shapes every handler below: the client never names a user. It
 * cannot pass a userId, a Telegram id or a Jellyfin username and have any of
 * them believed. The identity comes from a signature Telegram produced, and
 * every query is then constrained to that identity server-side.
 */

export const miniappRouter = Router();

declare module 'express-serve-static-core' {
  interface Request {
    miniUser?: UserRow;
    miniTelegram?: InitDataUser;
  }
}

function h(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

/**
 * One gate for every `:id` in this router.
 *
 * The same guard the admin API carries, and for the same reason: `Number('abc')`
 * is NaN and `Number('9999999999999999999')` is an integer far outside a
 * PostgreSQL bigint, so without this a mistyped URL reaches a query and comes
 * back as a 500 — the client's mistake reported as the server's fault, and an
 * incident in the log that is not one.
 */
miniappRouter.param('id', (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: 'Invalid id', code: 'BAD_ID' });
    return;
  }
  next();
});

/**
 * Extract the signed blob a Mini App request carries.
 *
 * `Authorization: tma <initData>` is Telegram's own convention. A header is
 * used rather than a cookie deliberately: a cookie would be attached by the
 * browser to cross-site requests and would need CSRF defences, whereas a
 * custom header cannot be set cross-origin without the server's own CORS
 * permission, which is never granted. That is why this router has no CSRF
 * token and does not need one.
 */
function credentialFrom(req: Request): string | null {
  const header = req.get('authorization') ?? '';
  if (header.startsWith('tma ')) return header.slice(4).trim();
  return null;
}

/** Why a request was refused, in a form the app can act on. */
const REJECTION: Record<string, { status: number; error: string; code: string }> = {
  missing: { status: 401, code: 'NO_INIT_DATA', error: 'Open this from inside Telegram.' },
  malformed: { status: 401, code: 'BAD_INIT_DATA', error: 'That sign-in data could not be read.' },
  'missing-hash': { status: 401, code: 'BAD_INIT_DATA', error: 'That sign-in data is not signed.' },
  'bad-signature': { status: 401, code: 'BAD_INIT_DATA', error: 'That sign-in data is not valid.' },
  'missing-auth-date': { status: 401, code: 'BAD_INIT_DATA', error: 'That sign-in data is not valid.' },
  expired: { status: 401, code: 'EXPIRED', error: 'This session has expired. Close and reopen the app.' },
  'future-dated': { status: 401, code: 'BAD_INIT_DATA', error: 'That sign-in data is not valid.' },
  'missing-user': { status: 401, code: 'BAD_INIT_DATA', error: 'That sign-in data names no user.' },
  'bot-not-configured': { status: 503, code: 'UNAVAILABLE', error: 'This app is not configured yet.' },
};

/**
 * Establish who is calling, from the signature alone.
 *
 * Deliberately re-verified on every request rather than exchanged once for a
 * session of our own: it keeps the credential's lifetime Telegram's business,
 * adds no table to expire and purge, and means a revoked or deactivated user
 * loses access on their very next request rather than whenever a session we
 * minted happened to run out.
 */
let signingConventionLogged = false;

async function requireMiniAppUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!config.miniapp.enabled) {
    res.status(503).json({ error: 'The Mini App is disabled.', code: 'DISABLED' });
    return;
  }

  // The signature is checked before the rate limiter, not after. Verifying is
  // a single HMAC — cheaper than the map lookup it would be gated by — and
  // checking first means a valid credential can never be refused for someone
  // else's behaviour. That matters once the app is reachable from the open
  // internet: every request then arrives from the proxy, so a limiter consulted
  // first would let eight junk requests from any passing scanner lock the real
  // owner out for fifteen minutes. Throttling still applies to failures, which
  // is all a guesser can produce.
  const limiterKey = `miniapp:${req.ip ?? 'unknown'}`;

  const credential = credentialFrom(req);
  const verified = verifyInitData(credential, config.telegram.botToken, {
    maxAgeSec: config.miniapp.maxAgeSec,
    futureSkewSec: 300,
  });

  if (!verified.ok) {
    // Two things are not attacks and must not consume the attempt budget.
    // "Missing" is what an ordinary browser produces by visiting the URL; and
    // "expired" is the normal end of a credential's life — counting it would
    // let an app left open overnight lock its own owner out.
    const benign = verified.reason === 'missing'
      || verified.reason === 'expired'
      || verified.reason === 'bot-not-configured';
    if (!benign) {
      const gate = checkLoginAllowed(limiterKey);
      if (!gate.allowed) {
        res.setHeader('Retry-After', String(gate.retryAfterSec));
        res.status(429).json({ error: 'Too many attempts. Try again shortly.', code: 'RATE_LIMITED' });
        return;
      }
      recordLoginFailure(limiterKey);
      getLogger().warn({ ip: req.ip, reason: verified.reason }, 'Mini App credential rejected');
    } else {
      // A benign rejection is not an attack, but it is the only trace left when
      // a client is not sending what it should — and "the app says reopen it"
      // is otherwise indistinguishable from "the app never sent anything".
      // The reason and the size of the credential, never its content.
      getLogger().info(
        { reason: verified.reason, credentialBytes: credential?.length ?? 0 },
        'Mini App credential not accepted',
      );
    }
    const rejection = REJECTION[verified.reason] ?? REJECTION['malformed']!;
    res.status(rejection.status).json({ error: rejection.error, code: rejection.code });
    return;
  }

  // The signature proves which Telegram account opened the app. Whether that
  // account is allowed here is a separate question, answered only by the
  // existing users table — there is no second account system to fall back on.
  const user = await usersRepo.byTelegramChatId(verified.user.id);
  if (!user) {
    getLogger().warn({ telegramChatId: verified.user.id }, 'Mini App opened by an unregistered Telegram account');
    res.status(403).json({
      error: 'This Telegram account is not registered. Ask the administrator to add you.',
      code: 'NOT_REGISTERED',
    });
    return;
  }
  if (!user.active) {
    res.status(403).json({ error: 'This account is deactivated.', code: 'DEACTIVATED' });
    return;
  }

  // Said once per process, because the answer is a property of the Telegram
  // clients in use rather than of any one request, and it is the only record of
  // which of the two signing conventions the real world turned out to use.
  if (!signingConventionLogged) {
    signingConventionLogged = true;
    getLogger().info({ signedOver: verified.signedOver }, 'Mini App credential accepted');
  }

  // A working client drains the counter it may have contributed to; without
  // this the count only ever grows, and a single burst of bad signatures from
  // one address blocks that address for the full window even while genuine
  // requests are succeeding.
  recordLoginSuccess(limiterKey);

  req.miniUser = user;
  req.miniTelegram = verified.user;
  next();
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Whether the app is usable at all, before anyone signs in.
 *
 * Deliberately says nothing about who is registered: an unauthenticated
 * caller learns only that the app exists.
 */
miniappRouter.get('/config', (_req: Request, res: Response) => {
  // Registered before the credential check, so it carries the master switch
  // itself rather than inheriting it.
  res.setHeader('Cache-Control', 'no-store');
  if (!config.miniapp.enabled) {
    res.status(503).json({ enabled: false, error: 'The Mini App is disabled.', code: 'DISABLED' });
    return;
  }
  res.json({
    enabled: true,
    // Deliberately no name, no branding, no counts: an unauthenticated caller
    // learns that the app exists and what it would accept, and nothing about
    // whose it is. The client carries its own title.
    formats: config.storage.allowedExtensions.map((e) => e.toUpperCase()),
    maxFileBytes: config.multipart.maxAssembledBytes,
    singleMaxBytes: config.upload.singleMaxBytes,
  });
});

/**
 * Never cache one person's answers where another might read them.
 *
 * Authentication here is a request *header*, and a cache that keys on the URL
 * alone — a proxy, a service worker, a badly configured tunnel — would happily
 * hand one user's `/me` or `/library` to the next caller. `no-store` says do
 * not keep it; `Vary: Authorization` says that if you keep anything anyway,
 * the credential is part of the key.
 *
 * Ahead of the credential check, so a refusal — a 403 naming one credential's
 * verdict, say — carries the same headers as an answer.
 */
miniappRouter.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Authorization');
  next();
});

miniappRouter.use(requireMiniAppUser);

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Shape a media row for the client: enough to display, nothing more. */
function publicMedia(m: MediaRow & { user_name?: string }) {
  return {
    id: m.id,
    uploadId: m.upload_id,
    title: m.title,
    year: m.year,
    type: m.type,
    season: m.season,
    episode: m.episode,
    episodeTitle: m.episode_title,
    fileSize: Number(m.file_size),
    // Deliberately absent: `path`. It is an internal filesystem location and
    // the client has no use for it.
    hasPoster: Boolean(m.poster_path),
    jellyfinItemId: m.jellyfin_item_id,
    jellyfinVerified: m.jellyfin_verified,
    addedAt: m.created_at,
  };
}

/** Shape an upload row: status and honest progress, never internals. */
function publicUpload(u: UploadRow & { jellyfin_verified?: boolean | null }) {
  return {
    id: u.id,
    filename: u.original_filename,
    title: u.detected_title,
    year: u.detected_year,
    mediaType: u.media_type,
    season: u.detected_season,
    episode: u.detected_episode,
    fileSize: Number(u.file_size),
    bytesDownloaded: Number(u.bytes_downloaded ?? 0),
    status: u.status,
    source: u.session_id ? 'multipart' : u.source,
    createdAt: u.created_at,
    completedAt: u.completed_at,
    durationMs: u.duration_ms,
    attempts: u.attempts,
    jellyfinVerified: u.jellyfin_verified ?? null,
    // Progress as the worker actually recorded it. `byteAccurate` is the field
    // that says whether the percentage came from counting bytes or from the
    // upload's position in the pipeline; the app labels the two differently so
    // a stage estimate is never read as a transfer figure.
    progress: {
      stage: u.progress_stage,
      percent: u.progress_percent === null || u.progress_percent === undefined ? null : Number(u.progress_percent),
      byteAccurate: u.progress_byte_accurate ?? false,
      bytesPerSecond: u.progress_bytes_per_sec === null ? null : Number(u.progress_bytes_per_sec),
      etaSeconds: u.progress_eta_sec === null ? null : Number(u.progress_eta_sec),
      part: u.progress_part,
      partCount: u.progress_part_count,
      updatedAt: u.progress_updated_at,
    },
    // Safe to show the owner: what stage failed and whether trying again could
    // help. The operator-facing detail — the raw error text, which can name
    // server paths — stays in the dashboard and the logs; the person who sent
    // the file gets the sentence written for them.
    failure:
      u.status === 'FAILED'
        ? {
            stage: u.error_stage,
            code: u.error_code,
            retryable: u.error_retryable,
            message: failureMessageFor(u),
          }
        : null,
  };
}

/**
 * The failure sentence a sender may see.
 *
 * The classified code's own wording where one exists; otherwise the recorded
 * text, but only when it carries no filesystem path — a raw `ENOENT: … open
 * '/home/…'` is for the operator.
 */
function failureMessageFor(u: UploadRow): string | null {
  const code = u.error_code;
  if (code && (ERROR_CODES as readonly string[]).includes(code) && code !== 'UNKNOWN_ERROR') {
    return RULES[code as ErrorCode].userMessage;
  }
  const raw = u.error_message;
  if (!raw) return null;
  if (/(^|[\s'"(])\/[A-Za-z0-9_.-]+\//.test(raw)) return 'The server hit a problem while handling this file.';
  return raw;
}

const ACTIVE_STATUSES = [
  'RECEIVED',
  'QUEUED',
  'DOWNLOADING',
  'PROCESSING',
  'ORGANIZING',
  'JELLYFIN_SCAN',
] as const;

miniappRouter.get(
  '/me',
  h(async (req, res) => {
    const user = req.miniUser!;
    const telegram = req.miniTelegram!;

    const [quota, media, statusCounts, activity, libraries] = await Promise.all([
      quotaStatus(user),
      mediaRepo.countsForUser(user.id),
      uploadsRepo.statusCountsForUser(user.id),
      uploadsRepo.activityForUser(user.id),
      librariesRepo.listForUser(user.id),
    ]);

    const sum = (statuses: readonly string[]) =>
      statuses.reduce((total, s) => total + (statusCounts[s] ?? 0), 0);

    res.json({
      // What this deployment calls itself, so the client does not hard-code a
      // name that belongs to whoever happens to be running it.
      appName: config.appName,
      // The display name comes from the signed blob; everything else comes
      // from our own records.
      telegram: {
        firstName: telegram.firstName,
        username: telegram.username ?? null,
        // The chat id is the caller's own and already known to them, but it is
        // not needed to render anything, so it is not sent.
      },
      account: {
        name: user.name,
        jellyfinUsername: user.jellyfin_username,
        uploadEnabled: user.upload_enabled,
        memberSince: user.created_at,
        libraries: libraries.length,
      },
      storage: {
        usedBytes: quota.usedBytes,
        reservedBytes: quota.reservedBytes,
        quotaBytes: quota.quotaBytes,
        remainingBytes: quota.remainingBytes,
        percentUsed: quota.percentUsed,
        movies: media.movies,
        episodes: media.episodes,
        shows: media.shows,
      },
      uploads: {
        total: Object.values(statusCounts).reduce((a, b) => a + b, 0),
        completed: statusCounts['COMPLETED'] ?? 0,
        failed: statusCounts['FAILED'] ?? 0,
        needsReview: statusCounts['NEEDS_REVIEW'] ?? 0,
        active: sum(ACTIVE_STATUSES),
        lastAt: activity.lastAt,
      },
      jellyfinUrl: config.jellyfin.publicUrl || null,
      // Every door to Jellyfin, in the order the app should prefer them. The
      // app measures which ones answer; nothing here presumes where the phone
      // is. `lan` is the same address as `jellyfinUrl`, named for what it is.
      jellyfin: {
        tailscale: config.jellyfin.tailscaleUrl || null,
        lan: config.jellyfin.publicUrl || null,
        internet: config.jellyfin.internetUrl || null,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const librarySchema = pageSchema.extend({
  type: z.enum(['movie', 'tv']).optional(),
  q: z.string().max(120).optional(),
});

miniappRouter.get(
  '/library',
  h(async (req, res) => {
    const user = req.miniUser!;
    const parsed = librarySchema.safeParse(req.query);
    if (!parsed.success) return void res.status(422).json({ error: 'Invalid query', code: 'BAD_QUERY' });

    // `userId` is taken from the authenticated user and is not a parameter the
    // caller can influence. A `userId` in the query string is ignored, not
    // honoured.
    const result = await mediaRepo.search({
      userId: user.id,
      type: parsed.data.type,
      q: parsed.data.q,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });

    res.json({
      items: result.rows.map(publicMedia),
      total: result.total,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
  }),
);

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

const uploadsSchema = pageSchema.extend({
  status: z.string().max(32).optional(),
  q: z.string().max(120).optional(),
});

miniappRouter.get(
  '/uploads',
  h(async (req, res) => {
    const user = req.miniUser!;
    const parsed = uploadsSchema.safeParse(req.query);
    if (!parsed.success) return void res.status(422).json({ error: 'Invalid query', code: 'BAD_QUERY' });

    const result = await uploadsRepo.search({
      userId: user.id,
      status: parsed.data.status as never,
      q: parsed.data.q,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });

    res.json({
      items: result.rows.map(publicUpload),
      total: result.total,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
  }),
);

/**
 * Everything still in flight, in one request.
 *
 * Separate from the history endpoint because it is the one the app polls: it
 * is bounded by how many uploads a person can have running at once, so it
 * never needs paging, and it can be fetched on a short interval without
 * carrying a page of finished work along with it.
 */
miniappRouter.get(
  '/active',
  h(async (req, res) => {
    const user = req.miniUser!;
    // Filtered in SQL. Fetching a page and narrowing it here lost any upload
    // with more than a page of newer rows ahead of it — exactly the long
    // transfer this view exists to show — and reported the size of the
    // filtered page as the total.
    const result = await uploadsRepo.search({
      userId: user.id,
      statusIn: ACTIVE_STATUSES,
      limit: 50,
      offset: 0,
    });
    res.json({ items: result.rows.map(publicUpload), total: result.total });
  }),
);

/**
 * Load an upload and prove it belongs to the caller.
 *
 * Every route below takes an id from the URL, which is the one place a client
 * chooses what to touch. Ownership is therefore checked on the row itself,
 * never inferred from the id being plausible — and a row belonging to somebody
 * else is reported as absent rather than as forbidden, so the endpoint cannot
 * be used to discover which ids exist.
 */
async function ownedUpload(req: Request, res: Response): Promise<UploadRow | null> {
  const id = Number(req.params['id']);
  const upload = await uploadsRepo.byId(id);
  if (!upload || upload.user_id !== req.miniUser!.id) {
    res.status(404).json({ error: 'That upload does not exist.', code: 'NOT_FOUND' });
    return null;
  }
  return upload;
}

miniappRouter.post(
  '/uploads/:id/cancel',
  h(async (req, res) => {
    const upload = await ownedUpload(req, res);
    if (!upload) return;

    const cancelled = await uploadsRepo.requestCancel(upload.id);
    if (!cancelled) {
      return void res.status(409).json({ error: 'That upload has already finished.', code: 'NOT_CANCELLABLE' });
    }
    // A queued upload has no pipeline to edit its Telegram message; say so here.
    void announceCancelled(cancelled);

    await auditRepo.log({
      actor_type: 'telegram',
      // The chat id, matching what the bot writes for the same actor_type —
      // otherwise the column means two different things on the same rows.
      actor_id: String(req.miniTelegram!.id),
      action: 'upload.cancelled',
      entity_type: 'upload',
      entity_id: String(upload.id),
      detail: { via: 'miniapp' },
      ip_address: req.ip ?? null,
    });
    res.json({ ok: true, upload: publicUpload(cancelled) });
  }),
);

miniappRouter.post(
  '/uploads/:id/retry',
  h(async (req, res) => {
    const upload = await ownedUpload(req, res);
    if (!upload) return;

    // Deliberately the same set the admin API allows, and no wider. A
    // NEEDS_REVIEW upload was quarantined *because* the pipeline declined to
    // guess, and its stored_path now points at the quarantine copy — so
    // re-queueing it is a different operation wearing the same name.
    if (!['FAILED', 'CANCELLED'].includes(upload.status)) {
      return void res.status(409).json({
        error:
          upload.status === 'NEEDS_REVIEW'
            ? 'This one could not be identified. Rename the file and send it again.'
            : 'Only a failed or cancelled upload can be retried.',
        code: 'NOT_RETRYABLE',
      });
    }
    if (!req.miniUser!.upload_enabled) {
      return void res.status(403).json({ error: 'Uploading is disabled for this account.', code: 'UPLOADS_DISABLED' });
    }

    const job = await jobsRepo.retryUpload(upload.id);
    await auditRepo.log({
      actor_type: 'telegram',
      actor_id: String(req.miniTelegram!.id),
      action: 'upload.retried',
      entity_type: 'upload',
      entity_id: String(upload.id),
      detail: { via: 'miniapp' },
      ip_address: req.ip ?? null,
    });
    res.json({ ok: true, jobId: job.id });
  }),
);

// ---------------------------------------------------------------------------
// Posters
// ---------------------------------------------------------------------------

const POSTER_BASE = 'https://image.tmdb.org/t/p/w342';

/**
 * Serve a poster from this origin rather than letting the phone fetch it.
 *
 * Three reasons, in order of weight. The app is served over HTTPS while
 * Jellyfin is plain HTTP on the LAN, so a Jellyfin image would be blocked as
 * mixed content and simply never appear. Loading straight from TMDB would tell
 * TMDB which titles a private library holds, from the owner's own phone, which
 * is precisely the disclosure this whole system exists to avoid. And a
 * same-origin image keeps the page's `img-src 'self'` intact instead of
 * widening it for every page the server serves.
 *
 * Ownership is checked first: a poster is only served for media belonging to
 * the caller, so the endpoint cannot be walked to learn what anyone else has.
 */
miniappRouter.get(
  '/poster/:id',
  h(async (req, res) => {
    const id = Number(req.params['id']);
    const media = await mediaRepo.byId(id);
    if (!media || media.user_id !== req.miniUser!.id || !media.poster_path) {
      return void res.status(404).json({ error: 'No poster.', code: 'NOT_FOUND' });
    }

    // The path comes from TMDB's own response, but it is still concatenated
    // into a URL, so it is constrained to the shape TMDB actually produces.
    if (!/^\/[A-Za-z0-9._-]{1,64}$/.test(media.poster_path)) {
      return void res.status(404).json({ error: 'No poster.', code: 'NOT_FOUND' });
    }

    try {
      const upstream = await fetch(`${POSTER_BASE}${media.poster_path}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!upstream.ok || !upstream.body) {
        return void res.status(404).json({ error: 'No poster.', code: 'NOT_FOUND' });
      }
      const type = upstream.headers.get('content-type') ?? '';
      if (!type.startsWith('image/')) {
        return void res.status(404).json({ error: 'No poster.', code: 'NOT_FOUND' });
      }

      res.setHeader('Content-Type', type);
      // Private and per-credential: worth caching on the device, never in a
      // shared intermediary keyed on the URL alone.
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.setHeader('Vary', 'Authorization');
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.end(buffer);
    } catch {
      res.status(404).json({ error: 'No poster.', code: 'NOT_FOUND' });
    }
  }),
);

// Anything unmatched here is a 404 in JSON, never the SPA shell.
miniappRouter.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
});
