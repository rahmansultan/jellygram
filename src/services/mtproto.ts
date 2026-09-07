import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { getLogger } from '../lib/logger.js';
import { assertInside } from '../lib/paths.js';
import { removeQuietly } from './storage.js';

/**
 * MTProto ingestion.
 *
 * The Bot API cannot fetch a file above 2000 MB. This module logs in as the
 * *owner's own Telegram account* — the account that forwarded the media — and
 * streams the original file straight to disk.
 *
 * Scope is deliberately narrow. The account is used only to read messages the
 * owner has explicitly forwarded to the bot and to download their media. It
 * never sends messages, joins chats, forwards anything, or takes any other
 * action on the account.
 *
 * `teleproto` (the maintained fork of the archived GramJS) is imported lazily,
 * so a deployment with MTProto disabled never loads it.
 */

/** Anyone holding this file can act as the Telegram account. Never log it. */
export const SESSION_FILE_MODE = 0o600;

export class MtprotoError extends Error {
  constructor(
    message: string,
    readonly userMessage: string,
    readonly retryable: boolean,
    readonly kind: 'auth' | 'access' | 'not-found' | 'network' | 'config' | 'other' = 'other',
    // Wrapping without the cause loses the only description of what actually
    // went wrong, which is how the original failure stayed invisible.
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'MtprotoError';
  }
}

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

