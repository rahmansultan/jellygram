import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config/index.js';
import { getLogger } from '../lib/logger.js';
import { query } from '../db/pool.js';
import { adminsRepo, auditRepo } from '../db/repositories.js';
import type { AdminRow } from '../db/types.js';

/**
 * Admin authentication.
 *
 * Passwords are hashed with scrypt (memory-hard, in Node's core crypto, no
 * native build step). Sessions are opaque random tokens delivered in an
 * HttpOnly + SameSite=Strict cookie; only their SHA-256 is stored, so reading
 * the database does not yield a usable session. CSRF is a double-submit token
 * that the browser must echo in a header on every state-changing request.
 */

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

export const SESSION_COOKIE = 'jellygram_session';
export const CSRF_HEADER = 'x-csrf-token';

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const derived = await scrypt(password, salt, expected.length);
  // Constant-time: a length mismatch alone must not be observable by timing.
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export interface SessionInfo {
  admin: AdminRow;
  csrfToken: string;
  sessionId: number;
}

export async function createSession(
  admin: AdminRow,
  meta: { userAgent?: string; ip?: string },
): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.admin.sessionTtlHours * 3600 * 1000);

  await query(
    `INSERT INTO admin_sessions (token_hash, admin_id, csrf_token, user_agent, ip_address, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [sha256(token), admin.id, csrfToken, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null, expiresAt],
  );

  return { token, csrfToken, expiresAt };
}

export async function loadSession(token: string): Promise<SessionInfo | null> {
  const { rows } = await query<{ id: number; admin_id: number; csrf_token: string }>(
    `SELECT id, admin_id, csrf_token FROM admin_sessions
      WHERE token_hash = $1 AND expires_at > now()`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return null;

  const admin = await adminsRepo.byId(row.admin_id);
  if (!admin) return null;

  return { admin, csrfToken: row.csrf_token, sessionId: row.id };
}

export async function destroySession(token: string): Promise<void> {
  await query('DELETE FROM admin_sessions WHERE token_hash = $1', [sha256(token)]);
}

export async function destroyAllSessionsFor(adminId: number): Promise<void> {
  await query('DELETE FROM admin_sessions WHERE admin_id = $1', [adminId]);
}

export async function purgeExpiredSessions(): Promise<number> {
  const { rowCount } = await query('DELETE FROM admin_sessions WHERE expires_at <= now()');
  return rowCount ?? 0;
}

/**
 * Whether the cookie should be marked Secure for *this* request.
 *
 * The dashboard answers on two origins at once — plain HTTP on the LAN and
 * HTTPS through the loopback proxy — so a single deployment-wide flag is wrong
 * for one of them. `ADMIN_COOKIE_SECURE` still forces it on; otherwise the
 * request's own protocol decides, which `req.secure` reports honestly because
 * only the loopback proxy is trusted to set the forwarded protocol.
 */
export function cookieSecureFor(req: Request): boolean {
  return config.admin.cookieSecure || req.secure;
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date, secure: boolean): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    expires: expiresAt,
    path: '/',
  });
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
  });
}

declare module 'express-serve-static-core' {
  interface Request {
    session?: SessionInfo;
  }
}

/** Reject anything without a valid session. */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const session = await loadSession(token);
  if (!session) {
    clearSessionCookie(res, cookieSecureFor(req));
    res.status(401).json({ error: 'Session expired' });
    return;
  }

  req.session = session;
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF check.
 *
 * The token is issued in the JSON login response (never in a readable cookie)
 * and must be echoed in a custom header, which cross-origin form posts and
 * image tags cannot set.
 */
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();

  const provided = req.get(CSRF_HEADER);
  const expected = req.session?.csrfToken;

  // Compared as digests: `timingSafeEqual` throws on buffers of different
  // byte length, and a multibyte header of the same *string* length used to
  // reach it and turn a bad token into a 500.
  if (
    !expected ||
    !provided ||
    !crypto.timingSafeEqual(
      crypto.createHash('sha256').update(provided).digest(),
      crypto.createHash('sha256').update(expected).digest(),
    )
  ) {
    res.status(403).json({ error: 'Invalid CSRF token' });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Login throttling
// ---------------------------------------------------------------------------

interface Attempt {
  count: number;
  firstAt: number;
  blockedUntil: number;
}

const attempts = new Map<string, Attempt>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const BLOCK_MS = 15 * 60 * 1000;

/**
 * A second ceiling per *address*, whatever the key.
 *
 * Keys are `ip:username`, so a caller could spend eight guesses on each of a
 * thousand usernames — each one costing a scrypt, two queries and an audit row
 * — without ever tripping the per-account limit. Thirty failures from one
 * address in the window is a guesser whichever accounts it named.
 */
const ADDRESS_MAX_ATTEMPTS = 30;
/** Entries are swept once the map grows past this, so it cannot grow forever. */
const MAX_TRACKED = 10_000;

/** The address half of a `ip:username` key; the whole key when there is none. */
function addressOf(key: string): string {
  const i = key.lastIndexOf(':');
  return i > 0 ? `addr:${key.slice(0, i)}` : `addr:${key}`;
}

function sweep(now: number): void {
  if (attempts.size < MAX_TRACKED) return;
  for (const [k, entry] of attempts) {
    if (entry.blockedUntil <= now && now - entry.firstAt > WINDOW_MS) attempts.delete(k);
  }
}

function blockedFor(key: string, now: number): number {
  const entry = attempts.get(key);
  if (!entry) return 0;
  if (entry.blockedUntil > now) return Math.ceil((entry.blockedUntil - now) / 1000);
  if (now - entry.firstAt > WINDOW_MS) attempts.delete(key);
  return 0;
}

/** Slow down password guessing without needing another service. */
export function checkLoginAllowed(key: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const retryAfterSec = Math.max(blockedFor(key, now), blockedFor(addressOf(key), now));
  return retryAfterSec > 0 ? { allowed: false, retryAfterSec } : { allowed: true, retryAfterSec: 0 };
}

function bump(key: string, ceiling: number, now: number): void {
  const entry = attempts.get(key) ?? { count: 0, firstAt: now, blockedUntil: 0 };
  if (now - entry.firstAt > WINDOW_MS) {
    entry.count = 0;
    entry.firstAt = now;
  }
  entry.count += 1;
  if (entry.count >= ceiling) {
    entry.blockedUntil = now + BLOCK_MS;
    getLogger().warn({ key }, 'Login attempts blocked after repeated failures');
  }
  attempts.set(key, entry);
}

export function recordLoginFailure(key: string): void {
  const now = Date.now();
  sweep(now);
  bump(key, MAX_ATTEMPTS, now);
  bump(addressOf(key), ADDRESS_MAX_ATTEMPTS, now);
}

export function recordLoginSuccess(key: string): void {
  attempts.delete(key);
}

/** Test seam: forget every attempt. */
export function resetLoginThrottle(): void {
  attempts.clear();
}

export async function auditLogin(
  req: Request,
  action: 'admin.login' | 'admin.login.failed' | 'admin.logout',
  username: string,
): Promise<void> {
  await auditRepo.log({
    actor_type: 'admin',
    actor_id: username,
    action,
    ip_address: req.ip ?? null,
    detail: { userAgent: req.get('user-agent')?.slice(0, 200) ?? null },
  });
}
