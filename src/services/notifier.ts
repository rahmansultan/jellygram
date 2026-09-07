import { config } from '../config/index.js';
import { getLogger } from '../lib/logger.js';
import {
  type ProgressView,
  RateMeter,
  type Route,
  type Stage,
  etaSeconds,
  isTransferStage,
  percentOf,
  renderProgress,
  resolvePercent,
  stageTitle,
  esc,
} from './progress.js';

/**
 * Telegram messaging for the worker.
 *
 * The worker does not own the bot instance, so it talks to the Bot API
 * directly. Progress is delivered by *editing one message* rather than sending
 * a new one per update, and edits are rate-limited both by elapsed time and by
 * how much the percentage actually moved.
 */

const API = () => `${config.telegram.apiRoot}/bot${config.telegram.botToken}`;

async function callTelegram<T>(method: string, payload: Record<string, unknown>): Promise<T | null> {
  // Without a token there is nobody to talk to; the pipeline still runs and the
  // dashboard still shows progress.
  if (!config.telegram.configured) return null;
  try {
    const res = await fetch(`${API()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
    };
    if (!body.ok) {
      // "message is not modified" is expected whenever the rendered progress
      // bar has not visibly changed; it is not worth a warning.
      if (!/message is not modified/i.test(body.description ?? '')) {
        getLogger().warn({ method, description: body.description }, 'Telegram API call failed');
      }
      return null;
    }
    return body.result ?? null;
  } catch (err) {
    getLogger().warn({ err, method }, 'Telegram API call errored');
    return null;
  }
}

export async function sendMessage(
  chatId: number,
  text: string,
  opts: { replyTo?: number | null } = {},
): Promise<number | null> {
  const result = await callTelegram<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(opts.replyTo ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {}),
  });
  return result?.message_id ?? null;
}

export async function editMessage(chatId: number, messageId: number, text: string): Promise<boolean> {
  const result = await callTelegram<unknown>('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  return result !== null;
}

export { esc, progressBar } from './progress.js';

/**
 * Tell the sender an upload was cancelled before any worker ran it.
 *
 * The pipeline edits the progress message itself when it cancels a running
 * upload; a queued one has no pipeline, so the message would otherwise say
 * "Queued…" forever. Only for a row already made terminal, and never fatal.
 */
export async function announceCancelled(upload: {
  status: string;
  telegram_chat_id: number;
  progress_message_id: number | null;
  original_filename: string;
}): Promise<void> {
  if (upload.status !== 'CANCELLED' || upload.progress_message_id === null) return;
  await editMessage(
    upload.telegram_chat_id,
    upload.progress_message_id,
    `\u{1F6D1} <b>Upload cancelled</b>\n<code>${esc(upload.original_filename)}</code>`,
  ).catch(() => false);
}

/** What the dashboard shows and what a restarted worker resumes from. */
export interface ProgressSnapshot {
  stage: Stage;
  stageTitle: string;
  /**
   * The message being edited, once one exists.
   *
   * Persisting this is what stops a restarted worker sending a second progress
   * message: the reporter creates one only when it is handed null.
   */
  messageId: number | null;
  percent: number;
  /** False when the percentage is pipeline position rather than bytes. */
  byteAccurate: boolean;
  bytes: number | null;
  total: number | null;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
  part: { index: number; count: number } | null;
  elapsedMs: number;
}

/**
 * A single Telegram message, edited in place for the lifetime of one upload.
 *
 * One instance per upload. All mutable state — stage, byte counts, rate meter,
 * rate-limiting cursors — lives on the instance, and the chat id and message id
 * are constructor arguments, so two uploads running concurrently can never
 * write into each other's chat.
 *
 * Every method swallows its own failures: an upload must never fail because
 * Telegram was slow, rate-limited, or rejected an edit.
 */
/** How often a queued message whose position has not moved is re-edited. */
const QUEUE_CLOCK_REFRESH_MS = 60_000;

export class ProgressReporter {
  private stage: Stage = 'RECEIVING';
  private bytes: number | null = null;
  private total: number | null = null;
  private part: { index: number; count: number } | null = null;
  private queue: { ahead: number; active: number } | null = null;
  private note: string | null = null;
  private title: string | null = null;
  private readonly meter = new RateMeter();
  private readonly startedAt: number;

  private lastEditAt = 0;
  private lastPercent = -1;
  private lastRendered = '';
  private inFlight = false;
  /** Consecutive failures to create the message, for backing off. */
  private sendFailures = 0;
  private nextSendAttemptAt = 0;

  constructor(
    private readonly chatId: number,
    private messageId_: number | null,
    private readonly filename: string,
    /**
     * Called with every state change, whether or not a Telegram edit happens,
     * so the dashboard stays live even while edits are being rate-limited.
     */
    private readonly onUpdate?: (snapshot: ProgressSnapshot) => void | Promise<void>,
    /** Decides which steps the checklist lists; see `stepsFor`. */
    private readonly route?: Route,
    /**
     * When the wait began, for a reporter created after the fact. The queue
     * sweep builds one for an upload that has been waiting since it was
     * received, and "waiting 0s" on every tick was the alternative.
     */
    opts: { startedAt?: number } = {},
  ) {
    this.startedAt = opts.startedAt ?? Date.now();
  }

  /** The Telegram message being edited, once one exists. */
  get messageId(): number | null {
    return this.messageId_;
  }

  /** What the dashboard needs, and what a restart would want to resume from. */
  snapshot(): ProgressSnapshot {
    const view = this.view();
    const { percent, byteAccurate } = resolvePercent(view);
    return {
      stage: this.stage,
      stageTitle: stageTitle(this.stage),
      messageId: this.messageId_,
      percent,
      byteAccurate,
      bytes: this.bytes,
      total: this.total,
      bytesPerSecond: view.bytesPerSecond ?? null,
      etaSeconds: view.etaSeconds ?? null,
      part: this.part,
      elapsedMs: Date.now() - this.startedAt,
    };
  }

  private view(): ProgressView {
    const bytesPerSecond = isTransferStage(this.stage) ? this.meter.bytesPerSecond() : null;
    return {
      stage: this.stage,
      route: this.route,
      filename: this.filename,
      title: this.title,
      bytes: this.bytes,
      total: this.total,
      bytesPerSecond,
      etaSeconds: etaSeconds(this.bytes ?? 0, this.total ?? 0, bytesPerSecond),
      part: this.part,
      queue: this.queue,
      note: this.note,
      elapsedMs: Date.now() - this.startedAt,
    };
  }

  /** The identified title, once known, so later stages name the film. */
  setTitle(title: string | null): void {
    this.title = title;
  }

  /**
   * Move to a new stage. Always edits immediately: a stage change is the most
   * informative thing that can happen, and there are only a handful of them.
   */
  async setStage(stage: Stage, opts: { note?: string | null; resetTransfer?: boolean } = {}): Promise<void> {
    this.stage = stage;
    this.note = opts.note ?? null;
    if (opts.resetTransfer !== false) {
      this.bytes = null;
      this.total = null;
      this.meter.reset();
      this.lastPercent = -1;
    }
    await this.flush(true);
  }

  /** Which piece of a multi-part upload is in flight. */
  setPart(index: number, count: number): void {
    this.part = { index, count };
  }

  /**
   * Report the real position in the queue while waiting for a worker.
   *
   * Rate-limited like any other update, and skipped entirely when the position
   * has not moved, so a long wait costs a handful of edits rather than one per
   * sweep.
   */
  async reportQueued(ahead: number, active: number): Promise<void> {
    const changed = this.queue?.ahead !== ahead || this.queue?.active !== active;
    this.stage = 'QUEUED';
    this.queue = { ahead, active };
    // An unchanged position is re-edited only occasionally, to keep the
    // "waiting …" clock honest; the rendered text differs on every tick, so
    // the usual same-text check alone would edit on every sweep.
    if (!changed && Date.now() - this.lastEditAt < QUEUE_CLOCK_REFRESH_MS) {
      await this.publish();
      return;
    }
    await this.flush(false);
  }

  /**
   * Report real bytes moved. Rate-limited: an edit happens only when enough
   * time has passed *and* the percentage actually moved, or at completion.
   */
  async reportTransfer(bytes: number, total: number): Promise<void> {
    const now = Date.now();
    this.bytes = bytes;
    this.total = total > 0 ? total : null;
    this.meter.record(bytes, now);

    const percent = percentOf(bytes, total) ?? 0;
    const dueByTime = now - this.lastEditAt >= config.worker.progressEditIntervalMs;
    const dueByDelta = percent - this.lastPercent >= config.worker.progressEditMinDelta;
    const finished = total > 0 && bytes >= total;

    if (!finished && !(dueByTime && dueByDelta)) {
      // Still worth telling the dashboard, which is not rate-limited.
      await this.publish();
      return;
    }
    await this.flush(false);
    this.lastPercent = percent;
  }

  /** Back-compatible alias for the original download-only entry point. */
  async reportDownload(bytes: number, total: number): Promise<void> {
    await this.reportTransfer(bytes, total);
  }

  /**
   * A stage that moves bytes but cannot say how many yet — a local Bot API
   * fetch whose temp file could not be attributed, for instance. Shows the
   * stage and elapsed time, and no percentage at all.
   */
  async reportUnmeasured(note: string): Promise<void> {
    this.bytes = null;
    this.total = null;
    this.note = note;
    const now = Date.now();
    if (now - this.lastEditAt < config.worker.progressEditIntervalMs) {
      await this.publish();
      return;
    }
    await this.flush(false);
  }

  /** Replace the message contents outright, bypassing rate limiting. */
  async setText(text: string): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.write(text);
    } finally {
      this.inFlight = false;
    }
  }

  resetTimers(): void {
    this.meter.reset();
    this.bytes = null;
    this.total = null;
    this.lastPercent = -1;
  }

  private async flush(force: boolean): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const text = renderProgress(this.view());
      // Telegram rejects an edit whose content is unchanged; skipping it here
      // saves the round trip as well as the error.
      if (force || text !== this.lastRendered) await this.write(text);
      // Published after the write, so the snapshot carries the message id on
      // the very first flush — that is the one the caller must persist.
      await this.publish();
    } finally {
      this.inFlight = false;
    }
  }

  private async write(text: string): Promise<void> {
    try {
      if (this.messageId_ === null) {
        // A chat that cannot be written to at all — deleted, blocked, or a
        // synthetic id from a test — would otherwise be retried on every tick
        // for the whole transfer. Back off instead of hammering the API.
        if (Date.now() < this.nextSendAttemptAt) return;

        const sent = await sendMessage(this.chatId, text);
        if (sent === null) {
          this.sendFailures += 1;
          const backoff = Math.min(60_000, 2_000 * 2 ** Math.min(this.sendFailures, 5));
          this.nextSendAttemptAt = Date.now() + backoff;
          if (this.sendFailures === 1 || this.sendFailures % 10 === 0) {
            getLogger().warn(
              { chatId: this.chatId, failures: this.sendFailures },
              'Could not create the progress message; continuing without it',
            );
          }
          return;
        }
        this.sendFailures = 0;
        this.messageId_ = sent;
      } else {
        await editMessage(this.chatId, this.messageId_, text);
      }
      this.lastRendered = text;
      this.lastEditAt = Date.now();
    } catch (err) {
      // Never propagate: the transfer matters, the message does not.
      getLogger().debug({ err, chatId: this.chatId }, 'Progress message update failed');
    }
  }

  private async publish(): Promise<void> {
    if (!this.onUpdate) return;
    try {
      await this.onUpdate(this.snapshot());
    } catch (err) {
      getLogger().debug({ err }, 'Progress snapshot sink failed');
    }
  }
}

/**
 * Notify the configured admin chat, if one is set. Never throws.
 *
 * Without `TELEGRAM_ADMIN_CHAT_ID` this used to return silently, so a system
 * with alerting configured and a system throwing every alert away looked
 * identical from the outside — including in the logs. Health checks fire on a
 * state *change*, so these are rare and worth a line each: the log now records
 * that an alert existed and went nowhere.
 */
export async function notifyAdmin(text: string): Promise<void> {
  const chatId = Number(config.telegram.adminChatId);
  if (!Number.isFinite(chatId) || chatId === 0) {
    getLogger().warn(
      // The body is deliberately omitted: an alert can quote a path or an
      // error, and this line exists to report the misconfiguration, not to
      // copy the alert into a second place.
      { reason: 'TELEGRAM_ADMIN_CHAT_ID is not set', bytes: text.length },
      'Admin alert discarded: no admin chat is configured',
    );
    return;
  }
  await sendMessage(chatId, text);
}
