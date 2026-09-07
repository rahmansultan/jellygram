/**
 * A per-address ceiling on request rate, for the surface that faces the open
 * internet.
 *
 * This is not the login throttle — that one counts *failures* and exists to
 * make guessing a credential hopeless. This counts *everything*, and exists
 * because a publicly reachable port is scanned continuously by machines that
 * have no credential to guess and no interest in one: they are looking for a
 * path that answers, and each attempt costs this host a database round trip it
 * did not choose to make.
 *
 * The ceiling is set far above anything a person produces. Opening the library
 * loads a page of posters at once, an upload sends a part every few seconds,
 * and the transfers view polls while it is on screen; all of that together
 * stays an order of magnitude below the limit. Anything that reaches it is not
 * reading a media library.
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 600;

/**
 * Above this many tracked addresses the table is swept, and if a sweep frees
 * nothing it is dropped entirely. Without a bound the table is itself the
 * denial of service: one packet per forged source address is all it would take
 * to grow it without limit.
 */
const MAX_TRACKED = 10_000;

interface Window {
  count: number;
  startedAt: number;
}

const windows = new Map<string, Window>();

function sweep(now: number): void {
  for (const [key, window] of windows) {
    if (now - window.startedAt > WINDOW_MS) windows.delete(key);
  }
  if (windows.size > MAX_TRACKED) windows.clear();
}

export interface FloodVerdict {
  allowed: boolean;
  retryAfterSec: number;
}

/** Count one request from `key`, and say whether it may proceed. */
export function admitRequest(key: string, now = Date.now()): FloodVerdict {
  if (windows.size >= MAX_TRACKED) sweep(now);

  const window = windows.get(key);
  if (!window || now - window.startedAt > WINDOW_MS) {
    windows.set(key, { count: 1, startedAt: now });
    return { allowed: true, retryAfterSec: 0 };
  }

  window.count += 1;
  if (window.count > MAX_PER_WINDOW) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((WINDOW_MS - (now - window.startedAt)) / 1000)),
    };
  }
  return { allowed: true, retryAfterSec: 0 };
}

/** Test seam. Never called in production, where the process is the lifetime. */
export function resetFloodState(): void {
  windows.clear();
}

export const FLOOD_LIMITS = { WINDOW_MS, MAX_PER_WINDOW, MAX_TRACKED } as const;
