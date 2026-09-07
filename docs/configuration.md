# Configuration

All configuration comes from `.env`, and `.env.example` documents every variable
where it is defined. This page is the same information organised by topic, with
the reasoning that does not fit in a comment.

`src/config/index.ts` is the only module in the codebase that reads
`process.env`. Everything else takes a typed `config` object. That means these
two files are the complete configuration surface — there is no third place where
a default hides.

## How it is validated

The whole environment is parsed once, at startup, with Zod. A malformed value is
a **startup error**, not a silent default:

```
Invalid configuration:
  - ADMIN_SESSION_SECRET: ADMIN_SESSION_SECRET must be at least 16 characters
  - ADMIN_COOKIE_SECURE: expected true/false, got "ture"
```

and the process exits **78** (`EX_CONFIG`). The systemd units set
`RestartPreventExitStatus=78`, because a typo is not cured by restarting every
five seconds and logging the same line forever.

Booleans accept `1/true/yes/on` and `0/false/no/off` in either case, and nothing
else. Integers have floors — a pool of −3 connections or a session that expires
before it is issued used to pass validation and fail somewhere else, with a
stack trace instead of an explanation.

Relative paths resolve against the **project directory**, not the working
directory, so a service started from elsewhere by systemd sees the same tree you
did.

## Required

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 14+. See [database.md](database.md) |
| `ADMIN_SESSION_SECRET` | ≥ 16 characters; `npm run init` generates 48 bytes. Changing it signs everyone out. Never reuse a password |
| `TELEGRAM_BOT_TOKEN` | Only the bot process needs it. The api and worker start without one; the bot exits 0 and says so |
| `JELLYFIN_API_KEY` | Without it, libraries cannot be created and isolation cannot be enforced |

## Telegram

| Variable | Default | Notes |
| --- | --- | --- |
| `APP_NAME` | `JellyGram` | The dashboard title and the Mini App heading. Sent only to authenticated callers |
| `TELEGRAM_API_ROOT` | `https://api.telegram.org` | Point at your own `telegram-bot-api` to lift the 20 MB ceiling |
| `TELEGRAM_LOCAL_MODE` | `false` | True when `TELEGRAM_API_ROOT` is a `--local` server: `getFile` then returns a path, not a URL |
| `TELEGRAM_ADMIN_CHAT_ID` | — | Where health alerts go. Empty means alerts are detected and then discarded; the Health page reports that as a warning |

**The `getFile` wait budget** (local mode only). In `--local` mode `getFile` does
not answer until the server has fetched the *whole* file from Telegram, which for
a multi-gigabyte file is many minutes. The request is polled rather than waited
on, because the server keeps downloading after a client disconnects.

| Variable | Default | Notes |
| --- | --- | --- |
| `TELEGRAM_GETFILE_TIMEOUT_SEC` | `60` | How long one request may block before it is retried |
| `TELEGRAM_GETFILE_POLL_SEC` | `15` | Gap between polls |
| `TELEGRAM_GETFILE_MIN_BYTES_PER_SEC` | `307200` | The rate the budget is derived from. Deliberately pessimistic |
| `TELEGRAM_GETFILE_MAX_WAIT_SEC` | `14400` | Absolute ceiling, whatever the size-derived budget says |
| `TELEGRAM_PROGRESS_TICK_MS` | `2000` | How often the server-side fetch is sampled. Independent of the poll interval, because a poll blocks for up to a minute |

Measure your own link before lowering `MAX_WAIT_SEC` or raising
`MIN_BYTES_PER_SEC`. Guessing high costs a longer wait before giving up;
guessing low costs a spurious timeout on a real upload that was going to succeed.

## Jellyfin

| Variable | Default | Notes |
| --- | --- | --- |
| `JELLYFIN_URL` | `http://127.0.0.1:8096` | How **this server** reaches Jellyfin |
| `JELLYFIN_PUBLIC_URL` | falls back to `JELLYFIN_URL` | How **a person's browser** reaches it |
| `JELLYFIN_TAILSCALE_URL` | — | A private-network address; probed first by the Mini App |
| `JELLYFIN_INTERNET_URL` | — | A public address; probed last |
| `JELLYFIN_API_KEY` | — | Required |
| `JELLYFIN_LIBRARY_PREFIX` | — | e.g. `TG` → `TG Movies - alice` |
| `JELLYFIN_VERIFY_TIMEOUT_SEC` | `180` | How long to wait for a new item to appear |
| `JELLYFIN_VERIFY_INTERVAL_SEC` | `10` | How often to re-check |

