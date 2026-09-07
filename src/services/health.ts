import { config } from '../config/index.js';
import { getLogger } from '../lib/logger.js';
import { pingDatabase, query } from '../db/pool.js';
import * as jf from './jellyfin.js';
import { diskUsage, formatBytes, formatDuration } from './storage.js';

/**
 * The conditions worth waking someone for, in one place.
 *
 * The dashboard already showed whether each dependency answered; what it could
 * not do was say a condition had *become* bad. Nothing watched free disk until
 * an upload was refused, and nothing noticed a backup had stopped running. A
 * check here is used by both the status endpoint and the worker's alerting
 * sweep, so the two can never disagree about what "healthy" means.
 */

export type HealthState = 'ok' | 'warn' | 'down' | 'unknown';

export interface HealthCheck {
  id: string;
  label: string;
  state: HealthState;
  /** One sentence, safe to show anywhere. Never contains a secret. */
  detail: string;
  /** Present when there is something an operator should do. */
  action?: string;
}

/** Ordered worst-first, so the most serious thing is the first thing seen. */
const RANK: Record<HealthState, number> = { down: 0, warn: 1, unknown: 2, ok: 3 };

export function worstState(checks: HealthCheck[]): HealthState {
  return checks.reduce<HealthState>((worst, c) => (RANK[c.state] < RANK[worst] ? c.state : worst), 'ok');
}

/**
 * Whether a state change is worth telling somebody about.
 *
 * Alerting every tick is how a channel gets muted, so a message is sent only
 * when a check *changes*: worse in either direction from ok, or back to ok.
 * The recovery message is what makes the alert trustworthy — without it,
 * silence is ambiguous rather than reassuring.
 *
 * `unknown` never alerts on its own. A check that cannot run says nothing
 * about whether the thing it watches is broken, and treating "I could not
 * look" as "it is down" produces false alarms during startup.
 */
export function alertFor(previous: HealthState, current: HealthState): 'worsened' | 'recovered' | null {
  if (previous === current) return null;
  if (current === 'unknown' || previous === 'unknown') {
    // Only a move into a genuinely bad state is worth a message here.
    return current === 'down' ? 'worsened' : null;
  }
  if (current === 'down') return 'worsened';
  if (current === 'warn' && previous === 'ok') return 'worsened';
  if (current === 'ok') return 'recovered';
  return null;
}

async function checkDisk(): Promise<HealthCheck> {
  try {
    const { availableBytes, totalBytes } = await diskUsage(config.storage.mediaRoot);
    const floor = config.storage.minFreeDiskBytes;
    const detail = `${formatBytes(availableBytes)} free of ${formatBytes(totalBytes)}`;

    // Below the floor every upload is already being refused; the warning
    // threshold sits above it so there is time to act before that happens.
    if (availableBytes < floor) {
      return {
        id: 'disk',
        label: 'Disk',
        state: 'down',
        detail: `${detail} — below the ${formatBytes(floor)} floor, so uploads are being refused`,
        action: 'Free space on the media filesystem.',
      };
    }
    if (availableBytes < floor * 2) {
      return {
        id: 'disk',
        label: 'Disk',
        state: 'warn',
        detail: `${detail} — approaching the ${formatBytes(floor)} floor`,
        action: 'Free space before uploads start being refused.',
      };
    }
    return { id: 'disk', label: 'Disk', state: 'ok', detail };
  } catch (err) {
    return { id: 'disk', label: 'Disk', state: 'unknown', detail: (err as Error).message };
  }
}

async function checkBackup(): Promise<HealthCheck> {
  try {
    const { rows } = await query<{ status: string; started_at: Date; error_message: string | null }>(
      'SELECT status, started_at, error_message FROM backups ORDER BY id DESC LIMIT 1',
    );
    const last = rows[0];
    if (!last) {
      return {
        id: 'backup',
        label: 'Backup',
        state: 'warn',
        detail: 'No backup has ever run',
        action: 'Check that the jellygram-backup.timer is enabled.',
      };
    }

    const ageMs = Date.now() - new Date(last.started_at).getTime();
    const staleMs = config.backup.staleHours * 60 * 60 * 1000;

    if (last.status === 'FAILED') {
      return {
        id: 'backup',
        label: 'Backup',
        state: 'down',
        detail: `The last backup failed ${formatDuration(ageMs)} ago`,
        action: 'Run npm run db:backup to see why.',
      };
    }
    if (ageMs > staleMs) {
      return {
        id: 'backup',
        label: 'Backup',
        state: 'warn',
        detail: `The last backup was ${formatDuration(ageMs)} ago`,
        action: 'Check systemctl --user list-timers jellygram-backup.timer.',
      };
    }
    return { id: 'backup', label: 'Backup', state: 'ok', detail: `Last backup ${formatDuration(ageMs)} ago` };
  } catch (err) {
    return { id: 'backup', label: 'Backup', state: 'unknown', detail: (err as Error).message };
  }
}

