import { query } from '../db/pool.js';
import { ACTIVE_SESSION_STATUSES, TERMINAL_STATUSES } from '../db/types.js';
import type { UserRow } from '../db/types.js';
import { formatBytes } from './storage.js';

/**
 * Per-user storage quotas.
 *
 * `users.quota_bytes` has existed, been editable in the dashboard, and been
 * enforced nowhere — so an administrator could set a limit and believe it
 * applied. A control that silently does nothing is worse than no control,
 * because it is trusted.
 *
 * Usage is counted from `media.file_size`, the same figure the storage page
 * reports, so what the dashboard shows and what the quota enforces can never
 * disagree.
 */

export interface QuotaStatus {
  /** Null means unlimited: no quota was ever set for this user. */
  quotaBytes: number | null;
  /** Bytes already filed into this user's library. */
  usedBytes: number;
  /** Bytes committed to uploads that are accepted but not yet filed. */
  reservedBytes: number;
  /** Null when unlimited. Never negative. */
  remainingBytes: number | null;
  /** 0–100, or null when unlimited. */
  percentUsed: number | null;
}

export interface QuotaDecision {
  ok: boolean;
  status: QuotaStatus;
  /** User-facing explanation, present only when `ok` is false. */
  reason?: string;
}

/**
 * What a user has used, and what is already promised.
 *
 * `reservedBytes` is the part that makes concurrency safe. Filed media alone
 * would let two uploads that each fit individually both be accepted and
 * together blow through the limit, because neither is counted until it lands.
 * In-flight uploads are therefore charged against the quota from the moment
 * they are accepted.
 */
export async function quotaStatus(user: UserRow): Promise<QuotaStatus> {
  // Reserved: every upload that has not reached a terminal status, plus every
  // multi-part session still collecting or assembling that has not yet become
  // an upload — its declared size is the only record of what is on its way.
  // The status lists are the shared constants, so a status added later (as
  // NEEDS_REVIEW was) cannot leave this query counting a finished upload as
  // still in flight.
  const { rows } = await query<{ used: string; reserved: string }>(
    `SELECT
       (SELECT COALESCE(SUM(file_size), 0) FROM media WHERE user_id = $1)::text AS used,
       ((SELECT COALESCE(SUM(file_size), 0) FROM uploads
          WHERE user_id = $1
            AND NOT (status = ANY($2::text[])))
        + (SELECT COALESCE(SUM(expected_bytes), 0) FROM upload_sessions
            WHERE user_id = $1
              AND upload_id IS NULL
              AND status = ANY($3::text[])))::text AS reserved`,
    [user.id, TERMINAL_STATUSES as readonly string[], ACTIVE_SESSION_STATUSES as readonly string[]],
  );

  const usedBytes = Number(rows[0]?.used ?? 0);
  const reservedBytes = Number(rows[0]?.reserved ?? 0);
  const quotaBytes = user.quota_bytes && user.quota_bytes > 0 ? user.quota_bytes : null;

  return {
    quotaBytes,
    usedBytes,
    reservedBytes,
    remainingBytes: quotaBytes === null ? null : Math.max(0, quotaBytes - usedBytes - reservedBytes),
    percentUsed:
      quotaBytes === null ? null : Math.min(100, ((usedBytes + reservedBytes) / quotaBytes) * 100),
  };
}

/**
 * Whether a user may accept another `incomingBytes` of media.
 *
 * Checked before anything expensive starts, so a user over quota is told
 * immediately rather than after a multi-gigabyte transfer.
 */
export async function checkQuota(user: UserRow, incomingBytes: number): Promise<QuotaDecision> {
  const status = await quotaStatus(user);
  if (status.quotaBytes === null) return { ok: true, status };

  const wouldUse = status.usedBytes + status.reservedBytes + Math.max(0, incomingBytes);
  if (wouldUse <= status.quotaBytes) return { ok: true, status };

  const pending = status.reservedBytes > 0 ? ` (${formatBytes(status.reservedBytes)} already in flight)` : '';
  return {
    ok: false,
    status,
    reason:
      `Your storage quota is full.\n\n` +
      `Used: ${formatBytes(status.usedBytes + status.reservedBytes)} of ${formatBytes(status.quotaBytes)}${pending}\n` +
      `This file: ${formatBytes(incomingBytes)}\n` +
      `Free space needed: ${formatBytes(wouldUse - status.quotaBytes)}`,
  };
}
