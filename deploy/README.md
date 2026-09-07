# Deployment

Everything here is an example you adapt, not a configuration you inherit. The
unit files are templates — they carry `@APP_DIR@`, `@NODE@` and `@TZ@` rather
than paths from somebody else's machine — and `install-systemd.sh` fills them in
from the host it runs on.

| File | What it is |
| --- | --- |
| `systemd/jellygram-api.service.in` | The dashboard, admin API and upload ingest endpoint |
| `systemd/jellygram-bot.service.in` | The Telegram bot (long polling) |
| `systemd/jellygram-worker.service.in` | The job runner: downloads, identification, filing, Jellyfin scans |
| `systemd/jellygram-backup.service.in` + `.timer.in` | Nightly `pg_dump`, gzipped, pruned |
| `systemd/jellygram-geofence.service.in` + `.timer.in` | **Optional.** Weekly refresh of a country allow-list on Jellyfin |
| `install-systemd.sh` | Renders the templates into `~/.config/systemd/user/` |
| `jellyfin-geofence.mjs` | The geofence script itself; runs fine by hand |

## The three processes

They are separate processes on purpose, and they share nothing but the
database.

- **api** — HTTP. Restarting it interrupts an in-flight upload and nothing else.
- **bot** — long-polls Telegram. Exits 0 and says so when `TELEGRAM_BOT_TOKEN`
  is unset, so a deployment without a bot is a supported state rather than a
  crash loop.
- **worker** — claims jobs. It is the only process that writes into the media
  tree, and the only one whose restart mid-job matters. It is built for that:
  a job interrupted by a restart is retried from its last durable stage.

You can run all three on one machine, or the worker somewhere with the disks
and the other two elsewhere, as long as every process can reach the database
and the worker can reach `MEDIA_ROOT`.

## Prerequisites

- Node.js 22 or newer
- PostgreSQL 14 or newer, reachable from every process
- Jellyfin, reachable from the api and worker processes
- A user account that owns the checkout and can write to `MEDIA_ROOT`

## systemd (user units)

```bash
git clone <your fork> ~/jellygram
cd ~/jellygram

npm ci
npm run init            # writes .env, generates ADMIN_SESSION_SECRET
$EDITOR .env            # DATABASE_URL, MEDIA_ROOT, JELLYFIN_URL...
npm run build
npm run migrate
npm run setup           # bot token, Jellyfin API key, TMDB key
npm run admin:create    # your dashboard login

./deploy/install-systemd.sh
```

The script prints the commands to enable the services rather than running them,
because starting three services against a half-configured `.env` is a worse
first experience than one more copy-paste. Preview the rendered units first with
`--dry-run`, add the optional country fence with `--geofence`, and undo the
whole thing with `--uninstall` (which touches no data).

**Lingering.** User services stop at logout and do not start at boot unless the
account lingers:

```bash
sudo loginctl enable-linger "$USER"
loginctl show-user "$USER" | grep Linger    # expect Linger=yes
```

That one `sudo` is the only privileged step. Everything else runs as you.

### Why user units rather than system units

Less privilege, no root anywhere in the normal path, and the services run as the
account that already owns the media. The cost is real and worth knowing:

- A user unit cannot order itself after a system unit or after
  `network-online.target`. Each service therefore waits for the database itself
  (`ExecStartPre=… wait-for-db.js --timeout-sec 60`) instead of declaring a
  dependency it is not allowed to declare.
- The stronger sandboxing directives (`ProtectKernelTunables`,
  `ProtectSystem=strict`, …) are unavailable. If you want them, convert these to
  system units under `/etc/systemd/system/`, add `User=` and `Group=`, and drop
  the `--user` from every command.

`PrivateTmp=true` is set, which puts the process in a mount namespace where the
media group's gid may be unmapped — so `chown` to it fails with `EINVAL`. That
is expected and handled: group ownership of filed media is carried by the setgid
bit on the media directories, which works regardless of the namespace. Do not
"fix" it by removing `PrivateTmp`.

## Operating them

```bash
systemctl --user status  jellygram-api jellygram-bot jellygram-worker
systemctl --user restart jellygram-api jellygram-bot jellygram-worker    # after editing .env
journalctl --user -u jellygram-worker -f
systemctl --user list-timers jellygram-backup.timer
```