async function checkDatabase(): Promise<HealthCheck> {
  const ok = await pingDatabase().catch(() => false);
  return ok
    ? { id: 'database', label: 'Database', state: 'ok', detail: 'Responding' }
    : {
        id: 'database',
        label: 'Database',
        state: 'down',
        detail: 'Not responding',
        action: 'Check that PostgreSQL is running and DATABASE_URL is correct.',
      };
}

async function checkJellyfin(): Promise<HealthCheck> {
  if (!config.jellyfin.configured) {
    return { id: 'jellyfin', label: 'Jellyfin', state: 'unknown', detail: 'No API key configured' };
  }
  try {
    const status = await jf.status();
    if (!status.reachable) {
      return {
        id: 'jellyfin',
        label: 'Jellyfin',
        state: 'down',
        detail: status.message,
        action: 'Check that the Jellyfin service is running.',
      };
    }
    if (!status.authenticated) {
      return {
        id: 'jellyfin',
        label: 'Jellyfin',
        state: 'down',
        detail: 'Reachable but the API key was rejected',
        action: 'Run npm run jellyfin:bootstrap.',
      };
    }
    return { id: 'jellyfin', label: 'Jellyfin', state: 'ok', detail: status.message };
  } catch (err) {
    return { id: 'jellyfin', label: 'Jellyfin', state: 'down', detail: (err as Error).message };
  }
}

async function checkTelegram(): Promise<HealthCheck> {
  if (!config.telegram.configured) {
    return { id: 'telegram', label: 'Telegram', state: 'unknown', detail: 'No bot token configured' };
  }
  try {
    const res = await fetch(`${config.telegram.apiRoot}/bot${config.telegram.botToken}/getMe`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (body.ok) {
      return {
        id: 'telegram',
        label: 'Telegram',
        state: 'ok',
        detail: config.telegram.localMode ? 'Local Bot API responding' : 'Bot API responding',
      };
    }
    return {
      id: 'telegram',
      label: 'Telegram',
      state: 'down',
      // The description can echo the request; the logger scrubs it, and only
      // the reason is kept here.
      detail: body.description?.slice(0, 120) ?? `HTTP ${res.status}`,
      action: config.telegram.localMode ? 'docker start jellygram-botapi' : 'Check the bot token.',
    };
  } catch (err) {
    return {
      id: 'telegram',
      label: 'Telegram',
      state: 'down',
      detail: (err as Error).message.slice(0, 120),
      action: config.telegram.localMode ? 'docker start jellygram-botapi' : undefined,
    };
  }
}

/**
 * Repeated failures in the recent past.
 *
 * One failure is an event; several in an hour is a condition. Counted from the
 * uploads table rather than the logs so it survives a log rotation.
 */
async function checkFailureRate(): Promise<HealthCheck> {
  try {
    const { rows } = await query<{ failed: string; total: string }>(
      `SELECT
         count(*) FILTER (WHERE status = 'FAILED')::text AS failed,
         count(*)::text AS total
       FROM uploads
       WHERE updated_at > now() - interval '1 hour'`,
    );
    const failed = Number(rows[0]?.failed ?? 0);
    const total = Number(rows[0]?.total ?? 0);

    if (failed >= 3) {
      return {
        id: 'failures',
        label: 'Upload failures',
        state: 'warn',
        detail: `${failed} of ${total} uploads failed in the last hour`,
        action: 'Run npm run upload:diagnose -- --failed.',
      };
    }
    return {
      id: 'failures',
      label: 'Upload failures',
      state: 'ok',
      detail: failed === 0 ? 'None in the last hour' : `${failed} in the last hour`,
    };
  } catch (err) {
    return { id: 'failures', label: 'Upload failures', state: 'unknown', detail: (err as Error).message };
  }
}

/**
 * Whether anyone would actually receive an alert.
 *
 * Every check above is pointless if there is nowhere to send the result:
 * `notifyAdmin` silently does nothing without an admin chat id, so a system
 * with alerting configured and a system with alerting disabled look identical
 * from the outside. This is the one check that reports on the reporting.
 */
function checkNotifications(): HealthCheck {
  if (config.telegram.adminChatId.trim()) {
    return { id: 'alerts', label: 'Alerts', state: 'ok', detail: 'Admin notifications are configured' };
  }
  return {
    id: 'alerts',
    label: 'Alerts',
    state: 'warn',
    detail: 'No admin chat is configured, so health alerts are not delivered anywhere',
    action: 'Set TELEGRAM_ADMIN_CHAT_ID in .env to receive them.',
  };
}

/** Every check, run concurrently. Never throws. */
export async function runHealthChecks(): Promise<HealthCheck[]> {
  const checks = await Promise.all([
    checkDatabase(),
    checkDisk(),
    checkTelegram(),
    checkJellyfin(),
    checkBackup(),
    checkFailureRate(),
    Promise.resolve(checkNotifications()),
  ]).catch((err) => {
    getLogger().warn({ err }, 'Health checks failed');
    return [] as HealthCheck[];
  });

  return checks.sort((a, b) => RANK[a.state] - RANK[b.state]);
}
