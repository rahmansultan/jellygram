# Contributing

Thanks for looking. Issues and pull requests are both welcome.

## Getting set up

You need Node 22+ and a PostgreSQL you can create databases on. Nothing else —
no Telegram bot, no Jellyfin server, no TMDB key.

```bash
git clone https://github.com/NahomHabtamuNSC/jellygram.git
cd jellygram
npm ci

npm run init            # writes .env, generates a session secret
$EDITOR .env            # set DATABASE_URL; MEDIA_ROOT already points somewhere sane
npm run db:up           # or point DATABASE_URL at your own PostgreSQL

npm run build
npm run migrate
npm run build:tests && npm test
```

If that last line passes, you have a working development environment. The suite
creates its own scratch database and its own media tree, and supplies its own
fake credentials — see [docs/testing.md](docs/testing.md).

## Before you open a pull request

```bash
npm run check          # typecheck
npm test               # unit and integration
npm run test:frontend  # the browser bundles in jsdom
```

`npm run test:all` runs everything, including the end-to-end suites. It takes a
few minutes and is worth it for anything touching the pipeline, the uploader, or
the API.

## Conventions this codebase actually follows

Read a neighbouring file before writing a new one. The style is consistent and
mostly not enforced by a tool, so matching it is a human act.

**Configuration is read in exactly one place.** `src/config/index.ts` is the only
module that touches `process.env`. If you need a new setting, add it to the Zod
schema with a default and a comment explaining what happens at the extremes,
expose it on the `config` object, and document it in `.env.example` where it is
defined. A `process.env` read anywhere else will be asked about in review.

**Comments explain *why*, not *what*.** The code says what it does. A comment
earns its place by recording a constraint, a trade-off, or a mistake somebody
already made — the sort of thing that would otherwise be "simplified" away by
the next person. Several comments in this codebase exist because removing the
line they describe reintroduced a real bug.

**Paths go through `src/lib/paths.ts`.** `storageSlug`, `safeJoin`,
`assertInside`. Never build a media path by string concatenation, and call
`assertInside` again immediately before anything that writes or deletes.

**Errors are classified.** `src/lib/errors.ts` decides retryable versus
terminal, and expected versus alertable. A new failure mode should get a class
and a classification, not a bare `throw new Error`.

**Nothing reaches a shell.** `execFile` with an argument array, always.

**SQL is parameterised**, and `SET` clauses are built from a fixed allow-list of
column names — never from object keys.

**Secrets never reach a log, a response, or a command line.** The logger redacts
by value and by key name; keep it that way, and check what your error messages
interpolate.

**Migrations are forward-only.** Add `migrations/0NN_thing.sql`; do not edit one
that has shipped. There is no down-migration mechanism, deliberately.

**The frontend has no build step.** `public/` is what the browser gets. No
bundler, no framework, no CDN — the strict Content-Security-Policy depends on
there being no external origins at all. Insert dynamic content as text nodes,
never as HTML.

## Tests

New behaviour needs a test. Bug fixes need a test that fails without the fix —
several existing test files carry a comment naming the bug they lock down, and
that is a good pattern to copy.

Test files run **in parallel against one database**, so each owns a disjoint band
of `telegram_chat_id` values and deletes only inside its own band. Pick an unused
band and declare it at the top of the file.

The environment helpers are imported for their side effects and **must come
first**, before anything that reads configuration. ESM evaluates imports in
statement order and the helpers work by setting variables before the config
module reads them — so an import sorter that reorders them breaks the suite
silently. If you add such an import, say why in a comment, as the existing files
do.

Prefer driving real code to asserting on mocks. The fakes in this suite are at
the network edge — Telegram, Jellyfin, TMDB — and nowhere else.

## Commits and pull requests

- One logical change per pull request. A refactor and a behaviour change in the
  same diff are hard to review and harder to revert.
- Write a commit message that says why. "Fix bug" tells a future reader nothing;
  the interesting part is the constraint you discovered.
- Say in the PR description what you ran. "npm run test:all passes" is useful;
  so is "I could not run test:responsive, no Chrome on this machine".
- If you changed a default, say what happens to somebody who upgrades without
  reading the changelog.

## Reporting bugs

Include:

- What you did, what happened, what you expected.
- Node version (`node -v`), PostgreSQL version, Jellyfin version.
- Which ingest route (bot, uploader, multi-part, MTProto).
- The relevant log lines, and the output of
  `npm run upload:diagnose -- --upload-id <id>` if an upload is involved.

**Redact before you paste.** Logs are redacted for known secret values, but the
paths, Telegram IDs and library names in them are yours.

Please report security vulnerabilities privately instead — see
[SECURITY.md](SECURITY.md).

## Things likely to be declined

Not because they are bad ideas, but because they conflict with what this project
is:

- **A frontend framework or a bundler.** The no-build-step frontend is what
  makes the CSP as strict as it is, and what makes the whole thing readable
  without a toolchain.
- **A second datastore** (Redis, a message broker). The queue is PostgreSQL
  because the rows it coordinates are already there, and consistency at restart
  matters more here than throughput. See
  [docs/architecture.md](docs/architecture.md#the-job-queue).
- **Automatic Jellyfin account creation.** Deliberate: it would mean holding
  credentials that can create administrators.
- **Deleting media to free space.** A full disk is an operator's decision.
- **Making settings writable from the dashboard.** Configuration lives in `.env`
  so that what the dashboard reports is what the processes actually loaded.

If you think one of these is wrong, open an issue and make the argument — they
are decisions, not commandments. Just make it before you write the code.