export async function readSessionString(): Promise<string | null> {
  try {
    const raw = await fsp.readFile(config.mtproto.sessionPath, 'utf8');
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/** Persist the session, owner-readable only, and verify the mode took. */
export async function writeSessionString(session: string): Promise<void> {
  const target = config.mtproto.sessionPath;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, `${session}\n`, { mode: SESSION_FILE_MODE });
  await fsp.chmod(target, SESSION_FILE_MODE);

  const mode = (await fsp.stat(target)).mode & 0o777;
  if (mode !== SESSION_FILE_MODE) {
    throw new MtprotoError(
      `Session file mode is ${mode.toString(8)}, expected ${SESSION_FILE_MODE.toString(8)}`,
      'The session file could not be secured.',
      false,
      'config',
    );
  }
}

export async function deleteSession(): Promise<void> {
  await removeQuietly(config.mtproto.sessionPath);
}

export interface MtprotoStatus {
  enabled: boolean;
  credentialsPresent: boolean;
  sessionPresent: boolean;
  sessionPathMode: string | null;
  authorized: boolean;
  account: { id: string; username: string | null; firstName: string | null } | null;
  message: string;
}

export interface StatusOptions {
  /**
   * Open a connection to confirm the session still works.
   *
   * Off by default. The API process must not connect: it would hold a second
   * MTProto client on the same session alongside the worker's, and a slow
   * handshake would stall every dashboard request that asks for status.
   */
  probe?: boolean;
  /** Give up on the probe rather than letting a page load hang. */
  probeTimeoutMs?: number;
}

/**
 * Report readiness without ever revealing the session.
 *
 * Used by the status script, the dashboard and the bot's routing decision.
 */
export async function status(options: StatusOptions = {}): Promise<MtprotoStatus> {
  const base: MtprotoStatus = {
    enabled: config.mtproto.enabled,
    credentialsPresent: config.mtproto.credentialsPresent,
    sessionPresent: false,
    sessionPathMode: null,
    authorized: false,
    account: null,
    message: '',
  };

  if (!config.mtproto.credentialsPresent) {
    return { ...base, message: 'TELEGRAM_API_ID / TELEGRAM_API_HASH are not set.' };
  }

  const session = await readSessionString();
  base.sessionPresent = session !== null;

  try {
    const mode = (await fsp.stat(config.mtproto.sessionPath)).mode & 0o777;
    base.sessionPathMode = mode.toString(8).padStart(4, '0');
  } catch {
    base.sessionPathMode = null;
  }

  if (!session) {
    return { ...base, message: 'No MTProto session. Run `npm run telegram:mtproto:setup`.' };
  }
  if (!config.mtproto.enabled) {
    return {
      ...base,
      message: 'A session exists but TELEGRAM_MTPROTO_ENABLED is false.',
    };
  }

  // Configured and ready as far as can be told without dialling Telegram.
  if (!options.probe) {
    return {
      ...base,
      authorized: true,
      message: 'Enabled, with a stored session.',
    };
  }

  try {
    const client = await withTimeout(getClient(), options.probeTimeoutMs ?? 20_000);
    const me = (await client.getMe()) as {
      id?: { toString(): string };
      username?: string;
      firstName?: string;
    };
    return {
      ...base,
      authorized: true,
      account: {
        id: me?.id?.toString() ?? 'unknown',
        username: me?.username ?? null,
        firstName: me?.firstName ?? null,
      },
      message: 'Authorised.',
    };
  } catch (err) {
    return { ...base, message: `Session present but not usable: ${(err as Error).message}` };
  }
}

/** Reject rather than wait forever on a stalled handshake. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

let clientPromise: Promise<AnyClient> | null = null;

/**
 * Connect once and reuse. The client is created lazily so a deployment with
 * MTProto disabled never pays for loading the library.
 */
export async function getClient(): Promise<AnyClient> {
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    if (!config.mtproto.credentialsPresent) {
      throw new MtprotoError(
        'MTProto credentials are missing',
        'MTProto is not configured on the server.',
        false,
        'config',
      );
    }

    const session = await readSessionString();
    if (!session) {
      throw new MtprotoError(
        'No MTProto session on disk',
        'The Telegram account is not linked. The administrator must run the MTProto setup.',
        false,
        'auth',
      );
    }

    const { TelegramClient } = await import('teleproto');
    const { StringSession } = await import('teleproto/sessions/index.js');

    const client = new TelegramClient(
      new StringSession(session),
      config.mtproto.apiId,
      config.mtproto.apiHash,
      {
        connectionRetries: 5,
        retryDelay: 2000,
        autoReconnect: true,
        // The library logs verbosely by default; keep it quiet so nothing
        // session-shaped can reach our log files.
        baseLogger: await quietLogger(),
      },
    );

    await client.connect();

    if (!(await client.isUserAuthorized())) {
      throw new MtprotoError(
        'MTProto session is not authorised',
        'The linked Telegram account is no longer authorised. Run the MTProto setup again.',
        false,
        'auth',
      );
    }

    getLogger().info('MTProto client connected');
    return client;
  })().catch((err) => {
    clientPromise = null;
    throw err;
  });

  return clientPromise;
}

export async function disconnectClient(): Promise<void> {
  if (!clientPromise) return;
  try {
    const client = await clientPromise;
    await client.disconnect();
  } catch {
    // Already gone.
  }
  clientPromise = null;
}

/**
 * Silence the library's own logger.
 *
 * It is chatty at info level and prints connection internals; our logger is
 * the only one that should write, and it is the one that redacts secrets.
 */
async function quietLogger() {
  const { Logger } = await import('teleproto/extensions/index.js');
  const logger = new Logger('none' as never);
  logger.log = () => {};
  return logger;
}

// ---------------------------------------------------------------------------
// Locating the forwarded media
// ---------------------------------------------------------------------------

export interface LocateHints {
  /** Exact origin, when the Bot API disclosed a channel and message id. */
  originKind: 'channel' | 'user' | 'chat' | 'hidden' | 'unknown';
  originChat: string | null;
  originMessageId: number | null;
  /** What the bot saw, used to match when there is no exact origin. */
  fileName: string;
  fileSize: number;
}

