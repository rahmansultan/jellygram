import { formatBytes, formatDuration } from './storage.js';

/**
 * The progress model: stages, rolling transfer rate, and rendering.
 *
 * Deliberately free of Telegram, the database and the filesystem so the whole
 * thing is unit-testable. `ProgressReporter` in notifier.ts owns the I/O and
 * the rate limiting; this owns what a user actually sees.
 *
 * Two rules shape everything here:
 *
 *   1. No invented numbers. A percentage is either byte-accurate (`bytes` and
 *      `total` are both known) or it is stage-accurate — how far through the
 *      pipeline the upload is. The line under the bar always says which,
 *      so the two are never mistaken for each other.
 *   2. Nothing throws. Progress reporting sits on the critical path of an
 *      upload and must never be the reason one fails.
 */

export const STAGES = [
  'RECEIVING',
  'QUEUED',
  'FETCHING',
  'DOWNLOADING',
  'ASSEMBLING',
  'IDENTIFYING',
  'TMDB',
  'ORGANIZING',
  'JELLYFIN_SCAN',
  'JELLYFIN_VERIFY',
  'COMPLETE',
] as const;

export type Stage = (typeof STAGES)[number];

interface StageInfo {
  /** Heading shown while this stage is current. */
  title: string;
  icon: string;
  /** Line in the checklist. Absent for stages not worth listing. */
  step?: string;
  /** True when the stage moves bytes and can report a real byte percentage. */
  transfer?: boolean;
}

const STAGE_INFO: Record<Stage, StageInfo> = {
  RECEIVING: { title: 'Receiving', icon: '\u{1F4E5}', step: 'Receiving' },
  QUEUED: { title: 'Queued', icon: '\u{23F3}', step: 'Waiting for a worker' },
  FETCHING: { title: 'Fetching from Telegram', icon: '\u{2B07}\u{FE0F}', step: 'Fetching from Telegram', transfer: true },
  DOWNLOADING: { title: 'Downloading', icon: '\u{2B07}\u{FE0F}', step: 'Downloading', transfer: true },
  ASSEMBLING: { title: 'Assembling parts', icon: '\u{1F9E9}', step: 'Assembling parts', transfer: true },
  IDENTIFYING: { title: 'Identifying', icon: '\u{1F50E}', step: 'Identifying movie' },
  TMDB: { title: 'TMDB lookup', icon: '\u{1F3AC}', step: 'TMDB lookup' },
  ORGANIZING: { title: 'Organizing', icon: '\u{1F4C1}', step: 'Organizing files' },
  JELLYFIN_SCAN: { title: 'Jellyfin', icon: '\u{1F4FA}', step: 'Scanning Jellyfin library' },
  JELLYFIN_VERIFY: { title: 'Jellyfin', icon: '\u{1F50D}', step: 'Verifying visibility' },
  COMPLETE: { title: 'Complete', icon: '\u{2705}' },
};

/** Every stage that can appear in a checklist, in pipeline order. */
const ALL_STEPS: Stage[] = STAGES.filter((s) => STAGE_INFO[s].step !== undefined);

/**
 * The ingestion routes, which decide which steps an upload actually performs.
 *
 * Listing steps a route never runs would be a lie of a quieter kind than a
 * fake percentage, but a lie all the same: a normal Bot API upload never
 * assembles parts, and a direct upload is never fetched from Telegram.
 */
export type Route = 'telegram-local' | 'telegram-cloud' | 'mtproto' | 'multipart' | 'direct';

const ROUTE_STEPS: Record<Route, Stage[]> = {
  // The server fetches from Telegram, then the file is taken from its
  // directory — two genuinely distinct steps.
  'telegram-local': ['RECEIVING', 'QUEUED', 'FETCHING', 'DOWNLOADING', 'IDENTIFYING', 'TMDB', 'ORGANIZING', 'JELLYFIN_SCAN', 'JELLYFIN_VERIFY'],
  'telegram-cloud': ['RECEIVING', 'QUEUED', 'DOWNLOADING', 'IDENTIFYING', 'TMDB', 'ORGANIZING', 'JELLYFIN_SCAN', 'JELLYFIN_VERIFY'],
  mtproto: ['RECEIVING', 'QUEUED', 'DOWNLOADING', 'IDENTIFYING', 'TMDB', 'ORGANIZING', 'JELLYFIN_SCAN', 'JELLYFIN_VERIFY'],
  multipart: ['RECEIVING', 'QUEUED', 'ASSEMBLING', 'IDENTIFYING', 'TMDB', 'ORGANIZING', 'JELLYFIN_SCAN', 'JELLYFIN_VERIFY'],
  direct: ['RECEIVING', 'QUEUED', 'ASSEMBLING', 'IDENTIFYING', 'TMDB', 'ORGANIZING', 'JELLYFIN_SCAN', 'JELLYFIN_VERIFY'],
};

