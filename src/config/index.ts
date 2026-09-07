import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';

/**
 * Central, validated configuration.
 *
 * Every value that can vary between deployments lives here and comes from the
 * environment. Nothing in the rest of the codebase reads `process.env`
 * directly, and no path is hard-coded outside this module.
 */

/**
 * A flag. Only the spellings below are accepted, in either case; anything else
 * is a configuration error rather than a silent `false`. A typo in a
 * security-relevant flag — `ADMIN_COOKIE_SECURE=ture`, `TRUST_PROXY=loopback`
 * — used to yield the permissive default without a word.
 */
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      if (/^(1|true|yes|on)$/i.test(v)) return true;
      if (/^(0|false|no|off)$/i.test(v)) return false;
      ctx.addIssue({ code: 'custom', message: `expected true/false, got ${JSON.stringify(v)}` });
      return z.NEVER;
    });

/**
 * An integer no smaller than `min`. Every count, port and interval has a floor
 * below which the process cannot work — a pool of -3 connections, a queue with
 * no slots, a sign-in that expires before it is issued — and those used to
 * pass validation and fail later, somewhere with a stack trace.
 */
const int = (def: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().min(min));

const num = (def: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().min(min));

/** An octal file mode such as `0750`. */
const mode = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v))
    .pipe(z.string().regex(/^0?[0-7]{3,4}$/, 'expected an octal mode such as 0750'));

const str = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v));

/**
 * Walk up from this module until a directory containing package.json is found.
 *
 * A fixed number of `..` hops would be wrong for at least one of the build
 * outputs: this file lands in `dist/config/` for the services and in
 * `dist-tests/src/config/` for the test build.
 */
function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start, '..', '..');
}

const ROOT = findProjectRoot(import.meta.dirname);

