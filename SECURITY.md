# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's [private vulnerability
reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):
the **Security** tab → *Report a vulnerability*. That opens a private advisory
only the maintainers can see.

If that is unavailable, contact the maintainer through the address on their
GitHub profile and say only that you have a security report — do not include
details until there is a private channel.

Useful things to include:

- What an attacker can do, and what they need in order to do it (network access?
  a registered account? a valid Mini App credential?).
- The affected component: bot, worker, admin API, Mini App API, upload ingest,
  uploader, deployment scripts.
- Steps to reproduce, ideally against a fresh checkout.
- The version or commit you tested.

You will get an acknowledgement within a few days. Because this is a small
volunteer-maintained project, please do not expect a same-day response, and
please give a reasonable window before disclosing publicly.

## Supported versions

The `main` branch is the supported version. Fixes land there; there is no
long-term support branch.

## What is in scope

Roughly, anything that breaks one of these:

- **Isolation between users.** One registered user reading, cancelling,
  retrying, or otherwise reaching another's media, uploads, posters or Jellyfin
  libraries. This is the property the project exists for.
- **Authentication and authorisation.** Bypassing the dashboard login, forging or
  replaying a Mini App credential, using an upload token beyond its user,
  privilege escalation between an ordinary user and an administrator.
- **Getting in without an account.** Anything an unregistered Telegram account
  or an unauthenticated HTTP caller can obtain or cause.
- **Escaping the media root.** Path traversal through a filename from Telegram,
  from TMDB, or from the uploader.
- **Command or SQL injection.**
- **Secret disclosure.** A token, key, password or session appearing in a log, an
  API response, an error message, a terminal, or a process listing.
- **Deletion of data that should not be deleted** — the reaper removing a live
  file, or a cascade removing media.

## What is out of scope

Documented behaviour and accepted trade-offs, listed in
[docs/security.md](docs/security.md#known-limits). In particular:

- **An attacker who already has a shell on the server.** They have `.env`.
- **A malicious registered user** filling their own quota, or uploading content
  they should not. Nothing inspects content.
- **Jellyfin's own security**, including its passwords, its network exposure and
  its update cadence. This application sets library access policy and nothing
  else.
- **Telegram's own security.** Anyone with the bot token controls the bot.
- **The country geofence being bypassable.** It is noise reduction on a public
  port, not a boundary — addresses are spoofable and it is documented as such.
- **Missing hardening you would like to see** (2FA, a secret manager, rate limits
  on a route that has none). Those are feature requests; open a normal issue.
- **Anything requiring a user to be socially engineered into pasting a secret.**

Reports from automated scanners, without a working exploit or a clear
explanation of impact, are unlikely to get a detailed reply.

## Operator responsibilities

Some of the security of a deployment is not in this code:

- **Protect `.env`.** It is mode 0600 and holds every secret. Back it up
  securely and separately from the database.
- **Protect `.mtproto-session` if you enable MTProto.** Anyone holding it can act
  as that Telegram account until it is revoked in Telegram → Settings → Devices.
- **Never expose the local Bot API server.** Every request to it carries the bot
  token in the URL path. The shipped compose file binds loopback.
- **Make media users *normal* Jellyfin users.** Administrators see every library
  by design, and no setting here overrides that.
- **Set `ADMIN_COOKIE_SECURE` and `TRUST_PROXY` together, after TLS works.** See
  [docs/networking.md](docs/networking.md).
- **Consider a non-superuser database role.** See
  [docs/security.md](docs/security.md#database-privileges).
- **Keep Node, PostgreSQL and Jellyfin updated.** `npm audit` covers this
  project's own dependency tree, which is deliberately small.

## Dependencies

The runtime dependency set is small and intentionally so: `express`, `grammy`,
`pg`, `pino`, `zod`, `helmet`, `cookie-parser`, `dotenv`, and `teleproto` (only
reached when MTProto is enabled). The frontend has no dependencies at all — no
bundler, no framework, no CDN.

Vulnerabilities in those belong upstream, but please open an issue if one
affects this project and an upgrade is being held back.
