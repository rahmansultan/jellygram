import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config } from '../config/index.js';
import { getLogger } from '../lib/logger.js';
import { assertInside } from '../lib/paths.js';
import { removeQuietly } from './storage.js';

/**
 * Downloading a Telegram file to disk.
 *
 * The file is streamed straight into the temp directory; nothing larger than
 * the 1 MB stream buffer is ever held in memory, so a 20 GB movie costs the
 * same RAM as a 2 MB clip.
 */

export class TelegramFileError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TelegramFileError';
  }
}

export class DownloadCancelledError extends Error {
  constructor() {
    super('Download cancelled');
    this.name = 'DownloadCancelledError';
  }
}

/**
 * The public Bot API refuses `getFile` for anything above 20 MB.
 * This is enforced by Telegram; no bot setting changes it.
 */
export const PUBLIC_BOT_API_FILE_LIMIT = 20 * 1024 * 1024;

/**
 * A self-hosted Bot API server in `--local` mode raises the ceiling to
 * 2000 MB. That is the current documented maximum; it is not 5 GB.
 */
export const LOCAL_BOT_API_FILE_LIMIT = 2000 * 1024 * 1024;

/** What the configured transport can actually fetch. */
export function botApiFileLimit(): number {
  return config.telegram.localMode ? LOCAL_BOT_API_FILE_LIMIT : PUBLIC_BOT_API_FILE_LIMIT;
}

/**
 * The single number every size check must use.
 *
 * Accepting a file the transport cannot fetch wastes the user's upload and
 * fails late, so the configured ceiling is clamped to the transport's.
 */
export function effectiveMaxFileSize(): number {
  return Math.min(config.storage.maxFileSizeBytes, botApiFileLimit());
}

/**
 * Translate a path as the Bot API *container* sees it into a host path.
 *
 * The server runs in a container with its data directory bind-mounted, so the
 * absolute path getFile returns is only meaningful inside that container.
 * When both roots are equal this is a no-op.
 */
export function toHostPath(containerPath: string): string {
  const fileRoot = path.resolve(config.telegram.localFileRoot);
  const hostRoot = path.resolve(config.telegram.localHostRoot);
  if (fileRoot === hostRoot) return path.resolve(containerPath);

  const resolved = path.resolve(containerPath);
  if (resolved !== fileRoot && !resolved.startsWith(fileRoot + path.sep)) {
    // Not under the mapped root: hand it back untouched and let the caller's
    // existence check produce a clear error rather than silently guessing.
    return resolved;
  }
  return path.join(hostRoot, path.relative(fileRoot, resolved));
}

interface GetFileResult {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

/**
 * Watches a local Bot API server fetch a file, so the wait can show real bytes.
 *
 * `getFile` blocks until the server has the whole file and reports nothing
 * while it works — which is where almost all the wall-clock time of a
 * multi-gigabyte upload goes. The server does, however, write the partial
 * download to its temp directory, so the growing file *is* the progress.
 *
 * Attribution is the hard part: several bots and several uploads share that
 * directory. Only files that appear *after* this observer was created are
 * considered, and only when exactly one such file exists. With two concurrent
 * fetches there is no way to tell which is which, so it reports nothing rather
 * than guess — a wrong percentage is worse than none.
 */
export class FetchObserver {
  /** Path to the size it had when this observer started watching. */
  private known = new Map<string, number>();
  private ready = false;

  private constructor(
    private readonly dirs: string[],
    private readonly expectedSize: number,
  ) {}

  /** Below this a new file is bookkeeping, not a movie being fetched. */
  private static readonly MIN_CANDIDATE_BYTES = 1024 * 1024;

  static async create(expectedSize: number): Promise<FetchObserver> {
    const root = path.resolve(config.telegram.localHostRoot);
    // The server writes partials under --temp-dir, and also keeps a per-bot
    // `temp` directory; the recursive walk from the root covers both.
    const observer = new FetchObserver([path.join(root, '.tmp'), root], expectedSize);
    await observer.snapshot();
    return observer;
  }

