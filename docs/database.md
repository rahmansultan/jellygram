# Database

PostgreSQL 14 or newer. Nothing exotic is used — no extensions, no stored
procedures, no `LISTEN/NOTIFY`.

## Getting one

### Option A: the bundled container

Set a password in `.env` first, then:

```bash
# .env
POSTGRES_USER=jellygram
POSTGRES_PASSWORD=<something long>
POSTGRES_DB=jellygram
POSTGRES_PORT=55432
DATABASE_URL=postgresql://jellygram:<the same password>@127.0.0.1:55432/jellygram
```

```bash
npm run db:up
npm run db:logs      # follow it
npm run db:down      # stop it; the volume, and your data, survive
```

It binds **loopback only**, on 55432 rather than 5432 so it cannot collide with
a PostgreSQL already installed on the host. The data lives in a named Docker
volume, so `docker compose down` does not take it with it — removing it for real
takes `docker volume rm`.

The credentials are baked in when the data directory is first initialised.
Changing `POSTGRES_PASSWORD` afterwards does nothing to an existing volume; use
`ALTER ROLE` instead.

### Option B: a PostgreSQL you already run

```sql
CREATE ROLE jellygram WITH LOGIN PASSWORD 'something long';
CREATE DATABASE jellygram OWNER jellygram;
```

Then `DATABASE_URL=postgresql://jellygram:...@host:5432/jellygram`.

The role needs ordinary DML plus `CREATE` on its own database (the migration
runner creates tables and indexes). It does **not** need superuser.

Give it `CREATEDB` as well if you intend to run the test suite, which creates a
scratch database beside this one. Without it you can create `jellygram_test` by
hand once — the suite tells you the exact command if it hits that.

## Migrations

Forward-only `.sql` files in `migrations/`, applied in filename order, each
inside a transaction, under a PostgreSQL advisory lock so that services starting
simultaneously cannot race.

```bash
npm run migrate
```

Every service also runs the migration runner at startup, so deploying is "build
and restart". Applied migrations are recorded in `schema_migrations`; re-running
is a no-op.

To add one, create `migrations/012_something.sql`. There is no down-migration
mechanism, deliberately: a rollback that has to be written before the forward
change is understood is a rollback nobody has tested. Roll forward.

## Schema

| Table | Purpose |
| --- | --- |
| `admins` | Dashboard administrators. scrypt hashes |
| `admin_sessions` | Server-side sessions; only the SHA-256 of the token is stored |
| `users` | The Telegram ↔ Jellyfin identity mapping |
| `user_libraries` | The Jellyfin libraries this application manages, per user |
| `uploads` | One row per file sent, with its full status history |
| `media` | Successfully filed media, with metadata and the Jellyfin item id |
| `upload_sessions` | One multi-part upload being collected and reassembled |
| `upload_parts` | The individual pieces of a session |
| `upload_tokens` | Bearer tokens for the direct uploader. Only the SHA-256 is stored |
| `mtproto_jobs` | Forwarded media being fetched through a Telegram user account |
| `jobs` | The durable job queue |
| `settings` | Runtime overrides for non-secret settings |
| `audit_logs` | Administrative and system actions |

The schema holds no seed data. A fresh `npm run migrate` gives you empty tables
and nothing else — there are no `INSERT` statements anywhere in `migrations/`.

## Constraints worth knowing

- `users.telegram_chat_id` is **unique**. One Telegram account, one user.
- `users.jellyfin_username` is unique case-insensitively.
- `media` has **partial unique indexes** enforcing one movie per
  `(user, title, year)` and one episode per `(user, show, season, episode)`.
  Duplicate detection is enforced by the database, not only by application
  logic, so two workers racing cannot produce two copies.
- `uploads.status` is constrained to its valid states. An unknown status is a
  constraint violation, not a row nothing knows how to render.
- Foreign keys cascade from `users`, so deleting a user removes their `uploads`
  and `media` rows — and **never** their files. Deleting records and deleting
  media are separate decisions.
- `jobs` rows name their parent with a real key (`upload_id`, `session_id` or
  `mtproto_job_id`, each `ON DELETE CASCADE`), so a job cannot outlive the thing
  it was going to work on. Before migration 011 the session and MTProto jobs
  named their parent only inside a JSON payload, survived every cascade, and sat
  in the queue as phantoms.

## Direct access

```bash
psql "$DATABASE_URL"

# or, with the bundled container
docker exec -it jellygram-postgres psql -U jellygram -d jellygram
```

## Backup

`npm run db:backup` writes a gzipped plain-SQL `pg_dump` into `BACKUP_DIR`
(default `<project>/backups`, mode 0600), then prunes anything older than
`BACKUP_RETENTION_DAYS`. `deploy/` ships a systemd timer that runs it nightly,
and the dashboard's Health page warns when the newest dump is older than
`BACKUP_STALE_HOURS`.

The password is passed to `pg_dump` through `PGPASSWORD` in its environment, not
on a command line where `ps` would show it.

Back up `.env` too, separately and securely. It holds every secret, and a
database dump without it restores to an application that cannot talk to
anything.

## Restore

The dumps are plain SQL, so `psql`, not `pg_restore`:

```bash
systemctl --user stop jellygram-api jellygram-bot jellygram-worker
zcat backups/jellygram-<stamp>.sql.gz | psql "$DATABASE_URL"
systemctl --user start jellygram-api jellygram-bot jellygram-worker
```

**Rehearse into a scratch database first.** A restore you have never performed
is a backup you have never verified:

```bash
createdb jellygram_restore_test
zcat backups/jellygram-<stamp>.sql.gz | psql -d jellygram_restore_test
psql -d jellygram_restore_test -c 'SELECT count(*) FROM users;'
dropdb jellygram_restore_test
```

A restore replaces database rows only. Files on disk are untouched, so a
restore to an older dump leaves media on disk that the database no longer knows
about — visible in Jellyfin, absent from the dashboard. `npm run jellyfin:audit`
will show the discrepancy.

## Query performance

`tests/query-bench.mjs` times the real repository functions against a database
seeded to a scale that makes missing indexes visible. It **refuses to run**
unless `DATABASE_URL` names a database whose name ends in `_perf` — some of
those queries are deliberately expensive and none of them belong near real data.

```bash
createdb jellygram_perf
DATABASE_URL=postgresql://…/jellygram_perf npm run migrate
DATABASE_URL=postgresql://…/jellygram_perf node tests/query-bench.mjs
```
