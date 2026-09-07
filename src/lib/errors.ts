/**
 * One vocabulary for every failure the system can produce.
 *
 * The pipeline already had eleven error classes, each deciding retryability in
 * its own way, and the code recorded against a failed upload was whatever
 * happened to be on the object — `PipelineError` for one failure, `EINVAL` for
 * the next. That is fine for a human reading one row and useless for grouping,
 * alerting, or telling a user what to do.
 *
 * This does not replace those classes. They carry context this cannot, and
 * rewriting them would risk the behaviour they encode. It *reads* them and
 * produces a stable classification alongside, so the throw sites stay as they
 * are while everything downstream gets a consistent answer.
 */

import { config } from '../config/index.js';

export const ERROR_CODES = [
  'TELEGRAM_TIMEOUT',
  'TELEGRAM_FILE_NOT_FOUND',
  'TELEGRAM_FILE_TOO_BIG',
  'TELEGRAM_UNAVAILABLE',
  'MTPROTO_TIMEOUT',
  'MTPROTO_DOWNLOAD_FAILED',
  'MTPROTO_NOT_AUTHORISED',
  'MTPROTO_ACCESS_DENIED',
  'MTPROTO_NOT_CONFIGURED',
  'TMDB_UNAVAILABLE',
  'TMDB_NOT_FOUND',
  'JELLYFIN_UNAVAILABLE',
  'JELLYFIN_AUTH_FAILED',
  'JELLYFIN_SCAN_FAILED',
  'DISK_FULL',
  'DISK_PERMISSION_DENIED',
  'DISK_IO_ERROR',
  'QUOTA_EXCEEDED',
  'INVALID_MEDIA',
  'DUPLICATE_MEDIA',
  'MULTIPART_INCOMPLETE',
  'MULTIPART_CORRUPT',
  'DATABASE_ERROR',
  'PATH_REJECTED',
  'CANCELLED',
  'UNKNOWN_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * How much an operator should care.
 *
 * `expected` covers the failures that are part of normal operation — a
 * duplicate, a cancellation, a quota refusal. Alerting on those trains people
 * to ignore alerts.
 */
export type ErrorSeverity = 'expected' | 'warning' | 'error' | 'critical';

export interface Classified {
  code: ErrorCode;
  retryable: boolean;
  severity: ErrorSeverity;
  /** Safe for the person who sent the file. Never contains internals. */
  userMessage: string;
  /** What an administrator needs. Still never contains secrets. */
  adminMessage: string;
  /** What to do about it, when there is something to do. */
  action?: string;
}

interface Rule {
  code: ErrorCode;
  retryable: boolean;
  severity: ErrorSeverity;
  userMessage: string;
  action?: string;
}

export const RULES: Record<ErrorCode, Rule> = {
  TELEGRAM_TIMEOUT: {
    code: 'TELEGRAM_TIMEOUT',
    retryable: true,
    severity: 'warning',
    userMessage: 'Telegram took too long to send the file. This will be retried automatically.',
  },
  TELEGRAM_FILE_NOT_FOUND: {
    code: 'TELEGRAM_FILE_NOT_FOUND',
    retryable: false,
    severity: 'warning',
    userMessage: 'Telegram no longer has this file. Please send it again.',
    action: 'Ask the sender to re-send the file.',
  },
  TELEGRAM_FILE_TOO_BIG: {
    code: 'TELEGRAM_FILE_TOO_BIG',
    retryable: false,
    severity: 'expected',
    userMessage: 'This file is larger than Telegram will hand to a bot.',
    action: 'Forward it instead so it is fetched over MTProto, or split it.',
  },
  TELEGRAM_UNAVAILABLE: {
    code: 'TELEGRAM_UNAVAILABLE',
    retryable: true,
    severity: 'error',
    userMessage: 'Telegram is unreachable at the moment. This will be retried automatically.',
    action: 'Check that the local Bot API container is running.',
  },
  MTPROTO_TIMEOUT: {
    code: 'MTPROTO_TIMEOUT',
    retryable: true,
    severity: 'warning',
    userMessage: 'The download stalled. This will be retried automatically.',
  },
  MTPROTO_DOWNLOAD_FAILED: {
    code: 'MTPROTO_DOWNLOAD_FAILED',
    retryable: true,
    severity: 'warning',
    userMessage: 'The download was interrupted. This will be retried automatically.',
  },
  MTPROTO_NOT_AUTHORISED: {
    code: 'MTPROTO_NOT_AUTHORISED',
    retryable: false,
    severity: 'critical',
    userMessage: 'Large-file ingestion is not available right now.',
    action: 'The MTProto session is missing or expired: run npm run telegram:mtproto:setup.',
  },
  MTPROTO_ACCESS_DENIED: {
    code: 'MTPROTO_ACCESS_DENIED',
    retryable: false,
    severity: 'expected',
    userMessage: 'That file cannot be reached from the linked Telegram account.',
    action: 'The account must be able to open the source chat.',
  },
  MTPROTO_NOT_CONFIGURED: {
    code: 'MTPROTO_NOT_CONFIGURED',
    retryable: false,
    severity: 'critical',
    userMessage: 'Large-file ingestion is not configured on this server.',
    action: 'Set MTPROTO_OWNER_TELEGRAM_ID and complete the MTProto setup.',
  },
  TMDB_UNAVAILABLE: {
    code: 'TMDB_UNAVAILABLE',
    retryable: true,
    severity: 'warning',
    userMessage: 'Could not reach the metadata service. The file was still saved.',
    action: 'Check TMDB_API_KEY and outbound network access.',
  },
  TMDB_NOT_FOUND: {
    code: 'TMDB_NOT_FOUND',
    retryable: false,
    severity: 'expected',
    userMessage: 'No metadata match was found, so the filename was used instead.',
    action: 'Rename the file closer to its release title and re-send it.',
  },
  JELLYFIN_UNAVAILABLE: {
    code: 'JELLYFIN_UNAVAILABLE',
    retryable: true,
    severity: 'error',
    userMessage: 'Saved. Jellyfin is unreachable, so it has not been indexed yet.',
    action: 'Check that Jellyfin is running, then use Retry Jellyfin.',
  },
  JELLYFIN_AUTH_FAILED: {
    code: 'JELLYFIN_AUTH_FAILED',
    retryable: false,
    severity: 'critical',
    userMessage: 'Saved. It could not be added to the library.',
    action: 'The Jellyfin API key is rejected: run npm run jellyfin:bootstrap.',
  },
  JELLYFIN_SCAN_FAILED: {
    code: 'JELLYFIN_SCAN_FAILED',
    retryable: true,
    severity: 'warning',
    userMessage: 'Saved. Jellyfin has not indexed it yet; it will appear after the next scan.',
    action: 'Use Retry Jellyfin, or check library permissions with npm run media:repair.',
  },
  DISK_FULL: {
    code: 'DISK_FULL',
    retryable: true,
    severity: 'critical',
    userMessage: 'The server is out of storage. Please try again later.',
    action: 'Free space on the media filesystem.',
  },
  DISK_PERMISSION_DENIED: {
    code: 'DISK_PERMISSION_DENIED',
    retryable: false,
    severity: 'critical',
    userMessage: 'The server could not write the file.',
    action: 'Check media tree ownership: npm run media:repair.',
  },
  DISK_IO_ERROR: {
    code: 'DISK_IO_ERROR',
    retryable: true,
    severity: 'critical',
    userMessage: 'A storage error interrupted this upload.',
    action: 'Check the disk health; this host has previously reported bad sectors.',
  },
  QUOTA_EXCEEDED: {
    code: 'QUOTA_EXCEEDED',
    retryable: false,
    severity: 'expected',
    userMessage: 'Your storage quota is full.',
    action: 'Raise the quota or remove some media.',
  },
  INVALID_MEDIA: {
    code: 'INVALID_MEDIA',
    retryable: false,
    severity: 'expected',
    userMessage: 'That file is not a video this server accepts.',
  },
  DUPLICATE_MEDIA: {
    code: 'DUPLICATE_MEDIA',
    retryable: false,
    severity: 'expected',
    userMessage: 'This media is already in the library.',
  },
  MULTIPART_INCOMPLETE: {
    code: 'MULTIPART_INCOMPLETE',
    retryable: false,
    severity: 'expected',
    userMessage: 'Some parts of this upload are missing.',
    action: 'Send the missing parts, then use /finish.',
  },
  MULTIPART_CORRUPT: {
    code: 'MULTIPART_CORRUPT',
    retryable: true,
    severity: 'warning',
    userMessage: 'The reassembled file did not match its parts.',
    action: 'The parts are kept; retrying reassembles them.',
  },
  DATABASE_ERROR: {
    code: 'DATABASE_ERROR',
    retryable: true,
    severity: 'critical',
    userMessage: 'The server hit a temporary problem. This will be retried automatically.',
    action: 'Check that the database container is running.',
  },
  PATH_REJECTED: {
    code: 'PATH_REJECTED',
    retryable: false,
    severity: 'critical',
    userMessage: 'That filename was rejected.',
    action: 'A path escaped the media root; this is a bug or an attack. Check the logs.',
  },
  CANCELLED: {
    code: 'CANCELLED',
    retryable: false,
    severity: 'expected',
    userMessage: 'Cancelled.',
  },
  UNKNOWN_ERROR: {
    code: 'UNKNOWN_ERROR',
    retryable: true,
    severity: 'error',
    userMessage: 'This is a server-side problem, not something you did. The administrator has been notified.',
  },
};

/** errno values that mean the same thing wherever they come from. */
const ERRNO: Record<string, ErrorCode> = {
  ENOSPC: 'DISK_FULL',
  EDQUOT: 'DISK_FULL',
  EACCES: 'DISK_PERMISSION_DENIED',
  EPERM: 'DISK_PERMISSION_DENIED',
  EROFS: 'DISK_PERMISSION_DENIED',
  EIO: 'DISK_IO_ERROR',
  ECONNREFUSED: 'TELEGRAM_UNAVAILABLE',
  ECONNRESET: 'TELEGRAM_UNAVAILABLE',
  ETIMEDOUT: 'TELEGRAM_TIMEOUT',
};

function nameOf(err: unknown): string {
  return (err as { name?: string } | undefined)?.name ?? '';
}

function messageOf(err: unknown): string {
  return String((err as { message?: unknown } | undefined)?.message ?? '');
}

/**
 * Pick the code for an error.
 *
 * Ordered from the most specific signal to the least: an explicit code an
 * error already carries, then its class, then an errno, then the wording. The
 * wording check is last because it is the least reliable — it exists so a
 * failure from a dependency that invents its own error shape still lands
 * somewhere useful rather than in UNKNOWN_ERROR.
 */
export function codeFor(err: unknown): ErrorCode {
  if (err === null || err === undefined) return 'UNKNOWN_ERROR';

  const explicit = (err as { errorCode?: unknown }).errorCode;
  if (typeof explicit === 'string' && (ERROR_CODES as readonly string[]).includes(explicit)) {
    return explicit as ErrorCode;
  }

  const name = nameOf(err);
  const message = messageOf(err);
  const errno = (err as { code?: unknown }).code;

  if (name === 'DownloadCancelledError' || name === 'CancelledError' || name === 'MtprotoCancelledError') {
    return 'CANCELLED';
  }
  if (name === 'AssemblyCancelledError') return 'CANCELLED';
  if (name === 'PathEscapeError') return 'PATH_REJECTED';
  if (name === 'MtprotoStalledError') return 'MTPROTO_TIMEOUT';
  if (name === 'TimeoutError' || name === 'AbortError') return 'TELEGRAM_TIMEOUT';

  if (typeof errno === 'string' && ERRNO[errno]) return ERRNO[errno]!;
  // node-postgres surfaces SQLSTATE as a five-character code.
  if (typeof errno === 'string' && /^[0-9A-Z]{5}$/.test(errno)) return 'DATABASE_ERROR';

  if (name === 'TelegramFileError') {
    if (/too big/i.test(message)) return 'TELEGRAM_FILE_TOO_BIG';
    // "wrong file_id or the file is temporarily unavailable" is the local Bot
    // API server's wording for a fetch that faltered, not for a bad id.
    if (/temporarily unavailable/i.test(message)) return 'TELEGRAM_UNAVAILABLE';
    if (/not found|no file path|logged out|wrong file_id/i.test(message)) return 'TELEGRAM_FILE_NOT_FOUND';
    if (/did not make the file available|timed out|timeout|aborted/i.test(message)) return 'TELEGRAM_TIMEOUT';
    return 'TELEGRAM_UNAVAILABLE';
  }

  if (name === 'MtprotoError') {
    const kind = (err as { kind?: unknown }).kind;
    if (kind === 'auth') return 'MTPROTO_NOT_AUTHORISED';
    if (kind === 'access') return 'MTPROTO_ACCESS_DENIED';
    if (kind === 'not-found') return 'TELEGRAM_FILE_NOT_FOUND';
    if (kind === 'config') return 'MTPROTO_NOT_CONFIGURED';
    if (/stall|timeout/i.test(message)) return 'MTPROTO_TIMEOUT';
    return 'MTPROTO_DOWNLOAD_FAILED';
  }

  if (name === 'JellyfinError') {
    const status = (err as { status?: unknown }).status;
    if (status === 401 || status === 403) return 'JELLYFIN_AUTH_FAILED';
    if (typeof status === 'number' && status >= 500) return 'JELLYFIN_UNAVAILABLE';
    if (/fetch failed|ECONNREFUSED|network/i.test(message)) return 'JELLYFIN_UNAVAILABLE';
    return 'JELLYFIN_SCAN_FAILED';
  }

  if (name === 'MultipartError' || name === 'AssemblyError') {
    if (/missing part/i.test(message)) return 'MULTIPART_INCOMPLETE';
    if (/did not match|checksum|corrupt/i.test(message)) return 'MULTIPART_CORRUPT';
    return 'INVALID_MEDIA';
  }

  // Wording of last resort, for pipeline errors that wrap something opaque.
  if (/quota/i.test(message)) return 'QUOTA_EXCEEDED';
  if (/duplicate/i.test(message)) return 'DUPLICATE_MEDIA';
  if (/no video stream|not a video|unsupported file type/i.test(message)) return 'INVALID_MEDIA';
  if (/disk space|storage/i.test(message)) return 'DISK_FULL';
  if (/jellyfin/i.test(message)) return 'JELLYFIN_SCAN_FAILED';
  if (/tmdb/i.test(message)) return 'TMDB_UNAVAILABLE';

  // A wrapper that kept what it wrapped — a PipelineError around a Telegram
  // failure, say — is classified by the thing inside it rather than by the
  // wrapper's own, uninformative shape.
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== null && cause !== err) return codeFor(cause);

  return 'UNKNOWN_ERROR';
}