  private async listFiles(dir: string, depth = 0): Promise<string[]> {
    if (depth > 3) return [];
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // `documents` holds finished files, never partials.
        if (entry.name === 'documents') continue;
        out.push(...(await this.listFiles(full, depth + 1)));
      } else if (entry.isFile() && entry.name !== 'td.binlog') {
        out.push(full);
      }
    }
    return out;
  }

  private async snapshot(): Promise<void> {
    for (const dir of this.dirs) {
      for (const file of await this.listFiles(dir)) {
        const stat = await fsp.stat(file).catch(() => null);
        this.known.set(file, stat?.isFile() ? stat.size : 0);
      }
    }
    this.ready = true;
  }

  /**
   * Bytes fetched so far, or null when that cannot be established honestly.
   * Never throws.
   */
  async sample(): Promise<number | null> {
    if (!this.ready) return null;
    try {
      const seen = new Set<string>();
      for (const dir of this.dirs) {
        for (const file of await this.listFiles(dir)) seen.add(file);
      }
      // A file is ours if it appeared after we started watching, or if it was
      // already there and has since grown. The second case is what lets a
      // restarted worker pick a transfer back up: the Bot API server keeps
      // downloading across the restart, so its partial file is older than this
      // observer but still visibly advancing.
      const sized: number[] = [];
      for (const file of seen) {
        const before = this.known.get(file);
        const stat = await fsp.stat(file).catch(() => null);
        if (!stat?.isFile()) continue;
        if (before !== undefined && stat.size <= before) continue;
        if (stat.size < FetchObserver.MIN_CANDIDATE_BYTES) continue;
        if (this.expectedSize > 0 && stat.size > this.expectedSize) continue;
        sized.push(stat.size);
      }

      // Two plausible candidates means two concurrent fetches and no way to
      // tell them apart. Reporting nothing beats reporting the wrong one.
      return sized.length === 1 ? (sized[0] ?? null) : null;
    } catch {
      return null;
    }
  }
}

export interface GetFileWaitOptions {
  /** Used to derive how long the server is allowed to take. */
  expectedSize?: number;
  /**
   * Called between polls while the server is still fetching the file.
   * `observedBytes` is the real size of the partial download when it could be
   * attributed to this fetch, and null when it could not.
   */
  onWaiting?: (
    elapsedMs: number,
    budgetMs: number,
    observedBytes: number | null,
  ) => void | Promise<void>;
  /** Polled between attempts; returning true aborts the wait. */
  shouldCancel?: () => boolean | Promise<boolean>;
}

/**
 * How long `getFile` may take for a file of this size.
 *
 * The public Bot API answers immediately — it only hands back a URL. A local
 * server in `--local` mode instead downloads the entire file from Telegram
 * before it replies, so the answer legitimately takes as long as the transfer:
 * a 1.81 GiB movie measured ~24 minutes on this link. The budget is therefore
 * derived from the size and a pessimistic floor rate, then clamped.
 */
export function getFileBudgetMs(expectedSize: number): number {
  const floor = config.telegram.getFileTimeoutMs;
  if (!config.telegram.localMode) return floor;
  const perSec = Math.max(1, config.telegram.getFileMinBytesPerSec);
  const derived = Math.ceil((Math.max(0, expectedSize) / perSec) * 1000);
  return Math.min(config.telegram.getFileMaxWaitMs, Math.max(floor, derived));
}