const schema = z.object({
  NODE_ENV: str('production'),

  /**
   * The name this deployment shows to its users: the browser title of the
   * dashboard and the heading inside the Telegram Mini App. Purely cosmetic,
   * but it is the one string every user of your instance reads, so it belongs
   * in configuration rather than in the markup.
   */
  APP_NAME: str('JellyGram'),

  // --- Telegram -------------------------------------------------------------
  // Optional at load time so the dashboard and worker still start before a
  // token has been issued; the bot process refuses to run without one.
  TELEGRAM_BOT_TOKEN: str(''),
  /**
   * Base URL of the Bot API. Point this at a self-hosted `telegram-bot-api`
   * instance running with `--local` to lift the 20 MB download ceiling that
   * the public Bot API enforces.
   */
  TELEGRAM_API_ROOT: str('https://api.telegram.org'),
  /**
   * When the Bot API server runs in local mode it returns absolute paths
   * instead of a download URL, and we move the file instead of streaming it.
   */
  TELEGRAM_LOCAL_MODE: bool(false),
  /**
   * The two sides of the local Bot API server's data bind mount.
   *
   * getFile returns a path as the *container* sees it; the worker runs on the
   * host. These map one to the other. Leave them equal when the Bot API server
   * runs directly on the host rather than in a container.
   */
  TELEGRAM_LOCAL_FILE_ROOT: str('/var/lib/telegram-bot-api'),
  TELEGRAM_LOCAL_HOST_ROOT: str(''),
  TELEGRAM_ADMIN_CHAT_ID: str(''),

  /**
   * How long one `getFile` HTTP request may block before it is retried.
   *
   * In `--local` mode `getFile` does not answer until the Bot API server has
   * fetched the whole file from Telegram, which for a multi-gigabyte movie
   * takes many minutes. The request is therefore polled rather than waited on:
   * the server keeps downloading in the background after a client disconnects,
   * so each retry either resumes the wait or returns the finished path.
   */
  TELEGRAM_GETFILE_TIMEOUT_SEC: int(60, 1),
  /** Gap between `getFile` polls while the server is still fetching. */
  TELEGRAM_GETFILE_POLL_SEC: int(15, 1),
  /**
   * Slowest transfer rate the server is assumed to achieve, used to derive how
   * long a given file is allowed to take. The 300 KB/s default is deliberately
   * pessimistic — measure your own link and leave several times the headroom,
   * because the cost of guessing high is a spurious timeout on a real upload.
   */
  TELEGRAM_GETFILE_MIN_BYTES_PER_SEC: num(300 * 1024, 1),
  /** Absolute ceiling on the wait, whatever the size-derived budget says. */
  TELEGRAM_GETFILE_MAX_WAIT_SEC: int(4 * 60 * 60, 1),
  /**
   * How often the server-side fetch is sampled for progress.
   *
   * Independent of the poll interval: a `getFile` poll blocks for up to
   * `TELEGRAM_GETFILE_TIMEOUT_SEC` before failing, so driving progress from the
   * poll loop would update the user about once a minute.
   */
  TELEGRAM_PROGRESS_TICK_MS: int(2000, 100),

  // --- MTProto ingestion ----------------------------------------------------
  /**
   * Fetch forwarded media the Bot API is too small to carry, using the owner's
   * own Telegram account. Off unless explicitly enabled and authenticated.
   */
  TELEGRAM_API_ID: str(''),
  TELEGRAM_API_HASH: str(''),
  TELEGRAM_MTPROTO_ENABLED: bool(false),
  TELEGRAM_MTPROTO_SESSION_PATH: str(''),
  /** Ceiling for a file fetched over MTProto. 5 GiB. */
  MTPROTO_MAX_FILE_BYTES: num(5 * 1024 * 1024 * 1024, 1),
  /** Chunk size for the streamed download; bounds memory use. */
  MTPROTO_CHUNK_BYTES: int(1024 * 1024, 4096),
  /** How many recent messages of the owner's bot dialog to search. */
  MTPROTO_SEARCH_DEPTH: int(60, 1),
  /** Attempts before a download job is given up on. */
  MTPROTO_MAX_ATTEMPTS: int(3, 1),
  /**
   * Longest gap allowed between two chunks of an MTProto download.
   *
   * `iterDownload` takes no signal and no timeout, so a connection that stalls
   * silently blocks `for await` forever and holds a worker slot until the
   * process is restarted. This bounds a stall without bounding the transfer:
   * a slow but progressing download resets it on every chunk.
   */
  MTPROTO_STALL_TIMEOUT_SEC: int(120, 1),
  /** Which media user owns everything this MTProto account ingests. */
  MTPROTO_OWNER_TELEGRAM_ID: str(''),

  // --- Telegram Mini App ----------------------------------------------------
  MINIAPP_ENABLED: bool(true),
  /**
   * How long a signed `initData` blob stays acceptable.
   *
   * Telegram signs it once when the app opens and never refreshes it while the
   * app stays open, so this is really "how long may one sitting last". Too
   * short logs somebody out mid-upload; too long widens the window in which a
   * captured blob could be replayed. A day is Telegram's own norm.
   */
  MINIAPP_MAX_AGE_SEC: int(86_400, 1),
  /**
   * The HTTPS address Telegram opens. Telegram refuses plain HTTP, so leaving
   * this empty simply means no button is registered rather than registering
   * one that cannot work.
   */
  MINIAPP_URL: str(''),

  // --- Database -------------------------------------------------------------
  /**
   * Checked for shape, not just presence.
   *
   * `z.string().min(1)` accepted a typo like `postgres//user@host/db` and
   * handed it to `pg`, which parsed what it could and failed much later with
   * `getaddrinfo EAI_AGAIN base` — an error naming a hostname the reader never
   * typed. A connection string that cannot be a PostgreSQL URL is a
   * configuration error, and configuration errors belong here, where they are
   * reported by name alongside everything else that was wrong.
   */
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (v) => {
        try {
          const u = new URL(v);
          return (
            (u.protocol === 'postgresql:' || u.protocol === 'postgres:') && u.hostname.length > 0
          );
        } catch {
          return false;
        }
      },
      {
        message:
          'must be a PostgreSQL connection string, for example ' +
          'postgresql://user:password@127.0.0.1:5432/dbname',
      },
    ),
  DB_POOL_MAX: int(6, 1),

  // --- Jellyfin -------------------------------------------------------------
  JELLYFIN_URL: str('http://127.0.0.1:8096'),
  /**
   * The address a *person's browser* uses, which is not the address this
   * server uses. `JELLYFIN_URL` is how the API reaches Jellyfin — loopback
   * here — and sending that to a phone would point it at the phone itself.
   * Empty falls back to `JELLYFIN_URL`, which is right when the two coincide.
   */
  JELLYFIN_PUBLIC_URL: str(''),
  JELLYFIN_TAILSCALE_URL: str(''),
  JELLYFIN_INTERNET_URL: str(''),
  JELLYFIN_API_KEY: str(''),
  /** Prefix used when this app creates per-user Jellyfin libraries. */
  JELLYFIN_LIBRARY_PREFIX: str(''),

  // --- Storage --------------------------------------------------------------
  MEDIA_ROOT: str(path.join(ROOT, 'media')),
  MOVIES_ROOT: str(''),
  TV_ROOT: str(''),
  /** Scratch space for in-flight downloads; must be on the same filesystem as MEDIA_ROOT. */
  DOWNLOAD_TMP_DIR: str(''),
  /**
   * How long a file in DOWNLOAD_TMP_DIR must sit untouched before the reaper
   * is allowed to delete it.
   *
   * Deliberately generous. A file being written right now is protected by its
   * modification time, but a download that stalls for longer than this and
   * then resumes would lose its scratch file, so this is the floor on how
   * slow an ingestion may be. Fractional values are allowed for testing.
   */
  DOWNLOAD_TMP_GRACE_HOURS: num(24, 0),
  /** Where files land when identification fails; never deleted automatically. */
  QUARANTINE_DIR: str(''),
  MAX_FILE_SIZE_BYTES: num(2000 * 1024 * 1024, 1),
  MIN_FREE_DISK_BYTES: num(10 * 1024 * 1024 * 1024, 0),
  /** Extra headroom over the file size required before a download starts. */
  DISK_SAFETY_MARGIN_BYTES: num(2 * 1024 * 1024 * 1024, 0),
  ALLOWED_EXTENSIONS: str('mp4,mkv,avi,mov'),
  /**
   * Ceiling for a file assembled from parts.
   *
   * Telegram cannot deliver this in one piece; it is reached by splitting the
   * file locally and letting the server reassemble it.
   */
  MAX_ASSEMBLED_FILE_BYTES: num(5 * 1024 * 1024 * 1024, 1),
  /** Parts stop being accepted, and an idle session is finalised, after this. */
  MULTIPART_IDLE_MINUTES: int(30, 1),
  /** Refuse a session that would need more pieces than this. */
  MULTIPART_MAX_PARTS: int(64, 1),
  /**
   * How long a permanently failed session keeps its uploaded parts.
   *
   * Assembly deliberately retains them so a retry does not have to re-upload
   * gigabytes. Nothing expired them before, so a session that failed and was
   * never retried held its parts forever. Three days is long enough to notice
   * and retry, short enough that the disk is not held indefinitely.
   */
  MULTIPART_FAILED_RETENTION_HOURS: num(72, 0),

  // --- Direct uploader ------------------------------------------------------
  /**
   * Largest file the uploader sends in one piece. Above this it switches to
   * parts automatically. 2 GiB by default.
   */
  UPLOAD_SINGLE_MAX_BYTES: num(2 * 1024 * 1024 * 1024, 1),
  /** Size of each piece when the uploader does split. */
  UPLOAD_PART_BYTES: num(1024 * 1024 * 1024, 1),
  /** Hard cap on any single request body the ingest endpoint accepts. */
  UPLOAD_PART_MAX_BYTES: num(2 * 1024 * 1024 * 1024, 1),
  /** Group that owns media directories so Jellyfin can read them. */
  MEDIA_GROUP: str('jellyfin'),
  MEDIA_DIR_MODE: mode('0750'),
  MEDIA_FILE_MODE: mode('0640'),

  // --- TMDB -----------------------------------------------------------------
  TMDB_API_KEY: str(''),
  TMDB_LANGUAGE: str('en-US'),

  // --- Admin dashboard ------------------------------------------------------
  ADMIN_SESSION_SECRET: z.string().min(16, 'ADMIN_SESSION_SECRET must be at least 16 characters'),
  ADMIN_PORT: int(8300, 1).pipe(z.number().max(65535)),
  ADMIN_BIND_HOST: str('0.0.0.0'),
  ADMIN_SESSION_TTL_HOURS: int(12, 1),
  ADMIN_COOKIE_SECURE: bool(false),
  /**
   * Behind a TLS-terminating reverse proxy, set to true so the forwarded
   * client address and protocol are believed — from loopback only, which is
   * where such a proxy connects from. A boolean, not an Express trust value.
   */
  TRUST_PROXY: bool(false),

  // --- Worker ---------------------------------------------------------------
  /**
   * How long a single HTTP request to the admin/upload API may take.
   *
   * Node defaults `requestTimeout` to 300s, which silently kills any upload
   * that takes longer than five minutes — a 2 GiB single-piece upload over a
   * slow link does. Headers stay on a short timeout, so a slowloris attack is
   * still bounded.
   */
  API_REQUEST_TIMEOUT_SEC: int(4 * 60 * 60, 1),
  API_HEADERS_TIMEOUT_SEC: int(60, 1),

  // --- Backups --------------------------------------------------------------
  /** Where compressed dumps are written. Kept off the media tree on purpose. */
  BACKUP_DIR: str(''),
  /** Dumps older than this are pruned after each successful run. */
  BACKUP_RETENTION_DAYS: num(14, 0),
  /** A backup older than this is reported as stale on the dashboard. */
  BACKUP_STALE_HOURS: num(36, 0),

  /**
   * Drain mode: accept work but do not let a worker claim it.
   *
   * Newly enqueued jobs are dated far ahead, so `claim` — which requires
   * `run_after <= now()` — passes over them. Nothing is lost; the work simply
   * waits. Useful before a migration or a restart, and used by the test suite
   * so that a test driving a handler directly cannot also have the live worker
   * run the same job against the real media root.
   */
  QUEUE_PAUSED: bool(false),

  /**
   * Accepted for compatibility and reported on the settings page; the worker's
   * capacity is the two lane sizes below, and this value does not change it.
   */
  WORKER_CONCURRENCY: int(1, 1),
  /**
   * Slots reserved for long transfers, and for everything else.
   *
   * Kept deliberately small by default. On a small server — little RAM, one
   * spinning disk — more parallel transfers make every one of them slower
   * rather than finishing sooner. Raise them if your hardware justifies it.
   * The point of the split is not throughput, it is that a short upload is
   * never stuck behind two long ones.
   */
  WORKER_LARGE_CONCURRENCY: int(1, 1),
  WORKER_SMALL_CONCURRENCY: int(2, 1),
  /** At or above this an upload is treated as a long transfer. */
  WORKER_LARGE_UPLOAD_BYTES: num(512 * 1024 * 1024, 0),
  WORKER_POLL_INTERVAL_MS: int(2000, 100),
  /** How often queued uploads are told their current position. */
  QUEUE_REFRESH_INTERVAL_MS: int(10_000, 1000),
  /** How often health is re-checked. Alerts fire on change, not on this tick. */
  HEALTH_CHECK_INTERVAL_MS: int(5 * 60_000, 1000),
  JOB_MAX_ATTEMPTS: int(3, 1),
  JOB_RETRY_BACKOFF_MS: int(30_000, 0),
  /** Ceiling on the exponential retry delay. */
  JOB_RETRY_MAX_BACKOFF_MS: int(30 * 60_000, 0),
  /** Minimum gap between Telegram progress message edits. */
  PROGRESS_EDIT_INTERVAL_MS: int(5000, 0),
  PROGRESS_EDIT_MIN_DELTA: num(2, 0),
  /** Seconds to wait for Jellyfin to surface a newly added item. */
  JELLYFIN_VERIFY_TIMEOUT_SEC: int(180, 0),
  JELLYFIN_VERIFY_INTERVAL_SEC: int(10, 1),

  // --- Logging --------------------------------------------------------------
  LOG_LEVEL: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 'info' : v.toLowerCase()))
    .pipe(z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])),
  LOG_DIR: str(path.join(ROOT, 'logs')),
  LOG_TO_FILE: bool(true),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // Written to stderr rather than the logger: the logger itself needs config.
  process.stderr.write(`Invalid configuration:\n${issues}\n`);
  process.exit(78); // EX_CONFIG
}