export function stepsFor(route: Route | undefined): Stage[] {
  return route ? ROUTE_STEPS[route] : ALL_STEPS;
}

export function isTransferStage(stage: Stage): boolean {
  return STAGE_INFO[stage].transfer === true;
}

export function stageTitle(stage: Stage): string {
  return STAGE_INFO[stage].title;
}

/**
 * How far through the pipeline a stage sits, as a percentage.
 *
 * Real information — the position of this upload in a fixed sequence of steps
 * — not an interpolated guess at how long the remaining work will take.
 */
export function stagePercent(stage: Stage, steps: Stage[] = ALL_STEPS): number {
  if (stage === 'COMPLETE') return 100;
  const index = steps.indexOf(stage);
  if (index < 0) return 0;
  // The step in progress counts as half done: a bar that only moves once a
  // step *finishes* sits still for the whole of the longest one.
  return Math.round(((index + 0.5) / steps.length) * 100);
}

const BAR_WIDTH = 20;

export function progressBar(percent: number, width = BAR_WIDTH): string {
  const clamped = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  const filled = Math.round((clamped / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/**
 * A rolling transfer rate over a short window.
 *
 * A window rather than an exponential average because an EWMA started from a
 * cold start reads far too low for the first several samples, which is exactly
 * when the user is looking at the ETA. Samples older than `windowMs` are
 * dropped, so a stall visibly decays the rate instead of freezing it.
 */
export class RateMeter {
  private samples: Array<{ at: number; bytes: number }> = [];

  constructor(
    private readonly windowMs = 10_000,
    private readonly maxSamples = 32,
  ) {}

  record(bytes: number, now: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) return;
    const last = this.samples[this.samples.length - 1];
    // A rewind means a different transfer is being measured; start over rather
    // than reporting a negative rate.
    if (last && bytes < last.bytes) this.samples = [];
    this.samples.push({ at: now, bytes });

    const cutoff = now - this.windowMs;
    while (this.samples.length > 2 && this.samples[0] !== undefined && this.samples[0].at < cutoff) {
      this.samples.shift();
    }
    while (this.samples.length > this.maxSamples) this.samples.shift();
  }

  /** Bytes per second, or null until there is enough spread to be meaningful. */
  bytesPerSecond(): number | null {
    if (this.samples.length < 2) return null;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last) return null;
    const seconds = (last.at - first.at) / 1000;
    if (seconds < 0.5) return null;
    const rate = (last.bytes - first.bytes) / seconds;
    return rate > 0 ? rate : null;
  }

  reset(): void {
    this.samples = [];
  }
}

/** Seconds remaining, or null when it cannot be worked out honestly. */
export function etaSeconds(bytes: number, total: number, bytesPerSecond: number | null): number | null {
  if (bytesPerSecond === null || bytesPerSecond <= 0) return null;
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(bytes)) return null;
  const remaining = total - bytes;
  if (remaining <= 0) return 0;
  return remaining / bytesPerSecond;
}

export function percentOf(bytes: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  return Math.min(100, (bytes / total) * 100);
}

export interface ProgressView {
  stage: Stage;
  filename: string;
  /** Known only once identification has run. */
  title?: string | null;
  /** Bytes moved so far in the current transfer stage. */
  bytes?: number | null;
  /** Total bytes for the current transfer stage. */
  total?: number | null;
  bytesPerSecond?: number | null;
  etaSeconds?: number | null;
  /** Multi-part uploads: which piece is in flight. */
  part?: { index: number; count: number } | null;
  /** Real position in the queue while waiting for a worker. */
  queue?: { ahead: number; active: number } | null;
  /** Which steps this upload actually performs. */
  route?: Route;
  /** Extra line under the heading, e.g. why a fetch has no byte count yet. */
  note?: string | null;
  elapsedMs?: number | null;
}

