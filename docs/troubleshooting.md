# Troubleshooting

## Diagnostics first

```bash
# What the application thinks is wrong
curl -s http://127.0.0.1:8300/api/health

# Why a specific upload failed: stage, error code, retryability
npm run upload:diagnose -- --upload-id <id>
npm run upload:diagnose -- --failed        # the recent ones

# Is per-user isolation intact?
npm run jellyfin:audit

# Logs
journalctl --user -u jellygram-worker -f
tail -f logs/worker.log-$(date +%F)
```

The dashboard's **Health** page runs the same checks the alerting does, and its
**Logs** page shows the same files, so day-to-day diagnosis does not need shell
access.

## Startup

**A process exits immediately with a list of variables.**
That is exit 78, `EX_CONFIG`. The message names exactly which variables failed
validation and why. Fix `.env` and start again; `RestartPreventExitStatus=78`
means systemd deliberately will not retry a typo forever.

**The bot exits 0 saying it has no token.**
Working as intended. The api and worker run without `TELEGRAM_BOT_TOKEN`; the
bot has nothing to do, so it says so and stops rather than crash-looping.

**"DATABASE_URL is not set and .env does not declare one".**
From the test helper. Copy `.env.example` to `.env` (or run `npm run init`) and
set `DATABASE_URL`.

**Database connection refused.**
Is PostgreSQL up? With the bundled container, `npm run db:up` and
`docker logs jellygram-postgres`. Check the host, port and database name in
`DATABASE_URL` — the bundled compose file uses **55432**, not 5432, so that it
cannot collide with a PostgreSQL already on the host.

**"The database role may not create databases".**
Only the test suite needs this. Grant `CREATEDB`, or create the scratch database
once by hand — the error prints the exact command.

## Uploads