/** A timeout or transport hiccup, as opposed to Telegram refusing the request. */
function isTransient(err: unknown): boolean {
  if (err instanceof TelegramFileError) return err.retryable;
  const name = (err as Error | undefined)?.name;
  // AbortSignal.timeout throws TimeoutError; fetch transport failures surface
  // as TypeError('fetch failed') with the socket error as `cause`.
  return name === 'TimeoutError' || name === 'AbortError' || err instanceof TypeError;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve a `file_id` into a download location, waiting for a local Bot API
 * server to finish fetching the file.
 *
 * The server keeps downloading after a client disconnects, so a request that
 * times out is re-issued rather than treated as a failure: each retry either
 * resumes the wait or returns the finished path. A single long-blocking
 * request would be indistinguishable from a hang, and gives the caller no
 * chance to report progress or honour a cancellation.
 */
export async function getFileInfo(
  fileId: string,
  opts: GetFileWaitOptions = {},
): Promise<GetFileResult> {
  const budgetMs = getFileBudgetMs(opts.expectedSize ?? 0);
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  let attempt = 0;
  let lastError: unknown;

  // Only worth watching when the server does the fetching; the public Bot API
  // answers immediately.
  const observer =
    config.telegram.localMode && opts.onWaiting
      ? await FetchObserver.create(opts.expectedSize ?? 0).catch(() => null)
      : null;

  // The wait is reported on its own timer rather than once per poll: a poll
  // blocks for up to `getFileTimeoutMs` before it fails, so driving progress
  // from the poll loop would update the user roughly once a minute. The ticker
  // samples the partial file every couple of seconds instead; the reporter
  // downstream does its own rate limiting before touching Telegram.
  let ticking = false;
  const ticker = opts.onWaiting
    ? setInterval(() => {
        if (ticking) return;
        ticking = true;
        void (async () => {
          try {
            const observed = observer ? await observer.sample() : null;
            await opts.onWaiting?.(Date.now() - startedAt, budgetMs, observed);
          } catch {
            // Progress reporting must never disturb the transfer.
          } finally {
            ticking = false;
          }
        })();
      }, config.telegram.progressTickMs)
    : null;
  ticker?.unref?.();

  try {
    return await pollForFile();
  } finally {
    if (ticker) clearInterval(ticker);
  }

  async function pollForFile(): Promise<GetFileResult> {
  for (;;) {
    attempt += 1;
    try {
      return await requestFileInfo(fileId);
    } catch (err) {
      lastError = err;
      if (!isTransient(err)) throw err;

      if (await opts.shouldCancel?.()) throw new DownloadCancelledError();
      if (Date.now() >= deadline) break;

      getLogger().info(
        { attempt, elapsedMs: Date.now() - startedAt, budgetMs },
        'Bot API server is still fetching the file; waiting',
      );
      await sleep(config.telegram.getFilePollMs);
      if (await opts.shouldCancel?.()) throw new DownloadCancelledError();
    }
  }

  const waited = Math.round((Date.now() - startedAt) / 1000);
  throw new TelegramFileError(
    `Telegram did not make the file available within ${waited}s ` +
      `(${attempt} attempts). The Bot API server may still be downloading it; ` +
      `retrying later will reuse whatever it has already fetched.`,
    true,
    { cause: lastError },
  );
  }
}

/** One `getFile` request. Bounded so a dead socket cannot hang the caller. */
async function requestFileInfo(fileId: string): Promise<GetFileResult> {
  const url = `${config.telegram.apiRoot}/bot${config.telegram.botToken}/getFile`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
    signal: AbortSignal.timeout(config.telegram.getFileTimeoutMs),
  });

  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: GetFileResult;
    description?: string;
    error_code?: number;
  };

  if (!res.ok || !body.ok || !body.result) {
    const description = body.description ?? `HTTP ${res.status}`;
    const status = body.error_code ?? res.status;
    // "file is too big" is the public API's 20 MB ceiling, and no retry helps.
    const tooBig = /too big/i.test(description);
    // What a retry *can* help with: a server fault, flood control, and the
    // local server's own "wrong file_id or the file is temporarily
    // unavailable", which it answers with a 400 while a fetch has faltered —
    // a real 1.9 GB upload was failed outright on that wording after nineteen
    // minutes of fetching, and went through when re-sent.
    const transient = status >= 500 || status === 429 || /temporarily unavailable/i.test(description);
    throw new TelegramFileError(
      tooBig
        ? config.telegram.localMode
          ? 'The local Bot API server refused the download: it cannot fetch files larger than 2000 MB.'
          : 'Telegram refused the download: the public Bot API cannot fetch files larger than 20 MB. ' +
            'Configure a local Bot API server (see DOCUMENTATION.md, "Large file support").'
        : `Telegram getFile failed: ${description}`,
      !tooBig && transient,
    );
  }

  return body.result;
}