export interface LocatedMedia {
  /** The MTProto media object, passed straight to the downloader. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  media: any;
  size: number;
  fileName: string | null;
  via: 'origin' | 'bot-dialog';
}

/** Size of a document, whatever numeric type the library returned it as. */
function documentSize(document: { size?: unknown }): number {
  const raw = document?.size;
  if (raw === undefined || raw === null) return 0;
  return typeof raw === 'number' ? raw : Number(String(raw));
}

/** Filename attribute of a document, when it carries one. */
function documentName(document: { attributes?: Array<{ className?: string; fileName?: string }> }): string | null {
  for (const attribute of document?.attributes ?? []) {
    if (attribute?.className === 'DocumentAttributeFilename' && attribute.fileName) {
      return attribute.fileName;
    }
  }
  return null;
}

/**
 * Find the media the owner forwarded.
 *
 * Two routes, in order of certainty:
 *
 *  1. A forward from a **channel** carries the origin chat and message id, so
 *     the exact message can be fetched.
 *  2. Anything else — a forward from a private chat, a group, or a sender who
 *     hides their account — carries no message id the bot can use. The
 *     forwarded copy does exist in the owner's own dialog with the bot, so the
 *     recent history of that dialog is searched for a document matching the
 *     size the bot reported.
 *
 * Both routes go through the account's ordinary permissions. Nothing here
 * attempts to reach a chat the account cannot already read.
 */
export async function locateForwardedMedia(hints: LocateHints): Promise<LocatedMedia> {
  const log = getLogger();
  const client = await getClient();

  // --- 1. Exact origin ------------------------------------------------------
  if (hints.originKind === 'channel' && hints.originChat && hints.originMessageId) {
    try {
      const messages = await client.getMessages(hints.originChat, { ids: [hints.originMessageId] });
      const message = messages?.[0];
      const document = message?.media?.document ?? message?.document;
      if (document) {
        log.info({ via: 'origin' }, 'Located forwarded media at its source');
        return {
          // `iterDownload` accepts a Message, a MessageMediaDocument or an
          // InputFileLocation — not a bare Document. The media wrapper is
          // preferred so we stay on the documented contract.
          media: message.media ?? document,
          size: documentSize(document),
          fileName: documentName(document),
          via: 'origin',
        };
      }
    } catch (err) {
      // A private or since-deleted channel lands here. Fall through to the
      // dialog search rather than failing outright.
      log.warn({ err: (err as Error).message }, 'Could not read the origin channel; searching the bot dialog');
    }
  }

  // --- 2. The owner's own dialog with the bot -------------------------------
  const botUsername = await resolveBotUsername();
  if (!botUsername) {
    throw new MtprotoError(
      'Cannot determine the bot account to search',
      'The server could not work out which chat to look in.',
      false,
      'config',
    );
  }

  let history;
  try {
    history = await client.getMessages(botUsername, { limit: config.mtproto.searchDepth });
  } catch (err) {
    throw new MtprotoError(
      `Could not read the bot dialog: ${(err as Error).message}`,
      'Your Telegram account could not read its own chat with this bot.',
      true,
      'access',
    );
  }

  // Match on exact byte size first: it is the one field the Bot API and
  // MTProto both report identically. The filename is a tiebreaker only.
  const candidates: Array<{ media: unknown; size: number; name: string | null }> = [];
  for (const message of history ?? []) {
    const document = message?.media?.document ?? message?.document;
    if (!document) continue;
    const size = documentSize(document);
    if (size !== hints.fileSize) continue;
    // As above: hand on the media wrapper, not the bare Document.
    candidates.push({
      media: message.media ?? document,
      size,
      name: documentName(document),
    });
  }

  if (candidates.length === 0) {
    throw new MtprotoError(
      `No message with a ${hints.fileSize} byte document in the last ${config.mtproto.searchDepth} messages`,
      'I could not find that media in your Telegram account. It may have been deleted, ' +
        'or your account may no longer have access to it.',
      false,
      'not-found',
    );
  }

  // Prefer an exact filename match when several files share a size.
  const byName = candidates.find((c) => c.name === hints.fileName);
  const chosen = byName ?? candidates[0]!;

  log.info(
    { via: 'bot-dialog', candidates: candidates.length, matchedName: Boolean(byName) },
    'Located forwarded media in the bot dialog',
  );

  return { media: chosen.media, size: chosen.size, fileName: chosen.name, via: 'bot-dialog' };
}

let cachedBotUsername: string | null | undefined;

/** The bot's @username, so the account knows which dialog to read. */
async function resolveBotUsername(): Promise<string | null> {
  if (cachedBotUsername !== undefined) return cachedBotUsername;
  try {
    const res = await fetch(
      `${config.telegram.apiRoot}/bot${config.telegram.botToken}/getMe`,
      { method: 'POST', signal: AbortSignal.timeout(15_000) },
    );
    const body = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    cachedBotUsername = body.ok && body.result?.username ? `@${body.result.username}` : null;
  } catch {
    cachedBotUsername = null;
  }
  return cachedBotUsername;
}

// ---------------------------------------------------------------------------
// Streaming download
// ---------------------------------------------------------------------------

export interface DownloadOptions {
  destination: string;
  expectedSize: number;
  onProgress?: (bytes: number, total: number, bytesPerSecond: number) => void | Promise<void>;
  shouldCancel?: () => boolean | Promise<boolean>;
  /** Overrides `MTPROTO_STALL_TIMEOUT_SEC`; used by tests to keep them fast. */
  stallTimeoutMs?: number;
}

/**
 * A chunk size Telegram will accept: a multiple of 4096, no larger than the
 * 1 MiB `upload.getFile` ceiling. A misconfigured value is corrected rather
 * than allowed to fail mid-download.
 */
export function requestSize(): number {
  const MAX = 1024 * 1024;
  const configured = Math.min(Math.max(config.mtproto.chunkBytes, 4096), MAX);
  return Math.floor(configured / 4096) * 4096;
}

export class MtprotoStalledError extends Error {
  constructor(ms: number) {
    super(`No data received from Telegram for ${Math.round(ms / 1000)}s; the download stalled`);
    this.name = 'MtprotoStalledError';
  }
}

/**
 * Fail a download that stops producing chunks.
 *
 * `iterDownload` accepts neither an abort signal nor a timeout, so without
 * this a stalled connection parks `for await` indefinitely and the worker slot
 * it holds is never released. The timer is per chunk, so a slow download that
 * is still making progress is unaffected.
 */
async function* withStallTimeout<T>(
  source: AsyncIterable<T>,
  timeoutMs: number,
): AsyncGenerator<T, void, undefined> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MtprotoStalledError(timeoutMs)), timeoutMs);
      });
      let step: IteratorResult<T>;
      try {
        step = await Promise.race([iterator.next(), stalled]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (step.done) return;
      yield step.value;
    }
  } finally {
    // Deliberately not awaited. `return()` on an iterator that is itself stuck
    // waiting for data never settles, so awaiting it here would reintroduce
    // exactly the hang this guard exists to prevent.
    void Promise.resolve(iterator.return?.(undefined)).catch(() => {});
  }
}

