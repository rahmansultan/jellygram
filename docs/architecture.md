# Architecture

## Three processes, one database

```
┌────────────────────┐        ┌────────────────────┐        ┌────────────────────┐
│  jellygram-bot     │        │  jellygram-worker  │        │  jellygram-api     │
│  grammY            │        │  job runner        │        │  Express 5         │
│  long poll         │        │                    │        │  + dashboard       │
└─────────┬──────────┘        └─────────┬──────────┘        └─────────┬──────────┘
          │                             │                             │
          │  writes uploads,            │  claims jobs,               │  reads and
          │  enqueues jobs              │  runs the pipeline          │  administers
          ▼                             ▼                             ▼
                     ┌──────────────────────────────────┐
                     │            PostgreSQL            │
                     │  users · uploads · media · jobs  │
                     │  sessions · settings · audit     │
                     └──────────────────────────────────┘
                                        │
          ┌─────────────────────────────┼─────────────────────────────┐
          ▼                             ▼                             ▼
  Telegram Bot API                Jellyfin API                    TMDB API
                                        │
                                        ▼
                                  $MEDIA_ROOT/…
```

They share nothing but the database — no shared memory, no in-process queue, no
message broker. Each can be restarted independently, and each is written to
survive the other two disappearing.

The split is not for scale. It is because a multi-gigabyte download must not
stop the bot from answering `/status` or the dashboard from rendering. One
process doing all three would block on the first big file.

| Process | Entry point | Responsibility |
| --- | --- | --- |
| `bot` | `src/bot/index.ts` | Long-polls Telegram, validates the sender and the file, writes the `uploads` row, enqueues a job |
| `worker` | `src/worker/index.ts` | Claims jobs and runs the pipeline. The **only** process that writes into the media tree |
| `api` | `src/api/server.ts` | The admin dashboard and its JSON API, the Mini App API, and the direct-upload ingest endpoint |

## Source layout

```
src/
  config/     validated configuration — the only place process.env is read
  lib/        logging, path safety, prompts, .env editing, initData verification
  db/         pool, migration runner, typed repositories, row types
  services/   Telegram, Jellyfin, TMDB, storage, parsing, isolation, progress,
              multipart assembly, MTProto, quota, health, the reaper
  bot/        the Telegram bot process
  worker/     the job runner and the upload pipeline
  api/        admin API, Mini App API, upload ingest, auth, flood control
  scripts/    migrate, setup, admin:create, jellyfin:*, mtproto:*, backups…
public/       the dashboard and the Mini App — no build step, no bundler
migrations/   forward-only SQL
uploader/     jellygram-upload.mjs, a single dependency-free client
deploy/       systemd templates, an installer, the optional geofence
scripts/      init-env.mjs — the one script that must run before config exists
```

## The upload pipeline

`src/worker/pipeline.ts` runs one upload through these stages, updating
`uploads.status` at each step:

| Stage | Status | What happens |
| --- | --- | --- |
| Intake | `RECEIVED` | Sender, extension, size and free disk are validated. The `uploads` row is written |
| Queued | `QUEUED` | A `process-upload` job is enqueued |
| Download | `DOWNLOADING` | Streamed into `DOWNLOAD_TMP_DIR`. Progress edits one Telegram message |
| Identify | `PROCESSING` | `ffprobe` confirms a video stream; the filename is parsed; TMDB confirms |
| Deduplicate | `PROCESSING` | SHA-256 of the file, then a title/year or show/season/episode lookup |
| Organise | `ORGANIZING` | Moved into the Jellyfin layout under the user's own directory |
| Jellyfin | `JELLYFIN_SCAN` | A targeted library refresh, then polling until the item is actually visible |
| Done | `COMPLETED` | The `media` row is finalised; the Telegram message becomes a summary |

Terminal states: `COMPLETED`, `FAILED`, `CANCELLED`, `DUPLICATE`,
`NEEDS_REVIEW`.

`NEEDS_REVIEW` is terminal but is **not** a failure. It means the parser was not
confident enough to file the item, so it sits in `QUARANTINE_DIR` — never
deleted, never guessed at. Rename it closer to the release title and send it
again.

## Surviving a restart mid-pipeline

The `media` row is written **before** the file is moved into the library. Its
unique keys — one file per path, one title per user — *are* the reservation. Two
uploads of the same title racing each other collide at the insert, before any
file moves, and the loser's retry correctly finds the winner as a duplicate. If
the move then fails, the row is removed again.

A worker restarted between the move and the final bookkeeping is the interesting
case. The upload comes back queued, and the pipeline's first question is whether
a `media` row for it already exists:

- **Row exists, file is on disk** → the filing is done. The run resumes at the
  Jellyfin step. It does not fetch the file again, and it does not find its own
  earlier work and call it a duplicate — which is exactly what a restart used to
  produce.
- **Row exists, file is missing** → a reservation that outlived its move. The
  row is dropped and the run starts from the top.

## The job queue

PostgreSQL, not Redis and BullMQ.

The uploads this queue coordinates are already in PostgreSQL, and a job that can
fail after the file has moved but before the row is updated needs to be in the
same transaction as that row. A second datastore would buy throughput this
workload does not need — a handful of jobs an hour, each measured in minutes —
and pay for it with a consistency problem at every restart.

Claiming is `SELECT … FOR UPDATE SKIP LOCKED`, which is exactly the primitive a
work queue needs, and `run_after` gives delayed retries and drain mode for free.

