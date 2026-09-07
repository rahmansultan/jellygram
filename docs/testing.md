# Testing

The suite needs **PostgreSQL and nothing else**. No bot token, no Jellyfin
server, no TMDB key, no network. If you can run `npm run migrate`, you can run
the tests.

```bash
npm run build:tests && npm test    # 431 unit and integration tests
npm run test:frontend              # 73 dashboard and Mini App UI tests
npm run test:all                   # everything, including the e2e suites
```

## How it isolates itself

Three helpers, each imported for its side effect **before** the configuration
module. ESM evaluates imported modules in statement order, and `dotenv` never
overwrites a variable that already exists — so a helper that runs first wins,
and one that runs after `src/config` would do nothing at all. That is why these
imports look oddly placed at the top of a test file.

### A database of its own — `helpers/test-database.ts`

Takes the server and credentials from `DATABASE_URL`, replaces the **database
name** with `jellygram_test`, creates it on first use, and runs the migrations.
So the tests need no second server and no second set of credentials, and they
never touch the database you actually use.

It **refuses to start** if the scratch name ever equals the database
`DATABASE_URL` names. Override the name with `JELLYGRAM_TEST_DATABASE_NAME` if
`jellygram_test` is taken.

The role needs `CREATEDB`. Without it the helper prints the exact command to
create the database by hand, once.

> This did not always work by convention. The suites once shared the live
> database and kept out of its way with synthetic id ranges and fixtures parked
> a century ahead. The convention broke where it mattered most — a test that
> claimed "the next job" claimed a real queued upload and marked it completed
> without doing the work. Conventions are not isolation.

### A media tree of its own — `helpers/test-media-root.ts`

Points `MEDIA_ROOT` at `.test-media/` in the project and derives the other four
roots from it, so one variable isolates movies, tv, `.incoming`, `.parts` and
`.quarantine` together.

It also gives that root the media group and the setgid bit before anything is
created inside it. The ownership tests are about *inheritance* — a file takes
its group from the directory it lands in — and they used to get that property
for free by building their tree inside the real media root, which is precisely
why they were writing into somebody's film library. Reproducing the two
properties that make the real root work is what let those tests move out.

It sets `QUEUE_PAUSED=true`, so a suite driving the pipeline handlers directly
never races a live worker for the same job.

The path is fixed rather than random, so a crashed run leaves one findable tree
instead of scattering temporary ones, and concurrent test files share it.

### Credentials of its own — `helpers/test-credentials.ts`

Forces a syntactically valid but worthless bot token and Jellyfin key, and
points `TELEGRAM_API_ROOT` and `JELLYFIN_URL` at `127.0.0.1:9` — the discard
port, where nothing listens.

Forced, not defaulted. Deferring to `.env` would mean a developer with a working
deployment runs the suite against their **real** bot token and their **real**
Jellyfin key, and the first test that forgets to stub `fetch` reaches their live
server. Now such a test fails on a refused connection instead, loudly and
immediately.

TMDB is forced **off**: it is the one integration with no local stand-in, and an
enabled key would make identification tests depend on a third party's uptime,
rate limits and catalogue while spending your quota to do it.

### Other helpers

| Helper | Effect |
| --- | --- |
| `small-disk-reserve.ts` | Scales the free-space reserve to what a test fixture actually moves |
| `fast-getfile.ts` | Shrinks the `getFile` wait budget so polling tests take seconds |
| `fast-progress.ts` | Shrinks the progress rate-limit window |
| `local-botapi-mode.ts` | Turns on local Bot API mode, so the tests covering it never skip |
| `queue-live.ts` | Un-pauses the queue for suites that enqueue real work |
| `test-worker.ts` | Starts a worker of the suite's own, against the suite's database and tree |
| `answer-feeder.mjs` | Feeds scripted answers into a pty, for the interactive-prompt tests |

`test-worker.ts` runs the compiled tree under `dist-tests/src`, not `dist/`, so
the worker runs exactly the code the suite was built against.

## Running on a small disk

The pipeline refuses any ingestion that would leave less than
`MIN_FREE_DISK_BYTES` free plus `DISK_SAFETY_MARGIN_BYTES` of headroom — 12 GiB
together by default. That is the right policy for a media server and the wrong
precondition for a suite that moves fixtures measured in megabytes, so the
end-to-end suites set a reserve proportionate to what they actually transfer.
The policy itself is still covered, by `tests/validation.test.ts`.

One group cannot be rescued that way. `test:uploader` asks `/begin` about
*declared* sizes at the real 2 GiB and 5 GiB boundaries — no bytes move, but the
server still checks that the declared size would fit, correctly, because
accepting a 4 GB upload onto a 1 GB volume would only fail later after the user
had waited. On a volume too small to answer, those cases are **skipped with the
reason printed** and the summary says how many:

```
  SKIP  4 GB → multipart
        only 0.9 GiB free; /begin cannot be asked about 4.00 GiB
ALL CHECKS PASSED (8 skipped)
```

They are not weakened and not counted as passes — a run that quietly reports
"all passed" while having declined a third of its checks looks like evidence and
is not. Run that suite on a volume with ~6 GiB free to exercise the boundaries
properly.

## The suites

| Command | What it needs | What it covers |
| --- | --- | --- |
| `npm test` | PostgreSQL | 431 unit and integration tests |
| `npm run test:frontend` | nothing | The dashboard and Mini App bundles in jsdom |
| `npm run test:http` | PostgreSQL | Real HTTP: CSP, headers, static assets, auth gates |
| `npm run test:e2e` | PostgreSQL, ffmpeg optional | The whole pipeline against a real generated video |
| `npm run test:multipart` | PostgreSQL | Split, stream, resume, assemble, verify |
| `npm run test:mtproto` | PostgreSQL | The MTProto route with a fake client |
| `npm run test:recovery` | PostgreSQL, ffmpeg, media group | Failure diagnostics and retry against a live worker |
| `npm run test:uploader` | PostgreSQL, ffmpeg | The real uploader against two servers of the suite's own |
| `npm run test:setup` | PostgreSQL, `script(1)` | The interactive setup prompts, in a real pty |
| `npm run test:dashboard` | a running API | Every dashboard page, as a signed-in administrator |
| `npm run test:responsive` | a running API, Chrome | Seven viewports in headless Chrome |

`test:e2e` builds a tiny real video with ffmpeg so `ffprobe` sees genuine
content; without ffmpeg it writes a placeholder and the container check is
skipped rather than failed. `test:multipart` and `test:mtproto` degrade the
same way.

`test:uploader` and `test:recovery` **require** ffmpeg and say so if it is
missing. They drive the real ingest endpoint, and the pipeline behind it
refuses a file `ffprobe` cannot read — so a fixture of random bytes would fail
exactly where a real film would pass, and skipping the check would mean
reporting a pass for the one thing those suites exist to prove. On Debian or
Ubuntu, `sudo apt-get install ffmpeg`; CI installs it for the same reason.

Each of them looks for `/usr/lib/jellyfin-ffmpeg/ffmpeg` first, then
`/usr/bin/ffmpeg`, then `ffmpeg` on PATH — the order the application itself
uses for `ffprobe`.

`test:recovery` asserts on-disk group ownership, so it skips those assertions
when `MEDIA_GROUP` does not resolve on the machine — reporting a skip it can
explain rather than a failure nobody can act on.

`test:http` starts an API of its own on a free port, tests it, and stops it
again, so it needs nothing already listening. Give it an address to test a
server you are already running instead:

```bash
npm run test:http                                    # starts one, stops it again
node tests/http-assets.e2e.mjs http://127.0.0.1:8300 # test a running dashboard
```

`test:setup` makes a scratch `.env` from `.env.example` when there is none, and
removes it again afterwards. Where an `.env` already exists it is backed up,
restored byte-for-byte, and the restore is itself asserted.

### The two browser suites

They drive a **running** API, so they take credentials on the command line:

```bash
npm run start:api &
npm run admin:create                     # note the generated password
npm run test:dashboard  -- <user> <password>
npm run test:responsive -- <user> <password>
```

`DASHBOARD_URL` points them elsewhere (default `http://127.0.0.1:8300`);
`CHROME_BIN` overrides the Chrome path (default `/usr/bin/google-chrome`).

`test:responsive` renders at 320, 375, 390, 430, 768, 1024 and 1366 px and fails
if anything is wider than the screen, if a table hides its own actions behind a
horizontal scroll, or if the drawer or a dialog stops working on a phone.

Its CDP calls time out after 20 seconds. On a loaded machine Chrome's first cold
start can exceed that; if it fails with `Page.enable timed out`, run it again on
a quieter machine before believing it.

## Writing a test

Test files run **in parallel against one database**, so each file owns a
disjoint band of `telegram_chat_id` values and must only delete inside its own
band. Pick an unused band, declare it as constants at the top, and verify it is
empty before use — several existing files show the pattern.

Import the helpers you need first, before anything that reads configuration, and
say why in a comment. The unusual import order is load-bearing, and a future
reader reformatting the imports alphabetically would break it silently.

Prefer driving the real code over asserting on mocks. Most of these suites start
a real Express server, a real worker, or the real uploader binary, against a
real database — the fakes are at the network edge (Telegram, Jellyfin, TMDB) and
nowhere else.
