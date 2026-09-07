import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config/index.js';
import { getLogger } from '../../lib/logger.js';
import { storageSlug } from '../../lib/paths.js';
import { pingDatabase, query } from '../../db/pool.js';
import {
  adminsRepo,
  auditRepo,
  jobsRepo,
  librariesRepo,
  mediaRepo,
  mtprotoJobsRepo,
  partsRepo,
  sessionsRepo,
  settingsRepo,
  uploadsRepo,
  uploadTokensRepo,
  usersRepo,
} from '../../db/repositories.js';
import { MTPROTO_STATUSES, SESSION_STATUSES, UPLOAD_STATUSES } from '../../db/types.js';

/**
 * The statuses that mean "still working on it".
 *
 * Defined once: the dashboard's active count and the user page's active count
 * are the same claim, and two lists would eventually disagree about whether
 * NEEDS_REVIEW is work in progress. It is not — it is waiting for a person.
 */
const ACTIVE_UPLOAD_STATUSES = [
  'RECEIVED',
  'QUEUED',
  'DOWNLOADING',
  'PROCESSING',
  'ORGANIZING',
  'JELLYFIN_SCAN',
] as const;
import type { JobRow, MediaRow } from '../../db/types.js';
import { diskUsage, directorySize, formatBytes } from '../../services/storage.js';
import * as jf from '../../services/jellyfin.js';
import { verifyMedia } from '../../services/jellyfin-verify.js';
import { runHealthChecks, worstState } from '../../services/health.js';
import { quotaStatus } from '../../services/quota.js';
import { checkTmdb } from '../../services/tmdb.js';
import { botApiFileLimit, effectiveMaxFileSize } from '../../services/download.js';
import { missingParts } from '../../services/multipart.js';
import { partsDirSize } from '../../services/assembly.js';
import { cancelSession, retrySession } from '../../worker/multipart.js';
import { announceCancelled } from '../../services/notifier.js';
import { retryMtprotoJob } from '../../worker/mtproto.js';
import { status as mtprotoStatus } from '../../services/mtproto.js';
import {
  auditIsolation,
  deprovisionUser,
  enforceIsolation,
  provisionUser,
  userMediaDir,
} from '../../services/isolation.js';
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  auditLogin,
  checkLoginAllowed,
  clearSessionCookie,
  cookieSecureFor,
  createSession,
  destroyAllSessionsFor,
  destroySession,
  hashPassword,
  recordLoginFailure,
  recordLoginSuccess,
  requireAuth,
  requireCsrf,
  setSessionCookie,
  verifyPassword,
} from '../auth.js';

/**
 * Admin HTTP API.
 *
 * Every route below `/api` except `/api/auth/login` and `/api/health` requires
 * a session, and every state-changing route additionally requires the CSRF
 * header. Input is validated with zod before it reaches the database.
 */

const log = getLogger;

export const router = Router();

/**
 * One gate for every `:id` in a path.
 *
 * Seventeen handlers each did `Number(req.params['id'])` and passed the result
 * to a query. `Number('99999999999999999999')` is 1e20 — an integer as far as
 * `Number.isInteger` is concerned, and far outside a PostgreSQL bigint — so a
 * mistyped URL came back as a 500. A bad path parameter is the client's
 * mistake, and reporting it as a server error both misleads the caller and
 * fills the log with incidents that are not incidents.
 *
 * `isSafeInteger` is the right bound: it is strictly tighter than bigint, so
 * anything that passes here can be handed to the database.
 */
router.param('id', (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  next();
});

/** Wrap an async handler so a rejection becomes a 500 instead of a hang. */
function h(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function parseBody<T extends z.ZodTypeAny>(schema: T, req: Request, res: Response): z.infer<T> | null {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    res.status(422).json({
      error: 'Validation failed',
      details: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return null;
  }
  return result.data;
}

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

// ===========================================================================
// Health (unauthenticated, no sensitive detail)
// ===========================================================================

router.get(
  '/health',
  h(async (_req, res) => {
    const dbOk = await pingDatabase();
    // `appName` is the operator-chosen display name. It is unauthenticated
    // because it is already painted on the sign-in page, and it lets the
    // dashboard brand itself without a second round trip.
    res
      .status(dbOk ? 200 : 503)
      .json({ status: dbOk ? 'ok' : 'degraded', database: dbOk, appName: config.appName });
  }),
);

// ===========================================================================
// Authentication
// ===========================================================================

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(512),
});

router.post(
  '/auth/login',
  h(async (req, res) => {
    const body = parseBody(loginSchema, req, res);
    if (!body) return;

    const throttleKey = `${req.ip ?? 'unknown'}:${body.username.toLowerCase()}`;
    const allowed = checkLoginAllowed(throttleKey);
    if (!allowed.allowed) {
      res.status(429).json({
        error: `Too many failed attempts. Try again in ${allowed.retryAfterSec} seconds.`,
      });
      return;
    }

    const admin = await adminsRepo.byUsername(body.username);
    // Always run a verification so a missing account and a wrong password take
    // the same time.
    const ok = admin
      ? await verifyPassword(body.password, admin.password_hash)
      : await verifyPassword(body.password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');

    if (!admin || !ok) {
      recordLoginFailure(throttleKey);
      // The name is recorded only when it belongs to an account. Anything else
      // is free text somebody typed into a login box — as often as not a
      // password pasted into the wrong field — and it stays out of the audit
      // table and the log.
      const recorded = admin ? admin.username : 'unknown';
      await auditLogin(req, 'admin.login.failed', recorded);
      log().warn({ username: recorded, ip: req.ip }, 'Failed admin login');
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    recordLoginSuccess(throttleKey);
    const session = await createSession(admin, {
      userAgent: req.get('user-agent') ?? undefined,
      ip: req.ip ?? undefined,
    });
    setSessionCookie(res, session.token, session.expiresAt, cookieSecureFor(req));
    await adminsRepo.touchLogin(admin.id);
    await auditLogin(req, 'admin.login', admin.username);

    res.json({
      username: admin.username,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt.toISOString(),
    });
  }),
);

router.post(
  '/auth/logout',
  requireAuth,
  requireCsrf,
  h(async (req, res) => {
    const token = (req.cookies as Record<string, string>)[SESSION_COOKIE];
    if (token) await destroySession(token);
    clearSessionCookie(res, cookieSecureFor(req));
    await auditLogin(req, 'admin.logout', req.session!.admin.username);
    res.json({ ok: true });
  }),
);

router.get(
  '/auth/me',
  requireAuth,
  h(async (req, res) => {
    res.json({
      username: req.session!.admin.username,
      csrfToken: req.session!.csrfToken,
      lastLoginAt: req.session!.admin.last_login_at,
    });
  }),
);

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12, 'Password must be at least 12 characters').max(512),
});