/**
 * Close the sink, then delete what it wrote.
 *
 * Destroying an `fs.WriteStream` does not close its descriptor synchronously,
 * so unlinking immediately afterwards raced whatever the stream still had in
 * flight and left a **0-byte file** in the staging directory behind every
 * cancelled download. Nothing referenced it, so it sat there until the
 * reaper's grace expired a day later. Waiting for `close` first makes the
 * removal deterministic: by the time the name is unlinked there is no
 * outstanding operation that could recreate it.
 */
async function discard(sink: fs.WriteStream, destination: string): Promise<void> {
  await new Promise<void>((resolve) => {
    if (sink.destroyed && sink.closed) return resolve();
    sink.once('close', resolve);
    sink.destroy();
    // A stream that never emits `close` must not hold the failure path open.
    setTimeout(resolve, 2000).unref();
  });
  await removeQuietly(destination);
}

export class MtprotoCancelledError extends Error {
  constructor() {
    super('Download cancelled');
    this.name = 'MtprotoCancelledError';
  }
}

export interface DownloadResult {
  path: string;
  bytes: number;
  sha256: string;
}

/**
 * Stream media to disk in bounded chunks, hashing as it goes.
 *
 * Memory use is one chunk at a time regardless of file size, and the SHA-256
 * is computed during the same pass rather than by re-reading a 5 GB file.
 */