`JELLYFIN_URL` and `JELLYFIN_PUBLIC_URL` being different is the normal case, not
an edge case. Handing a phone `http://127.0.0.1:8096` points it at the phone.

See [networking.md](networking.md) for how the three browser-facing addresses
are probed.

## Storage

| Variable | Default | Notes |
| --- | --- | --- |
| `MEDIA_ROOT` | `<project>/media` | Point this at a filesystem with room, not at the checkout |
| `MOVIES_ROOT` | `$MEDIA_ROOT/movies` | |
| `TV_ROOT` | `$MEDIA_ROOT/tv` | |
| `DOWNLOAD_TMP_DIR` | `$MEDIA_ROOT/.incoming` | **Must** be on the same filesystem as `MEDIA_ROOT` |
| `QUARANTINE_DIR` | `$MEDIA_ROOT/.quarantine` | Never deleted automatically |
| `DOWNLOAD_TMP_GRACE_HOURS` | `24` | Also the floor on how long an ingestion may stall and still recover |
| `MEDIA_GROUP` | `jellyfin` | Empty disables group management entirely |
| `MEDIA_DIR_MODE` | `0750` | |
| `MEDIA_FILE_MODE` | `0640` | |
| `FFPROBE_PATH` | *(empty)* | An explicit ffprobe, tried before the default search (Jellyfin's bundled build → `/usr/bin/ffprobe` → PATH). For Homebrew, Nix, or a Jellyfin outside `/usr/lib`. The search still follows it, so a stale path degrades rather than disabling container validation |
| `MAX_FILE_SIZE_BYTES` | `2097152000` | 2000 MB — the local Bot API server's own ceiling |
| `MIN_FREE_DISK_BYTES` | `10737418240` | A download that would leave less is refused |
| `DISK_SAFETY_MARGIN_BYTES` | `2147483648` | Headroom required on top of the file's size |
| `ALLOWED_EXTENSIONS` | `mp4,mkv,avi,mov` | Everything else is refused with a reason |

`DOWNLOAD_TMP_DIR` sharing a filesystem with `MEDIA_ROOT` is what makes filing a
finished download a `rename` rather than a copy of several gigabytes. Getting
this wrong does not break anything; it just makes every upload take twice as
long and doubles the peak disk usage.

## Large files

Covered properly in [large-files.md](large-files.md). The variables:

**Local Bot API server** — `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`,
`BOTAPI_DATA_DIR`, `TELEGRAM_LOCAL_FILE_ROOT`, `TELEGRAM_LOCAL_HOST_ROOT`,
`BOTAPI_UID`, `BOTAPI_GID`, `BOTAPI_VERBOSITY`.

`FILE_ROOT` and `HOST_ROOT` are the two sides of one bind mount: `getFile`
returns a path as the *container* sees it, and the worker runs on the host. Set
them equal when `telegram-bot-api` runs directly on the host.

`BOTAPI_GID` must be the **media group's** gid, not your own primary group. A
downloaded file is later *renamed* into the library and keeps the group it was
created with.

**Direct uploader** — `UPLOAD_SINGLE_MAX_BYTES` (2 GiB), `UPLOAD_PART_BYTES`
(1 GiB), `UPLOAD_PART_MAX_BYTES` (2 GiB).

**Multi-part** — `MAX_ASSEMBLED_FILE_BYTES` (5 GiB, the assembled result),
`MULTIPART_IDLE_MINUTES`, `MULTIPART_MAX_PARTS`,
`MULTIPART_FAILED_RETENTION_HOURS`.

**MTProto** — `TELEGRAM_MTPROTO_ENABLED`, `TELEGRAM_MTPROTO_SESSION_PATH`,
`MTPROTO_MAX_FILE_BYTES`, `MTPROTO_CHUNK_BYTES`, `MTPROTO_SEARCH_DEPTH`,
`MTPROTO_MAX_ATTEMPTS`, `MTPROTO_STALL_TIMEOUT_SEC`,
`MTPROTO_OWNER_TELEGRAM_ID`.

`MTPROTO_STALL_TIMEOUT_SEC` bounds a *stall*, not a transfer: a slow but
progressing download resets it on every chunk. It exists because the download
iterator takes neither a signal nor a timeout, so a connection that dies
silently would hold a worker slot until the process is restarted.

## Mini App

| Variable | Default | Notes |
| --- | --- | --- |
| `MINIAPP_ENABLED` | `true` | The master switch |
| `MINIAPP_URL` | — | Must be **https**. Empty registers no button, which is better than one that cannot work |
| `MINIAPP_MAX_AGE_SEC` | `86400` | How long one signed `initData` blob stays acceptable |

Telegram signs `initData` once when the app opens and never refreshes it while
it stays open, so `MINIAPP_MAX_AGE_SEC` is really "how long may one sitting
last". Too short logs somebody out mid-upload; too long widens the window in
which a captured blob could be replayed.

## Dashboard and security

| Variable | Default | Notes |
| --- | --- | --- |
| `ADMIN_PORT` | `8300` | |
| `ADMIN_BIND_HOST` | `0.0.0.0` in code, `127.0.0.1` in `.env.example` | Loopback is the safer answer; bind wider only deliberately |
| `ADMIN_SESSION_TTL_HOURS` | `12` | |
| `ADMIN_COOKIE_SECURE` | `false` | Only `true` when TLS genuinely terminates in front |
| `TRUST_PROXY` | `false` | Believe `X-Forwarded-*`, from loopback only |
| `API_REQUEST_TIMEOUT_SEC` | `14400` | Node's 300 s default silently kills any upload over five minutes |
| `API_HEADERS_TIMEOUT_SEC` | `60` | Kept short, so slowloris is still bounded |

`ADMIN_COOKIE_SECURE` and `TRUST_PROXY` go together and must be set **after**
HTTPS is confirmed working. A Secure cookie is never sent back over plain HTTP,
so setting it too early looks exactly like a wrong password. Without
`TRUST_PROXY`, every request appears to arrive from `127.0.0.1`, so the login
rate limiter counts the whole internet as one client and the audit log records
the proxy instead of the caller.

`ADMIN_COOKIE_SECURE` also controls whether the CSP emits
`upgrade-insecure-requests`. Sending it on a plain-HTTP port makes the browser
rewrite every asset URL to `https://` and the page renders blank with
`ERR_SSL_PROTOCOL_ERROR`. `npm run test:http` checks this.

## Worker and queue

| Variable | Default | Notes |
| --- | --- | --- |
| `QUEUE_PAUSED` | `false` | Drain mode: accept work, claim none. Nothing is lost |
| `WORKER_LARGE_CONCURRENCY` | `1` | Slots for long transfers |
| `WORKER_SMALL_CONCURRENCY` | `2` | Slots for everything else |
| `WORKER_LARGE_UPLOAD_BYTES` | `536870912` | The boundary between the two lanes |
| `WORKER_CONCURRENCY` | `1` | Reported for compatibility; the lanes decide capacity |
| `WORKER_POLL_INTERVAL_MS` | `2000` | |
| `QUEUE_REFRESH_INTERVAL_MS` | `10000` | How often queued uploads are told their position |
| `HEALTH_CHECK_INTERVAL_MS` | `300000` | Alerts fire on *change*, not on this tick |
| `JOB_MAX_ATTEMPTS` | `3` | |
| `JOB_RETRY_BACKOFF_MS` | `30000` | |
| `JOB_RETRY_MAX_BACKOFF_MS` | `1800000` | Ceiling on the exponential delay |
| `PROGRESS_EDIT_INTERVAL_MS` | `5000` | Telegram rate-limits edits aggressively |
| `PROGRESS_EDIT_MIN_DELTA` | `2` | Smallest change in percent worth an edit |
| `DB_POOL_MAX` | `6` | Per process. Three processes → roughly 3× this |

## Backups and logging

| Variable | Default | Notes |
| --- | --- | --- |
| `BACKUP_DIR` | `<project>/backups` | Gzipped plain-SQL `pg_dump` |
| `BACKUP_RETENTION_DAYS` | `14` | Pruned after each successful run |
| `BACKUP_STALE_HOURS` | `36` | After this, Health warns |
| `LOG_LEVEL` | `info` | `fatal`…`trace`, or `silent` |
| `LOG_DIR` | `<project>/logs` | Per-service, per-day files |
| `LOG_TO_FILE` | `true` | |

Media is not backed up. It is ordinary files — use whatever you already use.

## Development-only

These exist for the test suite and for local work. Do not set them in
production.

| Variable | Notes |
| --- | --- |
| `JELLYGRAM_TEST_DATABASE_NAME` | The scratch database the suite creates and destroys. Default `jellygram_test`. The suite refuses to start if it ever equals the database `DATABASE_URL` names |
| `MEDIA_ROOT` and friends | The suite overrides all five to `.test-media/` before configuration is read. You never set these for tests |
| `CHROME_BIN` | Path to Chrome for the responsive browser suite |
| `DASHBOARD_URL` | Where the browser suites point. Default `http://127.0.0.1:8300` |

See [testing.md](testing.md).