router.post(
  '/auth/password',
  requireAuth,
  requireCsrf,
  h(async (req, res) => {
    const body = parseBody(passwordSchema, req, res);
    if (!body) return;

    const admin = req.session!.admin;
    if (!(await verifyPassword(body.currentPassword, admin.password_hash))) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }

    await adminsRepo.setPassword(admin.id, await hashPassword(body.newPassword));
    // Changing a password invalidates every session, including this one.
    await destroyAllSessionsFor(admin.id);
    clearSessionCookie(res, cookieSecureFor(req));
    await auditRepo.log({
      actor_type: 'admin',
      actor_id: admin.username,
      action: 'admin.password_changed',
      ip_address: req.ip ?? null,
    });
    res.json({ ok: true, message: 'Password changed. Please sign in again.' });
  }),
);

// Everything below requires a session.
router.use(requireAuth);
router.use(requireCsrf);

// ===========================================================================
// Dashboard
// ===========================================================================

router.get(
  '/dashboard',
  h(async (_req, res) => {
    const [users, counts, statusCounts, recent, disk, jobStats, sessionCounts, activeSessions] =
      await Promise.all([
        usersRepo.list(),
        mediaRepo.counts(),
        uploadsRepo.statusCounts(),
        uploadsRepo.recent(10),
        diskUsage(config.storage.mediaRoot),
        jobsRepo.stats(),
        sessionsRepo.statusCounts(),
        sessionsRepo.search({ active: true, limit: 10, offset: 0 }),
      ]);

    const activeUploads = ACTIVE_UPLOAD_STATUSES.reduce((sum, s) => sum + (statusCounts[s] ?? 0), 0);

    res.json({
      users: { total: users.length, active: users.filter((u) => u.active).length },
      media: counts,
      uploads: {
        total: Object.values(statusCounts).reduce((a, b) => a + b, 0),
        active: activeUploads,
        failed: statusCounts['FAILED'] ?? 0,
        // Waiting on a person rather than broken; counted separately so a
        // review queue never reads as an outage.
        needsReview: statusCounts['NEEDS_REVIEW'] ?? 0,
        completed: statusCounts['COMPLETED'] ?? 0,
        duplicate: statusCounts['DUPLICATE'] ?? 0,
        byStatus: statusCounts,
      },
      jobs: jobStats,
      multipart: {
        byStatus: sessionCounts,
        active: activeSessions.total,
        failed: sessionCounts['FAILED'] ?? 0,
        sessions: activeSessions.rows,
      },
      storage: {
        totalBytes: disk.totalBytes,
        usedBytes: disk.usedBytes,
        freeBytes: disk.availableBytes,
        mediaBytes: counts.bytes,
        minFreeBytes: config.storage.minFreeDiskBytes,
      },
      recentUploads: recent,
    });
  }),
);

// ===========================================================================
// Users
// ===========================================================================