export interface DownloadOptions {
  fileId: string;
  /** Absolute destination inside DOWNLOAD_TMP_DIR. */
  destination: string;
  expectedSize: number;
  onProgress?: (bytes: number, total: number) => void | Promise<void>;
  /**
   * Called while a local Bot API server is still fetching the file from
   * Telegram, before a single byte is available to copy. Without this the user
   * sees "Starting…" for the whole transfer.
   *
   * `observedBytes` is the size of the partial download when it could be
   * attributed to this fetch, and null when it could not.
   */
  onWaiting?: (
    elapsedMs: number,
    budgetMs: number,
    observedBytes: number | null,
  ) => void | Promise<void>;
  /** Polled between chunks; returning true aborts and removes the partial file. */
  shouldCancel?: () => boolean | Promise<boolean>;
}

export interface DownloadResult {
  path: string;
  bytes: number;
}

/**
 * Stream a Telegram file to `destination`.
 *
 * In local Bot API mode the "download" is a copy from the Bot API server's
 * working directory, which is both faster and immune to the size ceiling.
 */
export async function downloadTelegramFile(opts: DownloadOptions): Promise<DownloadResult> {
  const log = getLogger();
  const destination = assertInside(config.storage.downloadTmpDir, opts.destination);
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: config.storage.dirMode });

  const info = await getFileInfo(opts.fileId, {
    expectedSize: opts.expectedSize,
    onWaiting: opts.onWaiting,
    shouldCancel: opts.shouldCancel,
  });
  if (!info.file_path) {
    throw new TelegramFileError('Telegram returned no file path for this file', false);
  }

  const total = info.file_size ?? opts.expectedSize;

  // --- Local Bot API server: the file is already on this machine ------------
  if (config.telegram.localMode && path.isAbsolute(info.file_path)) {
    return takeLocalFile(toHostPath(info.file_path), destination, opts);
  }

  // --- Public Bot API: stream over HTTPS -----------------------------------
  const downloadUrl = `${config.telegram.apiRoot}/file/bot${config.telegram.botToken}/${info.file_path}`;
  const controller = new AbortController();

  const res = await fetch(downloadUrl, { signal: controller.signal });
  if (!res.ok || !res.body) {
    throw new TelegramFileError(
      `Telegram file download failed: HTTP ${res.status} ${res.statusText}`,
      res.status >= 500 || res.status === 429,
    );
  }

  const declared = Number(res.headers.get('content-length') ?? total) || total;
  let received = 0;
  let lastReport = 0;
  // Tracked separately from `lastReport`: sharing one cursor meant the
  // progress branch reset it every 1 MB, so `received - lastReport` could
  // never reach the 4 MB cancellation threshold and a cancel was never noticed.
  let lastCancelCheck = 0;

  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  const sink = fs.createWriteStream(destination, { mode: config.storage.fileMode });

  try {
    await pipeline(
      source,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          received += chunk.length;

          if (opts.shouldCancel && received - lastCancelCheck > 4 * 1024 * 1024) {
            lastCancelCheck = received;
            if (await opts.shouldCancel()) {
              controller.abort();
              throw new DownloadCancelledError();
            }
          }

          if (opts.onProgress && received - lastReport > 1024 * 1024) {
            lastReport = received;
            await opts.onProgress(received, declared);
          }

          yield chunk;
        }
      },
      sink,
    );
  } catch (err) {
    await removeQuietly(destination);
    if (err instanceof DownloadCancelledError) throw err;
    throw new TelegramFileError(`Download interrupted: ${(err as Error).message}`, true);
  }

  const { size } = await fsp.stat(destination);
  if (declared > 0 && size !== declared) {
    await removeQuietly(destination);
    throw new TelegramFileError(
      `Download incomplete: expected ${declared} bytes, wrote ${size}`,
      true,
    );
  }

  await opts.onProgress?.(size, declared);
  return { path: destination, bytes: size };
}

/**
 * Take a file the local Bot API server has already written to disk.
 *
 * A rename is preferred: it moves a 2 GB file instantly, copies no bytes
 * through RAM, and removes the server's own copy in the same operation. Only
 * when the two directories sit on different filesystems does this fall back to
 * a streaming copy.
 *
 * Exported so the move path can be tested directly against real files.
 */