/** Whether anyone is listening when a message says "the administrator has been notified". */
function adminReachable(): boolean {
  return config.telegram.adminChatId.trim().length > 0;
}

/**
 * Classify a failure.
 *
 * An error that already states its own retryability keeps it: those flags
 * encode decisions the throw site understood better than a table can, and
 * overriding them would change behaviour this is meant to describe, not alter.
 */
export function classify(err: unknown): Classified {
  const code = codeFor(err);
  const rule = RULES[code];

  const declared = (err as { retryable?: unknown } | undefined)?.retryable;
  const retryable = typeof declared === 'boolean' ? declared : rule.retryable;

  // A user-facing message the throw site wrote is better than a generic one.
  const own = (err as { userMessage?: unknown } | undefined)?.userMessage;
  let userMessage = typeof own === 'string' && own.length > 0 ? own : rule.userMessage;
  // Never promise a notification that will be discarded for want of a
  // configured admin chat.
  if (code === 'UNKNOWN_ERROR' && userMessage === rule.userMessage && !adminReachable()) {
    userMessage = 'This is a server-side problem, not something you did.';
  }

  return {
    code,
    retryable,
    severity: rule.severity,
    userMessage,
    adminMessage: messageOf(err) || rule.userMessage,
    ...(rule.action ? { action: rule.action } : {}),
  };
}

/** Whether a failure is worth waking someone for. */
export function isAlertable(code: ErrorCode): boolean {
  return RULES[code].severity === 'critical';
}
