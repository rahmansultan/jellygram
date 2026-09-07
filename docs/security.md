# Security

What this application defends against, how, and — just as usefully — what it
does not.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Threat model

The design assumes a small, self-hosted deployment where the operator trusts the
machine but not necessarily the network, and where the users are known people
who should nevertheless not see each other's libraries.

**In scope**

- One registered user reading, cancelling or retrying another's media or
  uploads.
- An unregistered Telegram account getting anything at all.
- An attacker on the network guessing dashboard passwords, replaying a Mini App
  credential, or forging a request from a page the operator is visiting.
- A hostile filename — from Telegram, from TMDB, from an uploader — escaping the
  media root or reaching a shell.
- Secrets leaking into logs, error messages, API responses, or a terminal
  scrollback.

**Out of scope**

- An attacker with a shell on the server. They have `.env`.
- A malicious *registered* user filling the disk within their quota, or
  uploading content they should not.
- Jellyfin's own security. This application sets library access policy; it does
  not manage Jellyfin passwords, its network exposure, or its update cadence.
- Telegram itself. Anyone who controls your bot token controls the bot.

## Authentication

**Dashboard passwords** are hashed with **scrypt** — 64-byte key, 16-byte random
salt, stored as `scrypt$salt$hash`. Verification is constant-time via
`timingSafeEqual`, and a *missing* account still runs a verification, so timing
does not reveal whether a username exists.

**Sessions** are 256 bits of `randomBytes` in a cookie that is `HttpOnly`,
`SameSite=Strict`, and `Secure` when TLS is in play. Only the **SHA-256 of the
token** is stored, so read access to the database yields no live sessions.
Changing a password invalidates every session for that administrator.

**Login throttling** is per address *and* per username: 8 failures in 15 minutes
for one account, 30 failures for one address whatever the username — so varying
the name buys no extra guesses. The tracking map is bounded and swept, so the
throttle itself cannot be turned into a memory leak.

**Mini App credentials** are verified, never trusted. See
[miniapp.md](miniapp.md) for the HMAC construction. The comparison is
constant-time, the credential is bound to the bot that signed it, and it expires
after `MINIAPP_MAX_AGE_SEC`.

**Upload tokens** for the direct uploader are stored as SHA-256 only. A token is
printed once, to one terminal, and cannot be recovered — reissue instead.

## Authorisation

Every Mini App and upload route derives the user from the credential and
constrains the query server-side. **There is no `userId` parameter anywhere**,
and one supplied in a query string is ignored rather than honoured.

A route that takes an id in its path loads the row and checks ownership, then
reports somebody else's row as **404 rather than 403** — so the endpoint cannot
be walked to learn which ids exist.

