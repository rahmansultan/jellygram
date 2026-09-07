import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import { config } from '../config/index.js';

/**
 * Structured logging.
 *
 * Output goes to stdout (captured by journald) and to a dated file per service
 * under LOG_DIR. Both streams are written in-process rather than through a
 * worker-thread transport: a worker transport drops records when the process
 * exits promptly, which is exactly what the CLI scripts do.
 *
 * Secrets are redacted at the serializer level so that an accidental
 * `logger.info({ err })` on an HTTP failure can never leak a bot token or an
 * API key into a log file.
 */

// `session` covers session tokens and cookies; a bare `sessionId` is a row
// number, and redacting it left every multi-part upload's log lines unable to
// say which session they were about.
const SECRET_KEY_PATTERN =
  /(token|api[_-]?key|password|secret|authorization|x-emby-token|x-mediabrowser-token|cookie|session(?!_?ids?$))/i;

/** Values that must never reach a log line, resolved once at startup. */
const literalSecrets = new Set(
  [
    config.telegram.botToken,
    config.jellyfin.apiKey,
    config.tmdb.apiKey,
    config.admin.sessionSecret,
    config.db.url,
  ].filter((s): s is string => typeof s === 'string' && s.length >= 8),
);

export function scrubString(input: string): string {
  let out = input;
  for (const secret of literalSecrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  // Bot tokens embedded in URLs, including ones we do not know about.
  out = out.replace(/\/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, '/bot[REDACTED]');
  // A local Bot API server names its data directory after the bot token, so
  // `getFile` hands back paths of the form
  // `<root>/<digits>:<secret>/documents/file_0.mkv`. The configured token is
  // already covered by `literalSecrets`; this catches a rotated or foreign one
  // that would otherwise be printed in full.
  out = out.replace(/(^|[/\\])\d{6,}:[A-Za-z0-9_-]{20,}(?=$|[/\\])/g, '$1[REDACTED]');
  // A Postgres URL with credentials, wherever it came from.
  out = out.replace(/(postgres(?:ql)?:\/\/[^:@\s]+:)[^@\s]+@/gi, '$1[REDACTED]@');
  return out;
}

/**
 * Flatten an Error into a plain, loggable object.
 *
 * `message`, `stack` and `name` are non-enumerable (or live on the prototype),
 * so `Object.entries` drops all three. Because pino runs `formatters.log`
 * *before* the `err` serializer, a generic object walk turned every logged
 * error into `{"message":"","stack":""}` — losing the cause of every failure
 * this application has ever reported. Errors are therefore unwrapped
 * explicitly, here, before the generic walk can flatten them.
 */
function scrubError(err: Error & { code?: unknown; cause?: unknown }, depth: number): unknown {
  const out: Record<string, unknown> = {
    type: err.name,
    message: scrubString(String(err.message ?? '')),
    stack: scrubString(String(err.stack ?? '')),
  };
  if (err.code !== undefined) out['code'] = scrub(err.code, depth + 1);
  // `cause` carries the original failure when an error is wrapped; without it
  // the outer message is often the least informative part of the chain.
  if (err.cause !== undefined) out['cause'] = scrub(err.cause, depth + 1);

  // Own enumerable extras (status codes, retryability flags, and the like).
  for (const [k, v] of Object.entries(err)) {
    if (k in out) continue;
    out[k] = SECRET_KEY_PATTERN.test(k) ? '[REDACTED]' : scrub(v, depth + 1);
  }
  return out;
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value instanceof Error) return scrubError(value, depth);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[REDACTED]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * A file stream that starts a new file when the calendar day changes and keeps
 * only the most recent `keep` files for its service.
 */
class DailyRotatingStream extends Writable {
  private handle: number | null = null;
  private currentDay = '';

  constructor(
    private readonly dir: string,
    private readonly service: string,
    private readonly keep = 14,
  ) {
    super({ decodeStrings: false });
    // 0750, matching the rest of the tree. The log files themselves are
    // already 0640, but a world-listable directory still discloses which
    // services exist and when each of them last ran.
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private filePath(day: string): string {
    // Dated suffix rather than a rotate-on-close rename, so the newest file is
    // always the lexicographically last one.
    return path.join(this.dir, `${this.service}.log-${day}`);
  }

  private ensureOpen(): number {
    const day = this.today();
    if (this.handle !== null && day === this.currentDay) return this.handle;

    if (this.handle !== null) {
      try {
        fs.closeSync(this.handle);
      } catch {
        // Already closed; nothing to recover.
      }
    }
    this.currentDay = day;
    this.handle = fs.openSync(this.filePath(day), 'a', 0o640);
    this.prune();
    return this.handle;
  }

  private prune(): void {
    try {
      const files = fs
        .readdirSync(this.dir)
        .filter((f) => f.startsWith(`${this.service}.log-`))
        .sort();
      for (const stale of files.slice(0, Math.max(0, files.length - this.keep))) {
        fs.unlinkSync(path.join(this.dir, stale));
      }
    } catch {
      // Pruning is housekeeping; failing it must not break logging.
    }
  }

  override _write(chunk: string | Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    try {
      fs.writeSync(this.ensureOpen(), typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    } catch (err) {
      // Never let a full or unwritable disk take the service down.
      process.stderr.write(`log write failed: ${(err as Error).message}\n`);
      cb();
    }
  }

  override _final(cb: () => void): void {
    if (this.handle !== null) {
      try {
        fs.closeSync(this.handle);
      } catch {
        /* ignore */
      }
      this.handle = null;
    }
    cb();
  }
}

const baseOptions: pino.LoggerOptions = {
  level: config.log.level,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
    log: (obj) => scrub(obj) as Record<string, unknown>,
  },
  hooks: {
    logMethod(args, method) {
      const patched = args.map((a) => (typeof a === 'string' ? scrubString(a) : a));
      return method.apply(this, patched as Parameters<typeof method>);
    },
  },
  serializers: {
    // `formatters.log` runs first and has already flattened any Error via
    // `scrubError`. This stays as a safety net for the paths pino serializes
    // directly (`logger.error(err)` with the error as the first argument),
    // and must be idempotent for the already-flattened case.
    err: (err: (Error & { code?: string }) | Record<string, unknown>) => {
      if (err instanceof Error) return scrubError(err, 0);
      return scrub(err);
    },
  },
};

function buildLogger(service: string): pino.Logger {
  // LOG_LEVEL is validated by pino itself when the logger is constructed; the
  // cast only satisfies the narrower type on stream entries.
  const level = config.log.level as pino.Level;
  const streams: pino.StreamEntry[] = [{ level, stream: process.stdout }];

  if (config.log.toFile) {
    streams.push({ level, stream: new DailyRotatingStream(config.log.dir, service) });
  }

  return pino(baseOptions, pino.multistream(streams, { dedupe: false })).child({ service });
}

let rootLogger: pino.Logger | undefined;

/** Named logger for a service (`api`, `bot`, `worker`, `cli`). */
export function createLogger(service: string): pino.Logger {
  rootLogger = buildLogger(service);
  return rootLogger;
}

/** The logger for the current process; falls back to a plain stdout logger. */
export function getLogger(): pino.Logger {
  if (!rootLogger) rootLogger = pino(baseOptions).child({ service: 'app' });
  return rootLogger;
}

export type Logger = pino.Logger;