export async function takeLocalFile(
  source: string,
  destination: string,
  opts: Pick<DownloadOptions, 'onProgress' | 'shouldCancel'> = {},
): Promise<DownloadResult> {
  const log = getLogger();

  // The Bot API server names a directory after the bot token, so only the part
  // below the data root is ever logged.
  const loggablePath = path.relative(path.resolve(config.telegram.localHostRoot), source);

  // Whether this path came from the Bot API server at all. Assembled parts,
  // MTProto fetches and direct uploads arrive here too, from the staging
  // directory, and a missing file there is a different problem with a
  // different fix.
  const fromBotApi = !path.relative(path.resolve(config.telegram.localHostRoot), source).startsWith('..');

  try {
    await fsp.access(source);
  } catch {
    throw new TelegramFileError(
      fromBotApi
        ? 'The local Bot API server reported a file this host cannot see. Check that ' +
            'TELEGRAM_LOCAL_FILE_ROOT and TELEGRAM_LOCAL_HOST_ROOT match the two sides of ' +
            "the container's data bind mount."
        : 'The staged file for this upload is no longer on the server; it will have to be sent again.',
      false,
    );
  }

  let bytes: number;
  try {
    bytes = (await fsp.stat(source)).size;
  } catch (err) {
    throw localFileFailure('read', err, loggablePath);
  }
  log.debug({ file: loggablePath, bytes }, 'Taking file from the local Bot API server');

  try {
    await fsp.rename(source, destination);
    await fsp.chmod(destination, config.storage.fileMode).catch(() => {});
    await opts.onProgress?.(bytes, bytes);
    return { path: destination, bytes };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw localFileFailure('take', err, loggablePath);
    log.debug('Bot API data directory is on another filesystem; streaming instead');
  }

  try {
    await copyWithProgress(source, destination, bytes, {
      destination,
      ...opts,
    } as DownloadOptions);
  } catch (err) {
    if (err instanceof DownloadCancelledError) throw err;
    throw localFileFailure('copy', err, loggablePath);
  }
  const { size } = await fsp.stat(destination);
  return { path: destination, bytes: size };
}

/** errno values worth carrying through, so the failure is classified by cause. */
const CARRIED_ERRNO = new Set(['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'ENOENT']);

/**
 * A filesystem failure on the local take, described without the path.
 *
 * Node's own message for a failed rename or open embeds both absolute paths —
 * and the source lives in a directory the Bot API server names after the bot
 * token. That message used to become the upload's recorded error, which the
 * Mini App and the sender's chat then displayed. Only the errno and the path
 * below the data root survive here; the token-bearing path never leaves the
 * scrubbed logs.
 */
function localFileFailure(step: 'read' | 'take' | 'copy', err: unknown, loggablePath: string): TelegramFileError {
  const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
  const verb = step === 'read' ? 'read' : step === 'take' ? 'take' : 'copy';
  const failure = new TelegramFileError(
    `Could not ${verb} the file from the local Bot API server (${code}: ${loggablePath})`,
    // Permissions, a full disk and I/O errors can all be fixed without the
    // file being sent again; the retry schedule gives the operator that time.
    true,
  );
  if (CARRIED_ERRNO.has(code)) Object.assign(failure, { code });
  return failure;
}

/** Copy a local Bot API file, reporting progress the same way as a stream. */
async function copyWithProgress(
  source: string,
  destination: string,
  total: number,
  opts: DownloadOptions,
): Promise<void> {
  let copied = 0;
  let lastReport = 0;

  const read = fs.createReadStream(source, { highWaterMark: 4 * 1024 * 1024 });
  const write = fs.createWriteStream(destination, { mode: config.storage.fileMode });

  try {
    await pipeline(
      read,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          copied += chunk.length;
          if (opts.shouldCancel && (await opts.shouldCancel())) throw new DownloadCancelledError();
          if (opts.onProgress && copied - lastReport > 4 * 1024 * 1024) {
            lastReport = copied;
            await opts.onProgress(copied, total);
          }
          yield chunk;
        }
      },
      write,
    );
  } catch (err) {
    await removeQuietly(destination);
    throw err;
  }

  // The local Bot API server keeps its own copy; remove it so the disk does
  // not fill with duplicates. Failure here is not fatal.
  await fsp.unlink(source).catch(() => {});
  await opts.onProgress?.(copied, total);
}
