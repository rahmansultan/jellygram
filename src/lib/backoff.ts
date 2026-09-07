/**
 * Retry delays.
 *
 * The schedule was linear — `base * attempt`, giving 30s, 60s, 90s — which
 * barely backs off at all: a service that is down stays down through all three
 * attempts, and the upload fails having waited three minutes. Doubling instead
 * gives a genuinely failing dependency time to come back, while keeping the
 * first retry quick for the transient blip that is the common case.
 */

export interface BackoffOptions {
  /** Delay before the first retry. */
  baseMs: number;
  /** Never wait longer than this, however many attempts have been made. */
  maxMs: number;
  /** Random spread, as a fraction. 0.2 means ±20%. */
  jitter?: number;
}

/**
 * Delay before the next attempt, after `attempt` failures.
 *
 * Jitter matters even with one worker: several uploads failing against the
 * same dead dependency would otherwise all wake at the same instant and fail
 * together, turning one outage into a series of synchronised retry storms.
 */
export function backoffMs(attempt: number, opts: BackoffOptions): number {
  const n = Math.max(1, Math.floor(attempt));
  // Capped before jitter so the spread applies to the value actually used.
  const exponential = Math.min(opts.maxMs, opts.baseMs * 2 ** (n - 1));
  const jitter = opts.jitter ?? 0.2;
  if (jitter <= 0) return Math.round(exponential);

  const spread = exponential * jitter;
  const value = exponential - spread + Math.random() * spread * 2;
  // Never below the base: a retry that comes back instantly is not a retry.
  return Math.round(Math.max(Math.min(opts.baseMs, exponential), Math.min(opts.maxMs, value)));
}