/** Escape the characters Telegram's HTML parse mode cares about. */
function esc(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * The percentage to show, and what it measures.
 *
 * Byte-accurate whenever both counts are known; otherwise the stage position.
 * Never interpolated between the two.
 */
export function resolvePercent(view: ProgressView): { percent: number; byteAccurate: boolean } {
  if (isTransferStage(view.stage)) {
    const byBytes = percentOf(view.bytes ?? Number.NaN, view.total ?? Number.NaN);
    if (byBytes !== null) return { percent: byBytes, byteAccurate: true };
  }
  return { percent: stagePercent(view.stage, stepsFor(view.route)), byteAccurate: false };
}

/** The checklist of pipeline steps, marking done / current / pending. */
function renderChecklist(stage: Stage, steps: Stage[]): string {
  const current = steps.indexOf(stage);
  return steps.map((s, i) => {
    const label = STAGE_INFO[s].step ?? s;
    if (stage === 'COMPLETE' || i < current) return `✅ ${label}`;
    if (i === current) return `\u{1F504} <b>${label}…</b>`;
    return `▫️ ${label}`;
  }).join('\n');
}

/**
 * Render one progress message.
 *
 * Transfer stages get the bar, byte counts, rate and ETA. Processing stages
 * get the checklist instead, because there is no honest percentage for "how
 * far through a TMDB lookup" — the bar there tracks pipeline position, and the
 * line beneath it says so.
 */
export function renderProgress(view: ProgressView): string {
  const info = STAGE_INFO[view.stage];
  const { percent, byteAccurate } = resolvePercent(view);

  const lines: string[] = [];
  lines.push(`${info.icon} <b>${esc(info.title)}</b>`);
  lines.push(`<code>${esc(view.title ?? view.filename)}</code>`);
  lines.push('');

  if (view.part && view.part.count > 1) {
    lines.push(`\u{1F4E6} Part ${view.part.index}/${view.part.count}`);
  }

  // A queued upload has no percentage of its own to report, and saying so
  // plainly is what stops a wait looking like a hang.
  if (view.stage === 'QUEUED' && view.queue) {
    const { ahead, active } = view.queue;
    lines.push(
      ahead === 0
        ? '\u{1F4CD} Next in line'
        : `\u{1F4CD} Position ${ahead + 1} in the queue`,
    );
    lines.push(
      active > 0
        ? `<i>${active} upload${active === 1 ? '' : 's'} in progress ahead of this one.</i>`
        : '<i>Starting shortly.</i>',
    );
    if (view.elapsedMs && view.elapsedMs > 0) lines.push(`⏱️ waiting ${formatDuration(view.elapsedMs)}`);
    return lines.join('\n');
  }

  lines.push(`<code>${progressBar(percent)}</code> ${percent.toFixed(0)}%`);

  if (byteAccurate) {
    lines.push(`\u{1F4E6} ${formatBytes(view.bytes ?? 0)} / ${formatBytes(view.total ?? 0)}`);
    if (view.bytesPerSecond && view.bytesPerSecond > 0) {
      lines.push(`⚡ ${formatBytes(view.bytesPerSecond)}/s`);
    }
    if (view.etaSeconds !== null && view.etaSeconds !== undefined && view.etaSeconds > 0) {
      lines.push(`⏳ ETA ${formatDuration(view.etaSeconds * 1000)}`);
    }
  } else {
    // Says outright that this bar is pipeline position, not bytes.
    const steps = stepsFor(view.route);
    const at = Math.min(Math.max(steps.indexOf(view.stage) + 1, 1), steps.length);
    lines.push(`<i>step ${at} of ${steps.length}</i>`);
    lines.push('');
    lines.push(renderChecklist(view.stage, steps));
  }

  if (view.note) lines.push(`\n<i>${esc(view.note)}</i>`);
  if (view.elapsedMs !== null && view.elapsedMs !== undefined && view.elapsedMs > 0) {
    lines.push(`⏱️ ${formatDuration(view.elapsedMs)}`);
  }

  return lines.join('\n');
}

export { esc };