**Two lanes.** `WORKER_LARGE_CONCURRENCY` slots for long transfers and
`WORKER_SMALL_CONCURRENCY` for everything else, split at
`WORKER_LARGE_UPLOAD_BYTES`. The point is not throughput: it is that a
thirty-second upload is never stuck behind two forty-minute ones. On modest
hardware — little RAM, one spinning disk — more parallel transfers make every
one of them slower, so the defaults are small.

**Drain mode.** `QUEUE_PAUSED=true` dates newly enqueued jobs far ahead, so
`claim` (which requires `run_after <= now()`) passes over them. Nothing is lost;
the work waits. Useful before a migration, and used by the test suite so a test
driving a handler directly cannot also have a live worker running the same job.

**Retries** are exponential, from `JOB_RETRY_BACKOFF_MS` up to
`JOB_RETRY_MAX_BACKOFF_MS`, capped at `JOB_MAX_ATTEMPTS`. Errors are classified
(`src/lib/errors.ts`) into retryable and not: a network blip is retried, a path
escape is not — it is a bug or an attack, and it is alertable.

## Reaping the staging directory

Four routes write into `DOWNLOAD_TMP_DIR` — the Telegram downloader, multi-part
assembly, the direct uploader's ingest endpoint, and MTProto — and only the
happy path takes the file out again. A job that fails, is cancelled, or whose
worker is killed mid-download leaves its scratch file behind for good.

`src/services/reaper.ts` sweeps once at worker startup and hourly after. A file
is deleted only when **both** hold:

- **Nothing in the database refers to it** — no non-terminal `uploads` row naming
  it in `local_source_path`, no active `upload_sessions` row naming it in
  `assembled_path`, no active `mtproto_jobs` row naming it in `temp_path`.
- **Nothing has written to it for `DOWNLOAD_TMP_GRACE_HOURS`**, measured as the
  later of `mtime` and `ctime`.

Neither test is sufficient alone. The database check misses in-flight work: the
Telegram downloader and the part-staging path both write to filenames no row
ever holds, so a database-only reaper would delete live downloads. The age check
misses queued work: an upload can sit untouched well past the grace period
waiting for a worker. Together they leave only files that nothing owns and
nothing is writing.

`DOWNLOAD_TMP_GRACE_HOURS` is therefore also the floor on how long an ingestion
may stall and still recover. Lower it with that in mind.

The reaper is deliberately timid beyond that: it never recurses and never
follows a symlink; it re-checks every path with `assertInside` before unlinking;
it refuses to run at all if the staging directory contains the quarantine
directory, either media root, or the parts tree — the shape a
`DOWNLOAD_TMP_DIR=$MEDIA_ROOT` misconfiguration would take; it reads the
directory listing *before* querying the database, so a file written and then
recorded between the two cannot look like an orphan; and a failure is logged and
swallowed, because housekeeping never stops the worker.

## Storage and ownership

Every path that reaches the filesystem goes through `src/lib/paths.ts`:
`storageSlug` for user directory names, `safeJoin` for building paths, and
`assertInside` immediately before any operation that writes or deletes. A
traversal is an error with its own class (`PathEscapeError`), classified
critical and alertable — not a 400.

Group ownership is carried by the **setgid bit** on the media directories, not
by `chown`. This matters: the worker runs under `PrivateTmp=true`, in a mount
namespace where the media group's gid may be unmapped, and `chown` to an
unmapped gid fails with `EINVAL`. Setgid works regardless of the namespace, and
a file created in a setgid directory inherits its group.

The corollary caught a real bug: `rename` and `copyFile` keep the group the file
was *created* with, so setgid on the destination does not apply to a file that
arrives by rename. Anything that will be renamed into the library must be
created with the media group in the first place — which is why the local Bot API
container runs with the media gid rather than the user's own.

## Configuration

`src/config/index.ts` is the only module that reads `process.env`. It parses the
whole environment with Zod, applies defaults, resolves every path to an absolute
one, and exposes a frozen object. A malformed value is a startup failure with a
list of what was wrong and exit code 78 (`EX_CONFIG`) — not a silent fallback.

`RestartPreventExitStatus=78` in the systemd units exists for exactly this: a bad
`.env` is not cured by restarting every five seconds forever.

## The frontend

`public/` is served as-is. No bundler, no transpiler, no framework, no CDN.
Editing a file and reloading the page is the whole development loop, and the
Content-Security-Policy can forbid every external origin because there are none.

The dashboard (`public/js/`) and the Mini App (`public/miniapp/js/`) are separate
applications that share no code, because they share almost no requirements: one
is a wide administrative table view behind a password, the other is a
single-column phone UI authenticated by Telegram.

## Design decisions worth knowing

**The application never creates Jellyfin accounts.** It creates libraries and
sets access policy on accounts that already exist. Account creation is the
administrator's decision, and doing it automatically would mean holding
credentials that can create administrators.

**Nothing is deleted to make room.** A download that would leave less than
`MIN_FREE_DISK_BYTES` free is refused before it starts. Full disks are an
operator problem, not something to solve by guessing which file matters least.

**Duplicates are detected, never overwritten.** By content hash first, then by
identity (title/year, or show/season/episode) per user. The database enforces
it with partial unique indexes, so a race between two workers cannot produce
two copies.

**Settings are read-only in the dashboard, on purpose.** The settings page
reports the effective configuration and shows secrets as present/absent flags
only. Configuration lives in `.env` and is applied by restarting — which means
what the dashboard shows is what the processes actually loaded, and there is no
second source of truth to drift.

**Progress is measured or labelled, never interpolated.** A percentage is either
byte-accurate or clearly marked as pipeline position. Where the number cannot be
known — a local Bot API server fetching a file whose partial size cannot be told
apart from another concurrent fetch — the stage is shown without a percentage
rather than with an invented one.
