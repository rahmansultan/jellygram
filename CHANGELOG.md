# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [1.0.0] — 2026-09-07

First public release.

This is the initial open-source publication of a system that had been running
privately. The functionality below is what that system does; the release itself
is the work of making it deployable by somebody else.

### Added — core

- **Telegram bot** accepting MP4, MKV, AVI and MOV from registered users only,
  with a single progress message edited in place through the whole pipeline.
- **Upload pipeline**: download → identify → deduplicate → organise → Jellyfin
  scan → verify, with per-stage status and diagnostics.
- **Identification** from the filename, confirmed against TMDB when a key is
  configured. Files the parser cannot place confidently are quarantined for
  review rather than guessed at.
- **Per-user Jellyfin isolation**: a directory pair, a library pair, and
  `EnableAllFolders = false` on the account — continuously re-verified from
  Jellyfin's own API rather than from the local database.
- **Durable job queue** in PostgreSQL, with two concurrency lanes, exponential
  retries, drain mode, and resumption of an upload interrupted mid-pipeline.
- **Admin dashboard**: users, uploads, media, storage, privacy audit, health,
  settings and logs. No build step, no bundler, no CDN.
- **Telegram Mini App**: library with posters, uploads, live progress and
  history, authenticated by verified `initData`.

### Added — routes past Telegram's file-size limits

- **Local Bot API server** support (`--local` mode), lifting 20 MB to 2000 MB,
  with a polled `getFile` wait budget derived from file size.
- **Direct uploader** (`uploader/jellygram-upload.mjs`): one dependency-free
  file, automatic single-versus-multi-part planning, resume, retry, and no
  temporary files.
- **Multi-part uploads** through Telegram, with four recognised part-naming
  conventions and streamed reassembly.
- **MTProto ingestion** for forwarded media above the Bot API's ceiling, fetched
  through the operator's own Telegram account, chunked and hash-verified.

### Added — operations

- **Health checks and alerting** for the database, Jellyfin, disk, backups and
  repeated failures, delivered to a Telegram admin chat.
- **Nightly database backups**, gzipped and pruned, with staleness surfaced on
  the dashboard.
- **Staging reaper** that deletes only files nothing in the database references
  and nothing has written to for a grace period, and refuses to run against a
  misconfigured directory.
- **Templated systemd units** and an installer that fills them in from the host.
- **Optional Jellyfin country geofence** for internet-exposed deployments.

### Added — for this release specifically

- `npm run init` — creates `.env` from `.env.example`, generates
  `ADMIN_SESSION_SECRET`, and picks sane local paths. It is plain JavaScript
  outside the TypeScript build because it must run before the configuration
  module can load.
- `APP_NAME`, so a deployment names itself instead of carrying its author's
  branding. Served on the authenticated `/me` and `/api/health`, and
  deliberately *not* on the Mini App's unauthenticated `/config`.
- `docker-compose.yml` for PostgreSQL, on loopback port 55432 so it cannot
  collide with a host installation.
- `docs/` — architecture, configuration, database, Telegram, Jellyfin,
  networking, large files, the Mini App, the HTTP API, testing, security and
  troubleshooting.
- `deploy/README.md`, `CONTRIBUTING.md`, `SECURITY.md`, an MIT `LICENSE`, and
  GitHub issue and pull-request templates.
- Readable startup failures. An unreachable database, a rejected password, a
  media root that cannot be written and a port already in use each print a
  sentence naming the setting to change, instead of a pino record with a stack
  trace in it. The structured record is still logged.
- `DATABASE_URL` is validated as a PostgreSQL connection string. A typo used to
  be accepted and surface much later as `getaddrinfo EAI_AGAIN base`; it is now
  a configuration error like any other, reported by name with exit 78.
- `FFPROBE_PATH`, for an ffprobe the default search cannot reach — Homebrew, a
  Nix store path, or a Jellyfin installed outside `/usr/lib`. Tried before the
  existing search rather than instead of it, so a stale value degrades to the
  old behaviour instead of disabling container validation.
- A guard on the commands that run compiled code. Running `npm run migrate`
  before `npm run build` said `Cannot find module '…/dist/scripts/migrate.js'`;
  it now says to run `npm run build`, and `npm run init` lists that step.

### Changed — for this release specifically

- **Test isolation completed.** Suites that silently depended on the operator's
  own configured bot token and Jellyfin key now supply their own fake
  credentials and point outbound bases at a dead port, so a test that forgets to
  stub `fetch` fails loudly instead of reaching a live server. The suite now
  runs on a fresh checkout with no credentials at all.
- The scratch test database refuses to start if its name ever equals the
  database `DATABASE_URL` names, and is overridable with
  `JELLYGRAM_TEST_DATABASE_NAME`.
- Four reaper tests that skipped themselves whenever local Bot API mode was off
  — which on a fresh clone is always — now set the mode themselves and run. The
  suite reports 431 passed, 0 skipped.
- A relative `TELEGRAM_LOCAL_HOST_ROOT` now resolves against the project
  directory rather than the working directory, so `./botapi-data` means the same
  thing to `docker compose` and to a service systemd started from elsewhere.
- The geofence script takes any country and any regional registry, finds the
  right registry automatically, and takes its always-allowed ranges from
  configuration. It refuses to apply a list that would not contain the address
  given with `--must-include`.
- Deployment units became templates (`@APP_DIR@`, `@NODE@`, `@TZ@`) rendered by
  `deploy/install-systemd.sh` from the host they run on.

[Unreleased]: https://github.com/NahomHabtamuNSC/jellygram/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/NahomHabtamuNSC/jellygram/releases/tag/v1.0.0