export async function downloadMedia(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  media: any,
  opts: DownloadOptions,
  // Injectable so the call shape can be asserted without a live account.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  clientOverride?: any,
): Promise<DownloadResult> {
  const log = getLogger();
  const client = clientOverride ?? (await getClient());

  const destination = assertInside(config.storage.downloadTmpDir, opts.destination);
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: config.storage.dirMode });
  await removeQuietly(destination);

  const hash = crypto.createHash('sha256');
  const sink = fs.createWriteStream(destination, { mode: config.storage.fileMode });

  let received = 0;
  let lastTick = Date.now();
  let lastBytes = 0;
  let speed = 0;

  try {
    // `iterDownload(file, params)` takes two positional arguments. Passing a
    // single `{ file, requestSize }` bag instead makes the library treat the
    // bag itself as the file, which fails with an opaque cast error.
    const iterator = client.iterDownload(media, { requestSize: requestSize() });

    for await (const chunk of withStallTimeout<Buffer | Uint8Array>(
      iterator,
      opts.stallTimeoutMs ?? config.mtproto.stallTimeoutMs,
    )) {
      if (await opts.shouldCancel?.()) throw new MtprotoCancelledError();

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      received += buffer.length;

      if (!sink.write(buffer)) {
        // Respect back-pressure so a fast connection cannot outrun the disk
        // and grow an unbounded write queue in memory.
        await new Promise<void>((resolve) => sink.once('drain', resolve));
      }

      const now = Date.now();
      if (now - lastTick >= 1000) {
        speed = ((received - lastBytes) / (now - lastTick)) * 1000;
        lastTick = now;
        lastBytes = received;
        await opts.onProgress?.(received, opts.expectedSize, speed);
      }
    }
  } catch (err) {
    await discard(sink, destination);

    if (err instanceof MtprotoCancelledError) throw err;

    const message = (err as Error).message ?? String(err);
    // A stall is transient by definition — the connection went quiet, so a
    // retry is exactly the right response. Matching it by name rather than by
    // the wording of its message keeps the two from drifting apart.
    const transient =
      err instanceof MtprotoStalledError || /timeout|network|connect|ECONN|socket|flood/i.test(message);
    throw new MtprotoError(
      `MTProto download failed: ${message}`,
      transient
        ? 'The download was interrupted. It will be retried.'
        : `The download failed: ${message}`,
      transient,
      transient ? 'network' : 'other',
      { cause: err },
    );
  }

  await new Promise<void>((resolve, reject) => {
    sink.end((err?: NodeJS.ErrnoException | null) => (err ? reject(err) : resolve()));
  });

  // --- Verify ---------------------------------------------------------------
  const stat = await fsp.stat(destination);

  if (stat.size !== received) {
    await discard(sink, destination);
    throw new MtprotoError(
      `Wrote ${stat.size} bytes but received ${received}`,
      'The downloaded file was inconsistent and was discarded.',
      true,
      'other',
    );
  }

  if (opts.expectedSize > 0 && stat.size !== opts.expectedSize) {
    await discard(sink, destination);
    throw new MtprotoError(
      `Truncated download: expected ${opts.expectedSize} bytes, got ${stat.size}`,
      'The download finished short of the expected size, so it was discarded.',
      true,
      'network',
    );
  }

  await opts.onProgress?.(received, opts.expectedSize || received, speed);
  log.info({ bytes: stat.size }, 'MTProto download complete');

  return { path: destination, bytes: stat.size, sha256: hash.digest('hex') };
}