const e = parsed.data;

const mediaRoot = path.resolve(e.MEDIA_ROOT);
const moviesRoot = path.resolve(e.MOVIES_ROOT || path.join(mediaRoot, 'movies'));
const tvRoot = path.resolve(e.TV_ROOT || path.join(mediaRoot, 'tv'));
const downloadTmpDir = path.resolve(e.DOWNLOAD_TMP_DIR || path.join(mediaRoot, '.incoming'));
const quarantineDir = path.resolve(e.QUARANTINE_DIR || path.join(mediaRoot, '.quarantine'));

export const config = {
  projectRoot: ROOT,
  appName: e.APP_NAME,
  nodeEnv: e.NODE_ENV,
  isProduction: e.NODE_ENV === 'production',

  telegram: {
    botToken: e.TELEGRAM_BOT_TOKEN,
    apiRoot: e.TELEGRAM_API_ROOT.replace(/\/+$/, ''),
    localMode: e.TELEGRAM_LOCAL_MODE,
    localFileRoot: e.TELEGRAM_LOCAL_FILE_ROOT,
    // Resolved against the project, not the working directory: `./botapi-data`
    // in .env is the same directory docker compose bind-mounts, and it must
    // still mean that when a systemd unit starts the worker from elsewhere.
    localHostRoot: path.resolve(ROOT, e.TELEGRAM_LOCAL_HOST_ROOT || 'botapi-data'),
    getFileTimeoutMs: e.TELEGRAM_GETFILE_TIMEOUT_SEC * 1000,
    getFilePollMs: e.TELEGRAM_GETFILE_POLL_SEC * 1000,
    getFileMinBytesPerSec: e.TELEGRAM_GETFILE_MIN_BYTES_PER_SEC,
    getFileMaxWaitMs: e.TELEGRAM_GETFILE_MAX_WAIT_SEC * 1000,
    progressTickMs: e.TELEGRAM_PROGRESS_TICK_MS,
    adminChatId: e.TELEGRAM_ADMIN_CHAT_ID,
    get configured() {
      return /^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(e.TELEGRAM_BOT_TOKEN);
    },
  },

  mtproto: {
    enabled: e.TELEGRAM_MTPROTO_ENABLED,
    sessionPath: e.TELEGRAM_MTPROTO_SESSION_PATH || path.join(ROOT, '.mtproto-session'),
    maxFileBytes: e.MTPROTO_MAX_FILE_BYTES,
    chunkBytes: e.MTPROTO_CHUNK_BYTES,
    searchDepth: e.MTPROTO_SEARCH_DEPTH,
    maxAttempts: e.MTPROTO_MAX_ATTEMPTS,
    stallTimeoutMs: e.MTPROTO_STALL_TIMEOUT_SEC * 1000,
    ownerTelegramId: e.MTPROTO_OWNER_TELEGRAM_ID,
    /** api_id / api_hash are shared with the local Bot API server. */
    get credentialsPresent() {
      return e.TELEGRAM_API_ID.length > 0 && e.TELEGRAM_API_HASH.length > 0;
    },
    apiId: Number(e.TELEGRAM_API_ID || 0),
    apiHash: e.TELEGRAM_API_HASH,
  },

  db: {
    url: e.DATABASE_URL,
    poolMax: e.DB_POOL_MAX,
  },

  miniapp: {
    enabled: e.MINIAPP_ENABLED,
    maxAgeSec: e.MINIAPP_MAX_AGE_SEC,
    url: e.MINIAPP_URL.replace(/\/+$/, ''),
    get configured() {
      return e.MINIAPP_ENABLED && e.MINIAPP_URL.startsWith('https://');
    },
  },

  jellyfin: {
    url: e.JELLYFIN_URL.replace(/\/+$/, ''),
    publicUrl: (e.JELLYFIN_PUBLIC_URL || e.JELLYFIN_URL).replace(/\/+$/, ''),
    // The other two doors the Mini App can measure its way through. `publicUrl`
    // keeps its name and meaning — the LAN address a phone at home uses — so
    // nothing that already reads it changes.
    tailscaleUrl: e.JELLYFIN_TAILSCALE_URL.replace(/\/+$/, ''),
    internetUrl: e.JELLYFIN_INTERNET_URL.replace(/\/+$/, ''),
    apiKey: e.JELLYFIN_API_KEY,
    libraryPrefix: e.JELLYFIN_LIBRARY_PREFIX,
    verifyTimeoutSec: e.JELLYFIN_VERIFY_TIMEOUT_SEC,
    verifyIntervalSec: e.JELLYFIN_VERIFY_INTERVAL_SEC,
    get configured() {
      return e.JELLYFIN_API_KEY.length > 0;
    },
  },

  storage: {
    mediaRoot,
    moviesRoot,
    tvRoot,
    downloadTmpDir,
    downloadTmpGraceHours: e.DOWNLOAD_TMP_GRACE_HOURS,
    quarantineDir,
    maxFileSizeBytes: e.MAX_FILE_SIZE_BYTES,
    minFreeDiskBytes: e.MIN_FREE_DISK_BYTES,
    diskSafetyMarginBytes: e.DISK_SAFETY_MARGIN_BYTES,
    allowedExtensions: e.ALLOWED_EXTENSIONS.split(',')
      .map((x) => x.trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean),
    mediaGroup: e.MEDIA_GROUP,
    dirMode: parseInt(e.MEDIA_DIR_MODE, 8),
    fileMode: parseInt(e.MEDIA_FILE_MODE, 8),
  },

  upload: {
    /** At or below this, the uploader sends the file whole. */
    singleMaxBytes: e.UPLOAD_SINGLE_MAX_BYTES,
    partBytes: e.UPLOAD_PART_BYTES,
    partMaxBytes: e.UPLOAD_PART_MAX_BYTES,
  },

  multipart: {
    maxAssembledBytes: e.MAX_ASSEMBLED_FILE_BYTES,
    idleMinutes: e.MULTIPART_IDLE_MINUTES,
    maxParts: e.MULTIPART_MAX_PARTS,
    failedRetentionHours: e.MULTIPART_FAILED_RETENTION_HOURS,
    /** Where in-flight parts live, one directory per session. */
    get partsDir() {
      return path.join(config.storage.mediaRoot, '.parts');
    },
  },

  tmdb: {
    apiKey: e.TMDB_API_KEY,
    language: e.TMDB_LANGUAGE,
    get configured() {
      return e.TMDB_API_KEY.length > 0;
    },
  },

  admin: {
    sessionSecret: e.ADMIN_SESSION_SECRET,
    port: e.ADMIN_PORT,
    bindHost: e.ADMIN_BIND_HOST,
    requestTimeoutMs: e.API_REQUEST_TIMEOUT_SEC * 1000,
    headersTimeoutMs: e.API_HEADERS_TIMEOUT_SEC * 1000,
    sessionTtlHours: e.ADMIN_SESSION_TTL_HOURS,
    cookieSecure: e.ADMIN_COOKIE_SECURE,
    trustProxy: e.TRUST_PROXY,
  },

  backup: {
    dir: e.BACKUP_DIR || path.join(ROOT, 'backups'),
    retentionDays: e.BACKUP_RETENTION_DAYS,
    staleHours: e.BACKUP_STALE_HOURS,
  },

  worker: {
    paused: e.QUEUE_PAUSED,
    concurrency: e.WORKER_CONCURRENCY,
    largeConcurrency: e.WORKER_LARGE_CONCURRENCY,
    smallConcurrency: e.WORKER_SMALL_CONCURRENCY,
    largeUploadBytes: e.WORKER_LARGE_UPLOAD_BYTES,
    pollIntervalMs: e.WORKER_POLL_INTERVAL_MS,
    queueRefreshMs: e.QUEUE_REFRESH_INTERVAL_MS,
    healthIntervalMs: e.HEALTH_CHECK_INTERVAL_MS,
    maxAttempts: e.JOB_MAX_ATTEMPTS,
    retryBackoffMs: e.JOB_RETRY_BACKOFF_MS,
    retryMaxBackoffMs: e.JOB_RETRY_MAX_BACKOFF_MS,
    progressEditIntervalMs: e.PROGRESS_EDIT_INTERVAL_MS,
    progressEditMinDelta: e.PROGRESS_EDIT_MIN_DELTA,
  },

  log: {
    level: e.LOG_LEVEL,
    dir: path.resolve(e.LOG_DIR),
    toFile: e.LOG_TO_FILE,
  },
} as const;

export type AppConfig = typeof config;

/** Create the directory tree the application owns. Safe to call repeatedly. */
export function ensureDirectories(): void {
  for (const dir of [
    config.storage.mediaRoot,
    config.storage.moviesRoot,
    config.storage.tvRoot,
    config.storage.downloadTmpDir,
    config.storage.quarantineDir,
    config.multipart.partsDir,
    config.log.dir,
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: config.storage.dirMode });
  }
}