**"You are not registered."**
Expected for an unknown Telegram ID. Add the user in the dashboard; see
[telegram.md](telegram.md#3-register-users).

**"Telegram will not let this bot download…"**
The file is over 20 MB and no local Bot API server is configured. Pick a route
from [large-files.md](large-files.md).

**Uploads stuck in `QUEUED`.**
Either no worker is running (`systemctl --user status jellygram-worker`), or
`QUEUE_PAUSED=true` — drain mode accepts work and claims none, which is exactly
what it looks like from the outside. Check the Settings page.

**An upload sits on "Awaiting review".**
`NEEDS_REVIEW` is terminal but is *not* a failure. The parser was not confident
enough to file it, so it is in `QUARANTINE_DIR` rather than guessed at. Rename
it closer to the release title — `Title.Year.mkv` or `Show.SxxEyy.mkv` — and
send it again. Nothing is deleted from quarantine automatically.

**An upload fails with a timeout on a big file, in local Bot API mode.**
`getFile` blocks until the Bot API server has fetched the whole file from
Telegram, which for a multi-gigabyte film is many minutes. Raise
`TELEGRAM_GETFILE_MAX_WAIT_SEC` or lower
`TELEGRAM_GETFILE_MIN_BYTES_PER_SEC`, then
`npm run upload:diagnose -- --upload-id <id>` to confirm it was the wait and not
something else.

**Progress shows a stage but no percentage.**
Expected in one case: the Bot API server's partial download cannot always be
told apart from another concurrent fetch. The transfer is fine; a percentage is
withheld rather than invented.

**"Upload failed" with no detail in the chat.**
`npm run upload:diagnose -- --failed` shows the stage, error code and
retryability of recent failures. The chat message is deliberately short; the
diagnostics are not.

**A multi-part session never completes.**
It needs every part. Check the *Multipart* page for which index is missing. A
session that goes idle with **gaps** is expired and its parts deleted after
`MULTIPART_IDLE_MINUTES`; one that is contiguous is assembled. Send the missing
part and then `/finish`.

## Jellyfin

**Media is on disk but not in Jellyfin.**
Almost always group ownership. Check:

```bash
find "$MOVIES_ROOT" -not -group "$MEDIA_GROUP" | head
stat -c '%A %U:%G %n' "$MEDIA_ROOT" "$MOVIES_ROOT"
```

The `find` should print nothing, and every directory should be `drwxr-s---` with
the media group. Jellyfin's own log says *"Library folder … is inaccessible or
empty"* when this is the cause.

```bash
npm run media:repair
npm run jellyfin:reverify
```

Remember every *parent* has to be traversable too. If your media lives under a
home directory, that directory needs at least `drwxr-x--x`.

**`jellyfin_verified` stays false after a scan.**
`npm run jellyfin:reverify` re-scans and re-checks every unverified item without
re-uploading anything. A large library scans slowly; raising
`JELLYFIN_VERIFY_TIMEOUT_SEC` is a reasonable response to a big collection.

**Health says "API key rejected".**
Somebody revoked it in the Jellyfin UI, or the key was copied wrong. Run
`npm run jellyfin:bootstrap` again.

**The Privacy page shows errors.**
Click *Re-apply isolation*, or `npm run jellyfin:audit -- --fix`. If it keeps
reverting, check whether the account is a Jellyfin **administrator** —
administrators see every library by design and no setting here changes that.

**Jellyfin logs `UnauthorizedAccessException … Permission denied` on every
scan.**
A metadata saver trying to write `.nfo` files into a tree it may only read.
Libraries created by this application set `MetadataSavers: []`; older ones are
healed by `disableLocalMetadataSavers()`, which runs during provisioning — so
re-provision the user.

## Dashboard

**Unreachable.**
`systemctl --user status jellygram-api`, then
`curl http://127.0.0.1:8300/api/health`. If loopback works and remote does not,
`ADMIN_BIND_HOST` is `127.0.0.1` — which is the safe default. See
[networking.md](networking.md).

**Blank page; the console shows `ERR_SSL_PROTOCOL_ERROR` for
`https://…:8300/css/app.css`.**
The CSP is sending `upgrade-insecure-requests`, so the browser rewrote every
asset URL to `https://` on a port that speaks plain HTTP. It must only be sent
when `ADMIN_COOKIE_SECURE=true`. Set it back to `false` on a plain-HTTP
deployment. `npm run test:http` verifies this.

**Sign-in fails over HTTPS behind a proxy, but works on loopback.**
`ADMIN_COOKIE_SECURE` and `TRUST_PROXY` must both be `true`, and TLS must
actually be terminating in front. A Secure cookie is never sent back over plain
HTTP, so setting the flag before HTTPS works looks exactly like a wrong
password. Revert to `false`, confirm HTTPS serves the page, then set both.

**Locked out by the login throttle.**
8 failures per account in 15 minutes, or 30 per address. Wait, or restart the
api process — the tracking is in memory.

**Forgot the admin password.**
`npm run admin:create -- --user <name>` generates a new one and prints it once.

## Mini App

**The menu button never appears.**
`MINIAPP_URL` must be set to an **https** address and the bot restarted. Telegram
refuses plain HTTP, bare IP addresses and self-signed certificates. With the URL
empty, no button is registered at all — by design.

**It opens and immediately says you are not registered.**
Authentication succeeded, authorisation did not: the Telegram account that
opened it is not in the `users` table. That is the correct response to a valid
signature from a stranger.

**Everything 401s with `BAD_INIT_DATA`.**
The blob is signed with a *different* bot's token than the one in `.env`. Common
after switching bots, or when a development and a production deployment share a
URL.

**Everything 503s.**
`TELEGRAM_BOT_TOKEN` is unset, so there is nothing to verify signatures against.
The Mini App cannot work without it even though the API otherwise can.

**"Open Jellyfin" opens the wrong address, or hangs.**
It probes `JELLYFIN_TAILSCALE_URL` → `JELLYFIN_PUBLIC_URL` →
`JELLYFIN_INTERNET_URL` and opens the first that answers. Unset the ones that
are not real: an address that never answers costs a probe timeout on every open.

## Storage

**"Not enough disk space."**
A download is refused if it would leave less than `MIN_FREE_DISK_BYTES` free, or
if the file plus `DISK_SAFETY_MARGIN_BYTES` does not fit. Nothing is ever
deleted to make room — that is deliberate.

**The staging directory keeps growing.**
The reaper sweeps hourly, but deletes only files that **nothing in the database
refers to** and that **nothing has written to for `DOWNLOAD_TMP_GRACE_HOURS`**.
A file held by a queued upload is protected however old it is. Check the worker
log for the sweep's `info` line with the count and bytes freed.

**The staging directory refuses to be reaped at all.**
The reaper will not run if `DOWNLOAD_TMP_DIR` contains the quarantine directory,
either media root, or the parts tree — the shape a `DOWNLOAD_TMP_DIR=$MEDIA_ROOT`
misconfiguration takes. Fix the configuration.

**Uploads are slow to file, and disk usage doubles during filing.**
`DOWNLOAD_TMP_DIR` is on a different filesystem from `MEDIA_ROOT`, so filing is
a copy rather than a rename. Put them on the same filesystem.

## Alerts

**No health alerts arrive.**
`TELEGRAM_ADMIN_CHAT_ID` is unset, so `notifyAdmin` has nowhere to send.
Everything is still *detected*; the Health page says so and the worker logs each
dropped alert.

**Health says the backup is stale.**
The newest dump is older than `BACKUP_STALE_HOURS`. Check
`systemctl --user list-timers jellygram-backup.timer`, and run
`npm run db:backup` by hand to see the actual error.

## Tests

**Dozens of Mini App or progress tests fail with 503 or "not configured".**
The credentials helper is missing from those files. Every suite that depends on
a configured bot token or Jellyfin key imports `./helpers/test-credentials.js`
**first**, before anything that reads configuration. See
[testing.md](testing.md).

**`test:responsive` fails with `Page.enable timed out`.**
Chrome's cold start exceeded the 20-second CDP timeout, which happens on a
loaded machine. Run it again on a quiet one before believing the failure.

**Tests want to touch a database that already has data in it.**
They cannot: the helper always rewrites `DATABASE_URL`'s database name to the
scratch one, and refuses to start if the two ever coincide. If you see live data
in a test, something is importing configuration before the helper — check the
import order.