The per-user Jellyfin isolation this enforces is described in
[jellyfin.md](jellyfin.md#5-the-isolation-model). The dashboard re-derives it
from Jellyfin's own API rather than trusting the local database, so a change
made in the Jellyfin UI is reported instead of silently assumed away.

## CSRF

Every state-changing admin request must carry the session's CSRF token in an
`x-csrf-token` header. The token is returned in the login response and held only
in the page's memory — never in a readable cookie, never in `localStorage`. A
cross-origin form post or image tag cannot set a custom header, and
`SameSite=Strict` stops the cookie being sent cross-site at all.

The Mini App has no CSRF token, deliberately: its credential is a header, not a
cookie, so the attack CSRF defends against does not apply. See
[miniapp.md](miniapp.md#no-csrf-token-deliberately).

## Path traversal

Every media path passes through `safeJoin()` in `src/lib/paths.ts`, which
sanitises each segment **and** re-verifies that the resolved result is inside the
configured root — so a bug in the sanitiser alone cannot produce an escape.

Sanitised segments cannot contain separators, cannot be `.` or `..`, cannot start
with `.` or `-`, and are byte-length bounded. `assertInside` is called again
immediately before any operation that writes or deletes.

A traversal attempt raises `PathEscapeError`, which is classified **critical and
alertable** rather than returned as a 400: it is a bug or an attack, and either
deserves attention.

Covered by tests for traversal, mixed separators, absolute paths, control
characters, reserved device names, and hostile TMDB titles.

## Command injection

Nothing is ever passed to a shell. The one external program invoked is
`ffprobe`, via `execFile` with an argument array and a `--` terminator, so a
filename containing `;`, backticks or `$()` is inert.

`pg_dump` receives its password through `PGPASSWORD` in its environment, not on
a command line where `ps` would show it.

## Secret handling

- Every interactive prompt for a secret reads the terminal in raw mode and
  echoes `*` per character, so a bot token, Jellyfin password, TMDB key or API
  hash never appears on screen, in scrollback, or over a shared session.
  `tests/setup-prompts.e2e.mjs` verifies the suppression over a real pty.
- Secrets live only in `.env` (mode 0600) and are read only by
  `src/config/index.ts`.
- The logger redacts known secret values by literal match, redacts any key whose
  *name* looks secret-bearing, and rewrites bot tokens embedded in URLs and
  passwords embedded in PostgreSQL URLs. This applies to error messages and
  stack traces too, which is where they actually leak.
- The API never returns a secret to the browser — only a configured / not
  configured flag and a status message.
- `PUT /api/settings` refuses any key matching `token|key|secret|password`.
- The MTProto session file is written mode 0600 and is in `.gitignore`. Anyone
  holding it can act as that Telegram account.
- `botapi-data/` is in `.gitignore` because its per-bot subdirectory is **named
  after the bot token**, so committing the directory would commit the token.

## Input validation

Every request body and query string is validated with Zod before use. All SQL is
parameterised; no query interpolates a caller-supplied value. Repository update
methods build `SET` clauses from a fixed allow-list of column names, not from
object keys.

## Content Security Policy

`helmet` sets `default-src 'self'`, `script-src 'self'`, `object-src 'none'`,
`frame-ancestors 'none'`. The dashboard loads **no external resources** — no CDN,
no web fonts, no analytics — which is what makes a policy that strict possible.
The frontend inserts all dynamic content as text nodes, never as HTML, so a
filename containing markup cannot become script.

Three headers are sent **only when `ADMIN_COOKIE_SECURE=true`**, because on a
plain-HTTP deployment they range from useless to actively breaking:

| Header | Why it is conditional |
| --- | --- |
| CSP `upgrade-insecure-requests` | Makes the browser rewrite every `http://` subresource to `https://`. On a port that speaks no TLS, every stylesheet and script becomes `ERR_SSL_PROTOCOL_ERROR` and the page renders blank |
| `Strict-Transport-Security` | Pins the browser to an HTTPS endpoint that does not exist, and is sticky once cached |
| `Cross-Origin-Opener-Policy` | Ignored by browsers on a non-secure origin; emits only a console warning |

`upgrade-insecure-requests` is part of helmet's **default** directive set, and
helmet merges its defaults with whatever you supply — so leaving it out is not
enough. It is removed explicitly with `upgradeInsecureRequests: null` and
restored when TLS is in front.

`npm run test:http` asserts all of this against a running server.

## Database privileges

The application's role needs ordinary DML plus `CREATE` on its own database. It
does **not** need superuser.

Worth doing, and easy: run the services as a **plain login role that owns only
this application's schema**, separate from the bootstrap superuser your
PostgreSQL installation or container created. Connecting as the superuser means
any SQL-level bug, or a compromised service process, has `COPY … TO PROGRAM`,
`pg_read_file` and every other database on the server available to it.

```sql
-- as the superuser, once
CREATE ROLE jellygram_app WITH LOGIN PASSWORD 'something long';
GRANT ALL ON DATABASE jellygram TO jellygram_app;
ALTER DATABASE jellygram OWNER TO jellygram_app;
```

Then point `DATABASE_URL` at `jellygram_app` and keep the superuser's password
out of `.env` entirely — use it only for maintenance, and for creating the scratch
databases the tests and a restore rehearsal need.

## Network exposure

- The bundled PostgreSQL and the local Bot API server bind **loopback only**.
  The Bot API server in particular must never be reachable: every request to it
  carries the bot token in the URL path.
- The dashboard binds `127.0.0.1` in `.env.example`. Bind wider only
  deliberately, and read [networking.md](networking.md) first.
- The bot needs no inbound connectivity at all; it long-polls.
- The Mini App is the one component that requires a public HTTPS URL, and it is
  optional.

**A caveat about sharing a hostname.** Cookies are scoped to the host, not the
port. If you serve the dashboard and other applications on different ports of
the same hostname, a browser holding a dashboard session sends that cookie to
all of them. Use a distinct hostname if any of those applications is not one you
control.

## Filesystem

Media directories are `0750` with the setgid bit and files are `0640`, so the
Jellyfin service account can read and no other local account can do either.

`.env` is written `0600`. Database dumps are written with `UMask=0077`, because a
dump is a complete copy of the database.

The reaper — the one component that deletes files — never recurses, never
follows a symlink, re-checks every path with `assertInside` before unlinking,
and refuses to run at all if its directory contains the media roots, the parts
tree or the quarantine directory. `QUARANTINE_DIR` is never deleted from under
any configuration.

## Known limits

Stated plainly, because a security page that lists only strengths is not useful:

- **No two-factor authentication** on the dashboard. A strong password and
  limited network exposure are the whole story.
- **No audit of Jellyfin account passwords.** This application never sets them.
- **The country geofence is not a boundary.** Addresses are spoofable, and your
  own users travel. It is noise reduction on a public port.
- **A registered user is trusted with their quota.** Nothing inspects content.
- **MTProto ingestion authenticates as a human account**, with the account-safety
  consequences described in [large-files.md](large-files.md#4-mtproto-ingestion).
- **`.env` is a single point of compromise.** Everything is in it, in plaintext,
  by design — the alternative is a secret manager this deployment size does not
  warrant.