const userFields = z.object({
  name: z.string().min(1).max(120),
  telegram_chat_id: z.coerce.number().int(),
  jellyfin_username: z.string().min(1).max(120),
  active: z.boolean(),
  upload_enabled: z.boolean(),
  quota_bytes: z.coerce.number().int().nonnegative().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const userCreateSchema = userFields.extend({
  active: z.boolean().default(true),
  upload_enabled: z.boolean().default(true),
});

// Derived from the field list *without* the defaults. `.partial()` on the
// create schema kept them, so every partial update — the Deactivate button
// sends `{active:false}` alone — silently wrote `upload_enabled: true` as
// well, re-enabling uploads the administrator had switched off.
export const userUpdateSchema = userFields.partial();

router.get(
  '/users',
  h(async (_req, res) => {
    const [users, usage, libraries] = await Promise.all([
      usersRepo.list(),
      usersRepo.storageUsage(),
      librariesRepo.listAll(),
    ]);
    const usageById = new Map(usage.map((u) => [u.user_id, u]));

    res.json({
      users: users.map(({ upload_token_hash, ...u }) => ({
        ...u,
        // The hash cannot authenticate anything — the API hashes what is
        // presented and compares — but the browser has no use for it either,
        // and whether a token exists is the only part the UI needs.
        has_upload_token: Boolean(upload_token_hash),
        storage_bytes: usageById.get(u.id)?.bytes ?? 0,
        media_items: usageById.get(u.id)?.items ?? 0,
        libraries: libraries.filter((l) => l.user_id === u.id),
        movies_path: userMediaDir(u, 'movie'),
        tv_path: userMediaDir(u, 'tv'),
      })),
    });
  }),
);

/**
 * Everything the user page shows, in one request.
 *
 * Assembled server-side because the alternative is six round trips whose
 * results can disagree: storage counted at one instant, uploads at another.
 * Nothing here reaches Jellyfin — the live isolation check is a deliberate
 * separate action, so opening a user's page stays fast when Jellyfin is slow
 * or down.
 */
router.get(
  '/users/:id',
  h(async (req, res) => {
    const id = Number(req.params['id']);
    const user = await usersRepo.byId(id);
    if (!user) return void res.status(404).json({ error: 'User not found' });

    const [quota, media, statusCounts, activity, libraries, recent, audit] = await Promise.all([
      quotaStatus(user),
      mediaRepo.countsForUser(id),
      uploadsRepo.statusCountsForUser(id),
      uploadsRepo.activityForUser(id),
      librariesRepo.listForUser(id),
      uploadsRepo.search({ userId: id, limit: 5, offset: 0 }),
      auditRepo.search({ entityType: 'user', entityId: String(id), limit: 20, offset: 0 }),
    ]);

    const sum = (statuses: readonly string[]) =>
      statuses.reduce((total, s) => total + (statusCounts[s] ?? 0), 0);

    const { upload_token_hash, ...safe } = user;

    res.json({
      user: {
        ...safe,
        has_upload_token: Boolean(upload_token_hash),
        movies_path: userMediaDir(user, 'movie'),
        tv_path: userMediaDir(user, 'tv'),
      },
      uploads: {
        total: Object.values(statusCounts).reduce((a, b) => a + b, 0),
        completed: statusCounts['COMPLETED'] ?? 0,
        failed: statusCounts['FAILED'] ?? 0,
        cancelled: statusCounts['CANCELLED'] ?? 0,
        duplicate: statusCounts['DUPLICATE'] ?? 0,
        needsReview: statusCounts['NEEDS_REVIEW'] ?? 0,
        active: sum(ACTIVE_UPLOAD_STATUSES),
        byStatus: statusCounts,
        ...activity,
      },
      storage: { ...quota, ...media },
      libraries,
      // Enough for the page to say whether the account is linked and
      // provisioned without asking Jellyfin.
      jellyfin: {
        username: user.jellyfin_username,
        linked: Boolean(user.jellyfin_user_id),
        libraries: libraries.length,
        expected: 2,
      },
      recentUploads: recent.rows,
      activity: audit.rows,
    });
  }),
);

router.post(
  '/users',
  h(async (req, res) => {
    const body = parseBody(userCreateSchema, req, res);
    if (!body) return;

    if (await usersRepo.byTelegramChatId(body.telegram_chat_id)) {
      res.status(409).json({ error: 'That Telegram ID is already registered' });
      return;
    }
    if (await usersRepo.byJellyfinUsername(body.jellyfin_username)) {
      res.status(409).json({ error: 'That Jellyfin username is already linked to another user' });
      return;
    }

    // Confirm the Jellyfin account exists rather than creating one: user
    // creation stays a deliberate action in the Jellyfin dashboard.
    let jellyfinUserId: string | null = null;
    if (config.jellyfin.configured) {
      const jfUser = await jf.findUserByName(body.jellyfin_username).catch(() => null);
      if (!jfUser) {
        res.status(422).json({
          error: `No Jellyfin account named "${body.jellyfin_username}". Create it in Jellyfin first — this application never creates Jellyfin accounts.`,
        });
        return;
      }
      jellyfinUserId = jfUser.id;
    }

    const slug = await uniqueSlug(body.jellyfin_username);
    const user = await usersRepo.create({
      name: body.name,
      telegram_chat_id: body.telegram_chat_id,
      jellyfin_username: body.jellyfin_username,
      jellyfin_user_id: jellyfinUserId,
      storage_slug: slug,
      active: body.active,
      upload_enabled: body.upload_enabled,
      quota_bytes: body.quota_bytes ?? null,
      notes: body.notes ?? null,
    });

    const provision = await provisionUser(user).catch((err) => ({
      ok: false,
      steps: [],
      warnings: [(err as Error).message],
      jellyfinUserId: null,
    }));

    await auditRepo.log({
      actor_type: 'admin',
      actor_id: req.session!.admin.username,
      action: 'user.created',
      entity_type: 'user',
      entity_id: String(user.id),
      detail: { name: user.name, jellyfin_username: user.jellyfin_username },
      ip_address: req.ip ?? null,
    });

    res.status(201).json({ user: await usersRepo.byId(user.id), provision });
  }),
);

router.patch(
  '/users/:id',
  h(async (req, res) => {
    const id = Number(req.params['id']);
    if (!Number.isInteger(id)) return void res.status(400).json({ error: 'Invalid user id' });

    const body = parseBody(userUpdateSchema, req, res);
    if (!body) return;

    const existing = await usersRepo.byId(id);
    if (!existing) return void res.status(404).json({ error: 'User not found' });

    if (body.telegram_chat_id !== undefined && body.telegram_chat_id !== existing.telegram_chat_id) {
      const clash = await usersRepo.byTelegramChatId(body.telegram_chat_id);
      if (clash && clash.id !== id) {
        return void res.status(409).json({ error: 'That Telegram ID is already registered' });
      }
    }

    if (
      body.jellyfin_username !== undefined &&
      body.jellyfin_username.toLowerCase() !== existing.jellyfin_username.toLowerCase()
    ) {
      const clash = await usersRepo.byJellyfinUsername(body.jellyfin_username);
      if (clash && clash.id !== id) {
        return void res.status(409).json({ error: 'That Jellyfin username is already linked' });
      }
      if (config.jellyfin.configured) {
        const jfUser = await jf.findUserByName(body.jellyfin_username).catch(() => null);
        if (!jfUser) {
          return void res
            .status(422)
            .json({ error: `No Jellyfin account named "${body.jellyfin_username}".` });
        }
      }
    }

    // The storage slug is deliberately *not* changed on rename: moving an
    // existing library on disk would break every path already in `media`.
    const updated = await usersRepo.update(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.telegram_chat_id !== undefined ? { telegram_chat_id: body.telegram_chat_id } : {}),
      ...(body.jellyfin_username !== undefined ? { jellyfin_username: body.jellyfin_username } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
      ...(body.upload_enabled !== undefined ? { upload_enabled: body.upload_enabled } : {}),
      ...(body.quota_bytes !== undefined ? { quota_bytes: body.quota_bytes } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
    });

    await auditRepo.log({
      actor_type: 'admin',
      actor_id: req.session!.admin.username,
      action: 'user.updated',
      entity_type: 'user',
      entity_id: String(id),
      detail: { fields: Object.keys(body) },
      ip_address: req.ip ?? null,
    });

    res.json({ user: updated });
  }),
);

/**
 * Issue an upload token for a user.
 *
 * The plaintext is returned exactly once and never stored: only its SHA-256
 * lands in the database, so a leaked backup cannot be turned into working
 * credentials. It is deliberately not logged or audited in full — the audit
 * entry records that a token was issued, not what it was.
 *
 * Issuing again replaces the previous token, which is also how a compromised
 * one is rotated.
 */
router.post(
  '/users/:id/token',
  h(async (req, res) => {
    const id = Number(req.params['id']);
    const user = await usersRepo.byId(id);
    if (!user) return void res.status(404).json({ error: 'User not found' });

    const replaced = Boolean(user.upload_token_hash);
    const token = await uploadTokensRepo.issue(id);

    await auditRepo.log({
      actor_type: 'admin',
      actor_id: req.session!.admin.username,
      action: replaced ? 'upload_token.replaced' : 'upload_token.issued',
      entity_type: 'user',
      entity_id: String(id),
      ip_address: req.ip ?? null,
    });

    res.json({
      token,
      replaced,
      // Said plainly because the dashboard cannot show it again either.
      warning: 'This is the only time this token is shown. Store it now.',
    });
  }),
);

router.delete(
  '/users/:id/token',
  h(async (req, res) => {
    const id = Number(req.params['id']);
    const user = await usersRepo.byId(id);
    if (!user) return void res.status(404).json({ error: 'User not found' });

    await uploadTokensRepo.revoke(id);
    await auditRepo.log({
      actor_type: 'admin',
      actor_id: req.session!.admin.username,
      action: 'upload_token.revoked',
      entity_type: 'user',
      entity_id: String(id),
      ip_address: req.ip ?? null,
    });
    res.json({ ok: true });
  }),
);

router.post(
  '/users/:id/provision',
  h(async (req, res) => {
    const id = Number(req.params['id']);
    const user = await usersRepo.byId(id);
    if (!user) return void res.status(404).json({ error: 'User not found' });

    const result = await provisionUser(user);
    await auditRepo.log({
      actor_type: 'admin',
      actor_id: req.session!.admin.username,
      action: 'user.provisioned',
      entity_type: 'user',
      entity_id: String(id),
      detail: { ok: result.ok },
      ip_address: req.ip ?? null,
    });
    res.json(result);
  }),
);

router.delete(
  '/users/:id',
  h(async (req, res) => {
    const id = Number(req.params['id']);
    const user = await usersRepo.byId(id);
    if (!user) return void res.status(404).json({ error: 'User not found' });

    const notes = await deprovisionUser(user).catch((err) => [(err as Error).message]);
    await usersRepo.remove(id);

    await auditRepo.log({
      actor_type: 'admin',
      actor_id: req.session!.admin.username,
      action: 'user.deleted',
      entity_type: 'user',
      entity_id: String(id),
      detail: { name: user.name },
      ip_address: req.ip ?? null,
    });

    res.json({
      ok: true,
      notes,
      // Deleting a user removes their records, never their files.
      mediaRetainedAt: [userMediaDir(user, 'movie'), userMediaDir(user, 'tv')],
    });
  }),
);

router.get(
  '/users/:id/uploads',
  h(async (req, res) => {
    const id = Number(req.params['id']);
    const parsed = paginationSchema.safeParse(req.query);
    if (!parsed.success) {
      return void res.status(422).json({
        error: 'Validation failed',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const page = parsed.data;
    const result = await uploadsRepo.search({ userId: id, ...page });
    res.json({ uploads: result.rows, total: result.total, ...page });
  }),
);

async function uniqueSlug(base: string): Promise<string> {
  const root = storageSlug(base);
  const existing = new Set((await usersRepo.list()).map((u) => u.storage_slug));
  if (!existing.has(root)) return root;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${root}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${root}-${Date.now()}`;
}

// ===========================================================================
// Uploads
// ===========================================================================

const uploadQuerySchema = paginationSchema.extend({
  userId: z.coerce.number().int().optional(),
  status: z.enum(UPLOAD_STATUSES).optional(),
  mediaType: z.enum(['movie', 'tv', 'unknown']).optional(),
  q: z.string().max(200).optional(),
});

router.get(
  '/uploads',
  h(async (req, res) => {
    const parsed = uploadQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return void res.status(422).json({ error: 'Invalid query', details: parsed.error.issues });
    }
    const result = await uploadsRepo.search(parsed.data);
    res.json({ uploads: result.rows, total: result.total, ...parsed.data });
  }),
);

/**
 * Everything about one upload, in one request.
 *
 * The detail view needs the upload, who sent it, what it became, and its job
 * history; fetching those separately would mean four round trips and four
 * chances to render a half-populated page. Queue position is included only
 * while it means something.
 */
router.get(
  '/uploads/:id',
  h(async (req, res) => {
    const id = Number(req.params['id']);
    if (!Number.isInteger(id) || id <= 0) {
      return void res.status(400).json({ error: 'Invalid upload id' });
    }

    const upload = await uploadsRepo.byId(id);
    if (!upload) return void res.status(404).json({ error: 'Upload not found' });

    const [user, mediaRows, jobRows] = await Promise.all([
      usersRepo.byId(upload.user_id),
      query<MediaRow>('SELECT * FROM media WHERE upload_id = $1 ORDER BY id DESC LIMIT 1', [id]),
      query<JobRow>('SELECT * FROM jobs WHERE upload_id = $1 ORDER BY id DESC LIMIT 10', [id]),
    ]);

    const pending = jobRows.rows.find((j) => j.status === 'pending');
    const queue = pending ? await jobsRepo.queuePosition(pending.id).catch(() => null) : null;

    res.json({
      upload,
      // Only what the page shows; a user row carries more than it needs.
      user: user
        ? { id: user.id, name: user.name, storage_slug: user.storage_slug, active: user.active }
        : null,
      media: mediaRows.rows[0] ?? null,
      jobs: jobRows.rows,
      queue,
    });
  }),
);

router.post(
  '/uploads/:id/retry',
  h(async (req, res) => {
    const id = Number(req.params['id']);
    const upload = await uploadsRepo.byId(id);
    if (!upload) return void res.status(404).json({ error: 'Upload not found' });
    if (!['FAILED', 'CANCELLED'].includes(upload.status)) {
      return void res.status(409).json({ error: `Cannot retry an upload in state ${upload.status}` });
    }

    const job = await jobsRepo.retryUpload(id);
    await auditRepo.log({
      actor_type: 'admin',
      actor_id: req.session!.admin.username,
      action: 'upload.retried',
      entity_type: 'upload',
      entity_id: String(id),
      ip_address: req.ip ?? null,
    });
    res.json({ ok: true, jobId: job.id });
  }),
);

router.post(
  '/uploads/:id/cancel',
  h(async (req, res) => {
    const id = Number(req.params['id']);
    const upload = await uploadsRepo.requestCancel(id);
    if (!upload) {
      return void res.status(409).json({ error: 'Upload is not cancellable (already finished or missing)' });
    }
    await auditRepo.log({
      actor_type: 'admin',
      actor_id: req.session!.admin.username,
      action: 'upload.cancelled',
      entity_type: 'upload',
      entity_id: String(id),
      ip_address: req.ip ?? null,
    });
    void announceCancelled(upload);
    res.json({ ok: true, upload });
  }),
);

// ===========================================================================
// Media
// ===========================================================================

const mediaQuerySchema = paginationSchema.extend({
  userId: z.coerce.number().int().optional(),
  type: z.enum(['movie', 'tv']).optional(),
  q: z.string().max(200).optional(),
});

router.get(
  '/media',
  h(async (req, res) => {
    const parsed = mediaQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return void res.status(422).json({ error: 'Invalid query', details: parsed.error.issues });
    }
    const result = await mediaRepo.search(parsed.data);
    res.json({ media: result.rows, total: result.total, ...parsed.data });
  }),
);

const mediaDeleteSchema = z.object({ deleteFile: z.boolean().default(false) });

/**
 * Re-run the Jellyfin scan and verification for one item.
 *
 * Bounded deliberately: the pipeline's own verification waits up to
 * JELLYFIN_VERIFY_TIMEOUT_SEC, which is far too long to hold an HTTP request
 * open. A short look is enough to tell an administrator whether the scan
 * worked, and "pending" is an honest answer they can act on by trying again.
 */
router.post(
  '/media/:id/verify',
  h(async (req, res) => {
    const id = Number(req.params['id']);
    const media = await mediaRepo.byId(id);
    if (!media) return void res.status(404).json({ error: 'Media not found' });

    const result = await verifyMedia(media, { timeoutMs: 15_000 });

    await auditRepo.log({
      actor_type: 'admin',
      actor_id: req.session!.admin.username,
      action: 'media.jellyfin_verify',
      entity_type: 'media',
      entity_id: String(id),
      detail: { outcome: result.outcome },
      ip_address: req.ip ?? null,
    });

    // Every outcome is a 200: the request succeeded, and what it found is the
    // payload. A "pending" is not a client error.
    res.json(result);
  }),
);

router.delete(
  '/media/:id',
  h(async (req, res) => {
    const body = parseBody(mediaDeleteSchema, req, res);
    if (!body) return;

    const id = Number(req.params['id']);
    const row = await mediaRepo.remove(id);
    if (!row) return void res.status(404).json({ error: 'Media not found' });

    let fileRemoved = false;
    if (body.deleteFile) {
      // Re-check containment: the stored path is trusted, but cheaply proving
      // it again costs nothing and closes off a tampered row.
      const resolved = path.resolve(row.path);
      const inMediaRoot =
        resolved === config.storage.mediaRoot || resolved.startsWith(config.storage.mediaRoot + path.sep);
      if (!inMediaRoot) {
        log().error({ path: resolved }, 'Refusing to delete a file outside the media root');
      } else {
        await fsp.unlink(resolved).then(
          () => {
            fileRemoved = true;
          },
          (err: unknown) => {
            // The row is already gone, so this file is now findable only from
            // this log line and the audit entry's `fileRemoved: false`.
            log().warn({ err, path: resolved, mediaId: id }, 'Media row deleted but its file could not be removed');
          },
        );
      }
    }

    await auditRepo.log({
      actor_type: 'admin',
      actor_id: req.session!.admin.username,
      action: 'media.deleted',
      entity_type: 'media',
      entity_id: String(id),
      detail: { title: row.title, fileRemoved },
      ip_address: req.ip ?? null,
    });

    res.json({ ok: true, fileRemoved });
  }),
);

// ===========================================================================
// Multi-part upload sessions
// ===========================================================================

const sessionQuerySchema = paginationSchema.extend({
  userId: z.coerce.number().int().optional(),
  status: z.enum(SESSION_STATUSES).optional(),
  active: z.coerce.boolean().optional(),
  q: z.string().max(200).optional(),
});

/** Decorate a session row with the part detail the dashboard shows. */
async function withPartDetail(session: Awaited<ReturnType<typeof sessionsRepo.byId>> & object) {
  const parts = await partsRepo.listForSession(session.id);
  const ready = parts.filter((p) => p.status === 'READY');
  const failed = parts.filter((p) => p.status === 'FAILED');

  // Without a declared total the best estimate is the average part size times
  // the highest part number seen, which is what the progress bar uses.
  const highest = parts.reduce((max, p) => Math.max(max, p.part_number), 0);
  const expected = session.expected_parts ?? (highest || null);

  return {
    ...session,
    expected_parts_effective: expected,
    total_bytes: parts.reduce((sum, p) => sum + p.file_size, 0),
    downloaded_bytes: parts.reduce((sum, p) => sum + (p.status === 'READY' ? p.file_size : p.bytes_downloaded), 0),
    parts_total: parts.length,
    parts_ready: ready.length,
    parts_failed: failed.length,
    missing_parts: missingParts(ready.map((p) => p.part_number), session.expected_parts),
    parts: parts.map((p) => ({
      id: p.id,
      part_number: p.part_number,
      original_filename: p.original_filename,
      file_size: p.file_size,
      bytes_downloaded: p.bytes_downloaded,
      status: p.status,
      error_message: p.error_message,
      checksum_sha256: p.checksum_sha256,
      completed_at: p.completed_at,
    })),
  };
}

router.get(
  '/sessions',
  h(async (req, res) => {
    const parsed = sessionQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return void res.status(422).json({ error: 'Invalid query', details: parsed.error.issues });
    }

    const result = await sessionsRepo.search(parsed.data);
    const sessions = await Promise.all(result.rows.map((row) => withPartDetail(row)));

    res.json({
      sessions,
      total: result.total,
      counts: await sessionsRepo.statusCounts(),
      limits: {
        maxAssembledBytes: config.multipart.maxAssembledBytes,
        maxPartBytes: effectiveMaxFileSize(),
        maxParts: config.multipart.maxParts,
        idleMinutes: config.multipart.idleMinutes,
      },
      ...parsed.data,
    });
  }),
);

router.get(
  '/sessions/:id',
  h(async (req, res) => {
    const session = await sessionsRepo.byId(Number(req.params['id']));
    if (!session) return void res.status(404).json({ error: 'Session not found' });
    res.json({ session: await withPartDetail(session) });
  }),
);

router.post(
  '/sessions/:id/retry',
  h(async (req, res) => {
    const id = Number(req.params['id']);
    const session = await sessionsRepo.byId(id);
    if (!session) return void res.status(404).json({ error: 'Session not found' });

    if (session.status === 'COMPLETED') {
      return void res.status(409).json({ error: 'This session has already completed' });
    }

    const result = await retrySession(id);
    await auditRepo.log({
      actor_type: 'admin',
      actor_id: req.session!.admin.username,
      action: 'multipart.retried',
      entity_type: 'session',
      entity_id: String(id),
      detail: { requeued: result.requeued },
      ip_address: req.ip ?? null,
    });
    res.json({ ok: true, ...result });
  }),
);

router.post(
  '/sessions/:id/cancel',
  h(async (req, res) => {
    const id = Number(req.params['id']);
    const session = await sessionsRepo.byId(id);
    if (!session) return void res.status(404).json({ error: 'Session not found' });

    if (!['COLLECTING', 'READY', 'ASSEMBLING', 'VERIFYING', 'HANDOFF'].includes(session.status)) {
      return void res.status(409).json({ error: `Cannot cancel a session in state ${session.status}` });
    }

    await sessionsRepo.requestCancel(id);
    // Collecting sessions have no worker to notice the flag, so finish here.
    if (session.status === 'COLLECTING') {
      await cancelSession(id, 'Cancelled by the administrator');
    }

    await auditRepo.log({
      actor_type: 'admin',
      actor_id: req.session!.admin.username,
      action: 'multipart.cancelled',
      entity_type: 'session',
      entity_id: String(id),
      ip_address: req.ip ?? null,
    });
    res.json({ ok: true });
  }),
);

// ===========================================================================
// MTProto ingestion
// ===========================================================================

const mtprotoQuerySchema = paginationSchema.extend({
  userId: z.coerce.number().int().optional(),
  status: z.enum(MTPROTO_STATUSES).optional(),
  active: z.coerce.boolean().optional(),
  q: z.string().max(200).optional(),
});

/**
 * Shape one job for the dashboard.
 *
 * Deliberately omits anything sensitive: no session, no API hash, no bot
 * token. The origin is included only as far as the Bot API disclosed it.
 */
function presentMtprotoJob(job: Awaited<ReturnType<typeof mtprotoJobsRepo.byId>> & object) {
  const percent = job.file_size > 0 ? (job.bytes_downloaded / job.file_size) * 100 : 0;
  const remaining = Math.max(0, job.file_size - job.bytes_downloaded);
  const etaSeconds = job.speed_bps && job.speed_bps > 0 ? Math.round(remaining / job.speed_bps) : null;

  return {
    id: job.id,
    user_id: job.user_id,
    source: 'mtproto',
    file_name: job.file_name,
    file_size: job.file_size,
    mime_type: job.mime_type,
    telegram_message_id: job.bot_message_id,
    origin_kind: job.origin_kind,
    origin_chat: job.origin_chat,
    origin_message_id: job.origin_message_id,
    origin_title: job.origin_title,
    status: job.status,
    bytes_downloaded: job.bytes_downloaded,
    percent,
    speed_bps: job.speed_bps,
    eta_seconds: etaSeconds,
    sha256: job.sha256,
    upload_id: job.upload_id,
    attempts: job.attempts,
    error_message: job.error_message,
    created_at: job.created_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
  };
}

router.get(
  '/mtproto',
  h(async (req, res) => {
    const parsed = mtprotoQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return void res.status(422).json({ error: 'Invalid query', details: parsed.error.issues });
    }

    const result = await mtprotoJobsRepo.search(parsed.data);
    const state = await mtprotoStatus().catch(() => null);

    res.json({
      jobs: result.rows.map((row) => ({ ...presentMtprotoJob(row), user_name: row.user_name })),
      total: result.total,
      counts: await mtprotoJobsRepo.statusCounts(),
      // Readiness only: never the session, never the API hash.
      transport: state
        ? {
            enabled: state.enabled,
            credentialsPresent: state.credentialsPresent,
            sessionPresent: state.sessionPresent,
            sessionPathMode: state.sessionPathMode,
            authorized: state.authorized,
            accountUsername: state.account?.username ?? null,
            message: state.message,
          }
        : null,
      limits: {
        maxFileBytes: config.mtproto.maxFileBytes,
        botApiCeiling: botApiFileLimit(),
      },
      ...parsed.data,
    });
  }),
);

router.post(
  '/mtproto/:id/retry',
  h(async (req, res) => {
    const id = Number(req.params['id']);
    const job = await mtprotoJobsRepo.byId(id);
    if (!job) return void res.status(404).json({ error: 'Job not found' });

    const requeued = await retryMtprotoJob(id);
    if (!requeued) {
      return void res.status(409).json({ error: `Cannot retry a job in state ${job.status}` });
    }

    await auditRepo.log({
      actor_type: 'admin',
      actor_id: req.session!.admin.username,
      action: 'mtproto.retried',
      entity_type: 'mtproto_job',
      entity_id: String(id),
      ip_address: req.ip ?? null,
    });
    res.json({ ok: true });
  }),
);

router.post(
  '/mtproto/:id/cancel',
  h(async (req, res) => {
    const id = Number(req.params['id']);
    const cancelled = await mtprotoJobsRepo.requestCancel(id);
    if (!cancelled) {
      return void res.status(409).json({ error: 'Job is not cancellable' });
    }
    await auditRepo.log({
      actor_type: 'admin',
      actor_id: req.session!.admin.username,
      action: 'mtproto.cancelled',
      entity_type: 'mtproto_job',
      entity_id: String(id),
      ip_address: req.ip ?? null,
    });
    res.json({ ok: true });
  }),
);

// ===========================================================================
// Storage
// ===========================================================================

router.get(
  '/storage',
  h(async (_req, res) => {
    const [disk, users, usage, mediaCounts] = await Promise.all([
      diskUsage(config.storage.mediaRoot),
      usersRepo.list(),
      usersRepo.storageUsage(),
      mediaRepo.counts(),
    ]);
    const usageById = new Map(usage.map((u) => [u.user_id, u]));

    res.json({
      disk: {
        totalBytes: disk.totalBytes,
        usedBytes: disk.usedBytes,
        freeBytes: disk.availableBytes,
        totalHuman: formatBytes(disk.totalBytes),
        usedHuman: formatBytes(disk.usedBytes),
        freeHuman: formatBytes(disk.availableBytes),
      },
      media: { bytes: mediaCounts.bytes, movies: mediaCounts.movies, episodes: mediaCounts.episodes },
      thresholds: {
        minFreeBytes: config.storage.minFreeDiskBytes,
        maxFileSizeBytes: effectiveMaxFileSize(),
        safetyMarginBytes: config.storage.diskSafetyMarginBytes,
      },
      perUser: users.map((u) => ({
        id: u.id,
        name: u.name,
        bytes: usageById.get(u.id)?.bytes ?? 0,
        items: usageById.get(u.id)?.items ?? 0,
        quota_bytes: u.quota_bytes,
      })),
      paths: {
        mediaRoot: config.storage.mediaRoot,
        moviesRoot: config.storage.moviesRoot,
        tvRoot: config.storage.tvRoot,
        quarantine: config.storage.quarantineDir,
        parts: config.multipart.partsDir,
      },
      multipart: {
        maxAssembledBytes: config.multipart.maxAssembledBytes,
        maxPartBytes: effectiveMaxFileSize(),
        maxParts: config.multipart.maxParts,
        idleMinutes: config.multipart.idleMinutes,
      },
    });
  }),
);

/** On-disk sizes, which can differ from the database when files change outside the app. */
router.get(
  '/storage/scan',
  h(async (_req, res) => {
    const [movies, tv, quarantine, parts] = await Promise.all([
      directorySize(config.storage.moviesRoot),
      directorySize(config.storage.tvRoot),
      directorySize(config.storage.quarantineDir),
      partsDirSize(),
    ]);
    res.json({ moviesBytes: movies, tvBytes: tv, quarantineBytes: quarantine, partsBytes: parts });
  }),
);

// ===========================================================================
// System status, settings, privacy
// ===========================================================================

/**
 * Named health checks with a severity each.
 *
 * `/system/status` reports whether each dependency answered; this reports
 * whether anything is *wrong*, which is a different question and the one a
 * health page needs to answer at a glance.
 */
router.get(
  '/system/health',
  h(async (_req, res) => {
    const checks = await runHealthChecks();
    res.json({ state: worstState(checks), checks, checkedAt: new Date().toISOString() });
  }),
);

router.get(
  '/system/status',
  h(async (_req, res) => {
    const [dbOk, jellyfinStatus, tmdbStatus, jobStats] = await Promise.all([
      pingDatabase(),
      jf.status(),
      checkTmdb(),
      jobsRepo.stats(),
    ]);

    res.json({
      database: { ok: dbOk },
      jellyfin: { ...jellyfinStatus, url: config.jellyfin.url },
      tmdb: tmdbStatus,
      telegram: {
        // The token itself is never sent to the browser.
        configured: config.telegram.configured,
        apiRoot: config.telegram.apiRoot,
        localMode: config.telegram.localMode,
        maxDownloadBytes: botApiFileLimit(),
        effectiveMaxFileBytes: effectiveMaxFileSize(),
      },
      jobs: jobStats,
      mtproto: await mtprotoStatus()
        .then((m) => ({
          enabled: m.enabled,
          authorized: m.authorized,
          accountUsername: m.account?.username ?? null,
          message: m.message,
          maxFileBytes: config.mtproto.maxFileBytes,
        }))
        .catch(() => ({ enabled: false, authorized: false, accountUsername: null, message: 'unavailable', maxFileBytes: 0 })),
      process: {
        nodeVersion: process.version,
        uptimeSec: Math.round(process.uptime()),
        memoryRssBytes: process.memoryUsage().rss,
      },
    });
  }),
);

router.get(
  '/system/privacy',
  h(async (_req, res) => {
    const report = await auditIsolation();
    res.json(report);
  }),
);

router.post(
  '/system/privacy/enforce',
  h(async (req, res) => {
    const result = await enforceIsolation();
    const report = await auditIsolation();
    await auditRepo.log({
      actor_type: 'admin',
      actor_id: req.session!.admin.username,
      action: 'privacy.enforced',
      detail: { repaired: result.repaired.length },
      ip_address: req.ip ?? null,
    });
    res.json({ ...result, report });
  }),
);

router.post(
  '/system/jellyfin/scan',
  h(async (req, res) => {
    if (!config.jellyfin.configured) {
      return void res.status(422).json({ error: 'JELLYFIN_API_KEY is not configured' });
    }
    await jf.refreshLibrary();
    await auditRepo.log({
      actor_type: 'admin',
      actor_id: req.session!.admin.username,
      action: 'jellyfin.scan_triggered',
      ip_address: req.ip ?? null,
    });
    res.json({ ok: true, message: 'Jellyfin library scan requested' });
  }),
);

/**
 * Settings the dashboard may show. Secret-bearing values are reported only as
 * a configured/not-configured flag; their contents never leave the server.
 */
router.get(
  '/settings',
  h(async (_req, res) => {
    const stored = await settingsRepo.getAll();
    res.json({
      environment: {
        mediaRoot: config.storage.mediaRoot,
        moviesRoot: config.storage.moviesRoot,
        tvRoot: config.storage.tvRoot,
        quarantineDir: config.storage.quarantineDir,
        downloadTmpDir: config.storage.downloadTmpDir,
        maxFileSizeBytes: config.storage.maxFileSizeBytes,
        effectiveMaxFileBytes: effectiveMaxFileSize(),
        minFreeDiskBytes: config.storage.minFreeDiskBytes,
        allowedExtensions: config.storage.allowedExtensions,
        mediaGroup: config.storage.mediaGroup,
        jellyfinUrl: config.jellyfin.url,
        jellyfinApiKeyConfigured: config.jellyfin.configured,
        tmdbConfigured: config.tmdb.configured,
        telegramApiRoot: config.telegram.apiRoot,
        telegramLocalMode: config.telegram.localMode,
        workerConcurrency: config.worker.concurrency,
        workerLargeConcurrency: config.worker.largeConcurrency,
        workerSmallConcurrency: config.worker.smallConcurrency,
        largeUploadBytes: config.worker.largeUploadBytes,
        jobMaxAttempts: config.worker.maxAttempts,
        retryBackoffMs: config.worker.retryBackoffMs,
        retryMaxBackoffMs: config.worker.retryMaxBackoffMs,
        backupDir: config.backup.dir,
        backupRetentionDays: config.backup.retentionDays,
        logDir: config.log.dir,
        logLevel: config.log.level,
      },
      // Which environment variable sets each value, so the page can tell an
      // administrator where to change it rather than only what it currently is.
      sources: {
        mediaRoot: 'MEDIA_ROOT',
        moviesRoot: 'MOVIES_ROOT',
        tvRoot: 'TV_ROOT',
        quarantineDir: 'QUARANTINE_DIR',
        downloadTmpDir: 'DOWNLOAD_TMP_DIR',
        maxFileSizeBytes: 'MAX_FILE_SIZE_BYTES',
        minFreeDiskBytes: 'MIN_FREE_DISK_BYTES',
        allowedExtensions: 'ALLOWED_EXTENSIONS',
        mediaGroup: 'MEDIA_GROUP',
        jellyfinUrl: 'JELLYFIN_URL',
        telegramApiRoot: 'TELEGRAM_API_ROOT',
        telegramLocalMode: 'TELEGRAM_LOCAL_MODE',
        workerConcurrency: 'WORKER_CONCURRENCY',
        workerLargeConcurrency: 'WORKER_LARGE_CONCURRENCY',
        workerSmallConcurrency: 'WORKER_SMALL_CONCURRENCY',
        largeUploadBytes: 'WORKER_LARGE_UPLOAD_BYTES',
        jobMaxAttempts: 'JOB_MAX_ATTEMPTS',
        retryBackoffMs: 'JOB_RETRY_BACKOFF_MS',
        retryMaxBackoffMs: 'JOB_RETRY_MAX_BACKOFF_MS',
        backupDir: 'BACKUP_DIR',
        backupRetentionDays: 'BACKUP_RETENTION_DAYS',
        logDir: 'LOG_DIR',
        logLevel: 'LOG_LEVEL',
      },
      overrides: stored,
      note: 'Path, size and secret settings are read from .env. Edit .env and restart the services to change them.',
    });
  }),
);

const settingSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z0-9_.]+$/i, 'Key must be alphanumeric'),
  value: z.unknown(),
});

/**
 * Deprecated: writing a setting here changed nothing.
 *
 * The values are stored in a `settings` table that no part of the application
 * ever reads — `settingsRepo.get` has no callers — because configuration is
 * resolved from the environment once, at import time. An editor over this
 * would have been a page of controls that appear to work and do not, which is
 * the same trap `quota_bytes` was: a control nobody can see is inert is worse
 * than no control at all.
 *
 * Making these live would mean threading a dynamic override through every read
 * of `config`, which is a change to the part of the system least worth
 * destabilising for the benefit. Until that is worth doing, the honest
 * behaviour is to refuse and say where the value actually comes from. The
 * Settings page shows each value with the environment variable that sets it.
 */
router.put(
  '/settings',
  h(async (req, res) => {
    const body = parseBody(settingSchema, req, res);
    if (!body) return;

    res.status(410).json({
      error:
        'Settings are read from the environment at startup and cannot be changed here. ' +
        'Edit .env and restart the service.',
      key: body.key,
    });
  }),
);

const auditQuerySchema = paginationSchema.extend({
  entityType: z.enum(['user', 'upload', 'media', 'session', 'mtproto_job']).optional(),
  entityId: z.string().max(40).optional(),
  actorType: z.enum(['admin', 'system', 'telegram']).optional(),
  action: z.string().max(60).optional(),
  q: z.string().max(200).optional(),
});

router.get(
  '/audit',
  h(async (req, res) => {
    const parsed = auditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return void res.status(422).json({ error: 'Invalid query', details: parsed.error.issues });
    }
    const result = await auditRepo.search(parsed.data);
    res.json({ entries: result.rows, total: result.total, ...parsed.data });
  }),
);

/** The verbs actually present, so the filter never offers an empty choice. */
router.get(
  '/audit/actions',
  h(async (_req, res) => {
    res.json({ actions: await auditRepo.actions() });
  }),
);

/** Tail of the current log files, so the admin does not need shell access. */
router.get(
  '/logs/:service',
  h(async (req, res) => {
    const service = String(req.params['service']);
    if (!['api', 'bot', 'worker'].includes(service)) {
      return void res.status(400).json({ error: 'Unknown service' });
    }

    const lines = Math.min(Math.max(1, Number(req.query['lines'] ?? 200) || 200), 2000);
    const dir = config.log.dir;

    let files: string[];
    try {
      files = (await fsp.readdir(dir)).filter((f) => f.startsWith(`${service}.log-`)).sort();
    } catch {
      return void res.json({ service, lines: [], note: 'Log directory is not readable' });
    }
    const latest = files.at(-1);
    if (!latest) return void res.json({ service, lines: [], note: 'No log file yet' });

    const content = await fsp.readFile(path.join(dir, latest), 'utf8').catch(() => '');
    const tail = content.split('\n').filter(Boolean).slice(-lines);
    res.json({ service, file: latest, lines: tail });
  }),
);

// Anything unmatched under /api is a 404 in JSON, not the SPA's HTML.
router.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

export { CSRF_HEADER };