`Restart=on-failure` with `RestartPreventExitStatus=78` is deliberate: exit 78
is `EX_CONFIG`, and a bad `.env` is not cured by restarting every five seconds
and logging the same line forever. Read the journal — the process prints exactly
which variables were wrong before it exits.

## Docker

There is no application image, and that is a choice rather than an omission: the
worker needs a media tree with real group ownership and real setgid semantics,
and getting that right through a container is more work than running Node
directly. Two compose files ship for the *dependencies*, which do containerise
cleanly:

- `docker-compose.yml` — PostgreSQL, on loopback port 55432.
- `docker-compose.botapi.yml` — Telegram's local Bot API server, for files
  between 20 MB and 2000 MB. See [docs/large-files.md](../docs/large-files.md).

## Reverse proxy

The API binds `127.0.0.1:8300` by default. Put TLS in front of it if you want
the dashboard or the Mini App reachable from anywhere but loopback — the Mini
App *requires* HTTPS, because Telegram refuses to open anything else.

```nginx
server {
    listen 443 ssl;
    server_name media.example.com;

    ssl_certificate     /etc/letsencrypt/live/media.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/media.example.com/privkey.pem;

    # Uploads are gigabytes and take hours. The defaults are far too small.
    client_max_body_size 0;
    proxy_read_timeout   4h;
    proxy_send_timeout   4h;
    proxy_request_buffering off;

    location / {
        proxy_pass http://127.0.0.1:8300;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then set both of these in `.env`, together:

```env
ADMIN_COOKIE_SECURE=true
TRUST_PROXY=true
```

`TRUST_PROXY` matters as much as the cookie. Without it every request appears to
arrive from `127.0.0.1`, so the login rate limiter counts the whole internet as
one client and the audit log records the proxy instead of the caller.

Verify HTTPS works *before* setting `ADMIN_COOKIE_SECURE=true`. A Secure cookie
is never sent back over plain HTTP, so getting the order wrong looks exactly
like a wrong password. [docs/networking.md](../docs/networking.md) covers the
alternatives — Cloudflare Tunnel, Tailscale Funnel — and the trade-offs.

## The optional country fence

`jellyfin-geofence.mjs` fills Jellyfin's `RemoteIPFilter` with every address
block a regional registry has assigned to one country, plus your own private
ranges, so a scanner from elsewhere is refused before it reaches the login page.

It only makes sense if you have deliberately exposed **Jellyfin** to the
internet. It is noise reduction, not a security boundary: addresses are
spoofable and your own users travel.

```bash
node deploy/jellyfin-geofence.mjs --country DE                      # report only
node deploy/jellyfin-geofence.mjs --country DE --apply \
     --must-include 203.0.113.9                                     # write it
node deploy/jellyfin-geofence.mjs --clear --apply                   # remove it
```

`--must-include` should be an address you have actually connected from. The
script refuses to write any list that would not contain it — the failure mode of
a country fence is locking out its owner, and that is the one thing it must
never do quietly.

## Backups

`jellygram-backup.timer` runs `npm run db:backup` nightly: a gzipped plain-SQL
`pg_dump` into `BACKUP_DIR` (default `<project>/backups`), pruned after
`BACKUP_RETENTION_DAYS`. The dashboard's Health page warns when the newest dump
is older than `BACKUP_STALE_HOURS`.

Media is **not** backed up. It is ordinary files in ordinary directories — use
whatever you already use.

Restoring is plain SQL, so `psql`, not `pg_restore`:

```bash
systemctl --user stop jellygram-api jellygram-bot jellygram-worker
zcat backups/jellygram-<stamp>.sql.gz | psql "$DATABASE_URL"
systemctl --user start jellygram-api jellygram-bot jellygram-worker
```

Rehearse into a scratch database first. See
[docs/database.md](../docs/database.md).

## Upgrading

```bash
git pull
npm ci
npm run build
npm run migrate                                        # forward-only, idempotent
systemctl --user restart jellygram-api jellygram-bot jellygram-worker
```

Migrations run under an advisory lock, so restarting all three at once cannot
race. Check `.env.example` after a pull for variables that did not exist before.
