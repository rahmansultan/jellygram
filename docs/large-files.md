# Large files

Telegram's public Bot API refuses to hand a **bot** any file over 20 MB. That is
Telegram's limit, not a setting, and no configuration on this side changes it.

There are four routes past it. They are independent — enable only what you need
— and all four end in the same pipeline: identification, duplicate detection,
the Jellyfin layout, the library scan, your own private library.

| Route | Ceiling | Use it when |
| --- | --- | --- |
| Public Bot API | 20 MB | Works out of the box |
| [Local Bot API server](#1-local-bot-api-server) | 2000 MB | You send files *to* the bot |
| [Direct uploader](#2-the-direct-uploader) | 5 GiB | The media is on a machine you control |
| [Multi-part send](#3-multi-part-uploads) | 5 GiB | You want it all to go through Telegram |
| [MTProto](#4-mtproto-ingestion) | 5 GiB | You *forward* media already in Telegram |

If you only ever upload from your own computer, the direct uploader alone is
enough and is the simplest of the four.

---

## 1. Local Bot API server

Telegram publishes the Bot API server as software you can run yourself. In
`--local` mode it lifts the 20 MB ceiling to 2000 MB and makes `getFile` return
a **path on your machine** instead of a download URL — so the file is moved into
place rather than downloaded twice.

### Setup

You need `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from
[my.telegram.org](https://my.telegram.org) → *API development tools*. These are
**account** credentials, not bot credentials; they cannot be derived from the
bot token. `npm run setup` prompts for both.

```bash
# .env
TELEGRAM_API_ID=1234567
TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef
BOTAPI_UID=1000                 # id -u
BOTAPI_GID=1000                 # the MEDIA group's gid — see below
```

```bash
npm run telegram:logout   # required once, before switching servers
npm run botapi:up
```

Then point the application at it and restart:

```env
TELEGRAM_API_ROOT=http://127.0.0.1:8081
TELEGRAM_LOCAL_MODE=true
```

```bash
npm run telegram:verify
```

`telegram:logout` is not optional. A bot token is bound to whichever API server
it last spoke to; switching without logging out leaves the bot unable to receive
updates from either.

### BOTAPI_GID must be the media group

Not your own primary group. A file the Bot API server downloads is later
**renamed** into the media library, and `rename` keeps the group the file was
*created* with — the setgid bit on the destination directory does not apply to
it. Creating the file with the media group up front is what makes the filed film
readable by Jellyfin, and the worker cannot fix it afterwards: it runs under
`PrivateTmp`, in a namespace where that gid is unmapped, so `chown` fails with
`EINVAL`.

```bash
getent group jellyfin | cut -d: -f3
```

### The two path roots

`getFile` returns a path as the **container** sees it; the worker runs on the
host. These map between the two sides of one bind mount:

```env
BOTAPI_DATA_DIR=./botapi-data                      # the host side, for compose
TELEGRAM_LOCAL_FILE_ROOT=/var/lib/telegram-bot-api  # the container side
TELEGRAM_LOCAL_HOST_ROOT=./botapi-data              # the host side, for the worker
```

Set `FILE_ROOT` and `HOST_ROOT` equal when `telegram-bot-api` runs directly on
the host rather than in a container. Relative values resolve against the project
directory.

### It binds loopback only

Every request to this server carries the bot token **in its URL path**. The
shipped compose file binds `127.0.0.1:8081` for that reason. Do not expose it.

### Waiting for it

In `--local` mode `getFile` does not answer until the server has fetched the
whole file from Telegram — many minutes for a multi-gigabyte film. The request
is therefore **polled** rather than waited on, because the server keeps
downloading in the background after a client disconnects, so each retry either
resumes the wait or returns the finished path.

The budget for one file is derived from its size and
`TELEGRAM_GETFILE_MIN_BYTES_PER_SEC`, floored at
`TELEGRAM_GETFILE_TIMEOUT_SEC` and capped at `TELEGRAM_GETFILE_MAX_WAIT_SEC`.
The default rate (300 KB/s) is deliberately pessimistic. Measure your own link
before tightening it: guessing high costs a longer wait before giving up,
guessing low costs a spurious timeout on an upload that was going to succeed.

### Its downloads are kept

The server keeps every file it fetches, including the 1.8 GiB it had already
pulled for an upload that then aborted. `src/services/reaper.ts` sweeps
`botapi-data` on the same rules as the staging directory — nothing in the
database refers to it, and nothing has written to it for
`DOWNLOAD_TMP_GRACE_HOURS`.

---

## 2. The direct uploader

`uploader/jellygram-upload.mjs` is a single file with **no dependencies**. Copy
it to any machine with Node 22 and it runs. It bypasses Telegram entirely and
posts to JellyGram's own ingest endpoint.

### Setup, once

On the server, issue a token for a media user:

```bash
npm run upload:token -- --user alice
```

The token is printed once, to that terminal only, and never logged — only its
SHA-256 is stored, so it cannot be recovered. Reissue instead of recovering.

On the machine holding the media:

```bash
node jellygram-upload.mjs --login
```

It asks for the server URL and the token, which is not echoed.

### Every upload after that

```bash
node jellygram-upload.mjs "Interstellar.2014.1080p.BluRay.mkv"
node jellygram-upload.mjs                    # or pick from a numbered list
node jellygram-upload.mjs --dir ~/Videos     # from another directory
```

It reads the file's size and decides before a byte moves:

| Original size | What happens |
| --- | --- |
| ≤ `UPLOAD_SINGLE_MAX_BYTES` (2 GiB) | Sent whole, one request |
| up to `MAX_ASSEMBLED_FILE_BYTES` (5 GiB) | Split into `UPLOAD_PART_BYTES` pieces, streamed in order, reassembled by the server |
| larger | Refused, with the reason |

The boundary is inclusive: exactly 2 GiB is a single upload, one byte more is
multi-part.

### What it does for you

- Progress with transfer rate and ETA.
- **Resumes.** Interrupt it, run the same command again; parts already on the
  server are skipped rather than resent.
- **Retries** a failed part up to five times with backoff, so a brief network
  drop does not restart a 4 GB upload.
- **Writes no temporary files.** Parts are read as byte ranges straight from the
  original, which is opened read-only and never modified.
- Refuses anything whose extension is not in `ALLOWED_EXTENSIONS`.

### Server-side timeouts

A 2 GiB single-piece upload over a slow link takes longer than Node's default
300-second `requestTimeout`, which would kill it silently.
`API_REQUEST_TIMEOUT_SEC` (4 hours by default) exists for this.
`API_HEADERS_TIMEOUT_SEC` stays short, so slowloris is still bounded.

Behind a reverse proxy, raise its limits too — nginx's `client_max_body_size`
and `proxy_read_timeout` will otherwise cut the upload off long before this
application does. See [deploy/README.md](../deploy/README.md).

---

## 3. Multi-part uploads

For when everything should go through Telegram. Split the file locally and send
the pieces; the server reassembles them.

```bash
split -b 1900M "Interstellar.2014.1080p.mkv" "Interstellar.2014.1080p.mkv.part"
```

Send every resulting piece to the bot, in any order, then `/finish`.

Recognised naming, in the order the parser tries:

| Form | Example | Total known upfront? |
| --- | --- | --- |
| `.partNofM` | `Movie.mkv.part2of5` | yes |
| `.partN` | `Movie.mkv.part2` | no |
| `.partAA` | `Movie.mkv.partab` (GNU `split`) | no |
| `.NNN` | `Movie.mkv.002` (`split -d`) | no |

The name *before* the suffix must be a valid media filename — it is what the
finished file is called and what identification runs against. A bare number
without a leading zero is deliberately **not** treated as a part, so
`Movie.2014` stays a year rather than becoming part 2014.

### Completion

A session finishes when:

- every part of a declared `partNofM` set has arrived, **or**
- the sender sends `/finish`, **or**
- `MULTIPART_IDLE_MINUTES` pass with no new part *and* the parts form a
  contiguous 1..N run.

A session that goes idle **with gaps** is expired and its parts deleted, so an
abandoned upload cannot hold gigabytes indefinitely. A session that *failed*
keeps its parts for `MULTIPART_FAILED_RETENTION_HOURS` so a retry need not
re-upload them.

Sessions are per user and per base filename, so two people can upload files with
the same name at the same time without colliding. The *Multipart* page in the
dashboard shows every session from either this route or the uploader.

---

## 4. MTProto ingestion

For media that is **already in Telegram** — you forward it to the bot and it is
never downloaded to your computer at all.

Telegram will not let a *bot* download a file above 2000 MB. Your *user account*
has no such restriction on media it can already see. So for the large ones the
server asks your account for the file instead of asking the bot.

### Read this first

MTProto ingestion authenticates as **your own Telegram account**, not as your
bot. That has consequences worth weighing before you enable it:

- The session file it creates is equivalent to being logged in as you. Anyone
  who obtains it can act as your account until you revoke it.
- Automated use of a user account is governed by Telegram's terms, not the Bot
  API's. Downloads are deliberately sequential and un-parallelised, because
  aggressive fetching is what gets accounts limited.
- Throughput is roughly 1–1.5 MB/s, so a 2 GB film takes 20–30 minutes. That is
  Telegram's per-connection rate for a standard account fetching sequential
  chunks, not a bug in this application.

It is off by default and stays off unless you both enable it and authenticate.

### Setup

```bash
npm run telegram:mtproto:setup
```

It asks for your phone number, the login code Telegram sends, and your 2FA
password if you have one. All of it is typed on your server and used once; the
2FA password is never echoed and never stored.

What *is* stored is a session file at `TELEGRAM_MTPROTO_SESSION_PATH` (default
`<project>/.mtproto-session`), mode 0600, already in `.gitignore`. Treat it like
a password.

```env
TELEGRAM_MTPROTO_ENABLED=true
MTPROTO_OWNER_TELEGRAM_ID=<your Telegram id>
```

`MTPROTO_OWNER_TELEGRAM_ID` restricts this route to one Telegram id — the
account that authenticated. Leaving it blank allows any registered user to
trigger fetches through *your* account, which only makes sense if everyone
registered shares it.

Then restart and check:

```bash
npm run telegram:mtproto:status
```

Revoke at any time with `npm run telegram:mtproto:setup -- --logout`, or in
Telegram → Settings → Devices.

### Routing

The bot decides from the size the Bot API reports, before anything is fetched:

```
forwarded media
      ├── ≤ 2000 MB ──► the ordinary Bot API path, unchanged
      ├── ≤ 5 GiB   ──► an MTProto job   (only when enabled and authorised)
      └── > 5 GiB   ──► refused, with the reason
```

If MTProto is not set up, an oversized forward gets the ordinary "Telegram will
not let this bot download…" message rather than failing silently.

### Finding the forwarded message

The `file_id` a bot receives is useless above 2000 MB, so the media has to be
located through the account. Two routes, most certain first:

1. **Channel forward** — `forward_origin` carries the origin chat and message id,
   so the exact message is fetched.
2. **Anything else** — a forward from a private chat, a group, or a sender who
   hides their account carries no usable id. The forwarded copy does exist in
   your own dialog with the bot, so the last `MTPROTO_SEARCH_DEPTH` messages of
   that dialog are searched for a document whose **byte size** matches exactly,
   with the filename as a tiebreaker.

Both use the account's ordinary permissions. Nothing attempts to reach a chat
the account cannot already read. If the media cannot be found — the channel was
deleted, you left it, the message was removed — the job ends as **UNAVAILABLE**
with a plain explanation. The server never tries to work around an access
restriction.

### Download

`iterDownload` yields `MTPROTO_CHUNK_BYTES` at a time. Each chunk is hashed and
written with back-pressure respected, so a 5 GiB file costs one chunk of memory
rather than 5 GiB, and the SHA-256 is computed in the same pass. Afterwards the
file must match the expected size exactly; a short download is discarded rather
than handed on.

`MTPROTO_STALL_TIMEOUT_SEC` bounds a *stall*, not the transfer. The download
iterator takes neither a signal nor a timeout, so a connection that dies
silently would block `for await` forever and hold a worker slot until the
process was restarted. A slow but progressing download resets the timer on every
chunk.

### Handoff

The completed download becomes an ordinary `uploads` row with
`local_source_path` set and `source = 'mtproto'` — the same handoff the
multi-part and uploader routes use. Everything downstream is **unchanged code**.

The media belongs to the registered user who forwarded it, and lands in their
libraries. The *Telegram fetch* page in the dashboard shows every job: owner,
filename, size, message id, progress, speed, ETA, status, retry count and error,
with retry and cancel.

---

## Size limits, in one place

| Limit | Variable | Default | What it governs |
| --- | --- | --- | --- |
| Telegram's public API | — | 20 MB | Hard; no setting changes it |
| Local Bot API server | `MAX_FILE_SIZE_BYTES` | 2000 MB | Also Telegram's own ceiling |
| Uploader single request | `UPLOAD_SINGLE_MAX_BYTES` | 2 GiB | Above this the uploader splits |
| One part | `UPLOAD_PART_MAX_BYTES` | 2 GiB | Hard cap on any request body |
| Assembled result | `MAX_ASSEMBLED_FILE_BYTES` | 5 GiB | Multi-part and the uploader |
| MTProto fetch | `MTPROTO_MAX_FILE_BYTES` | 5 GiB | Forwarded media |
| Parts per session | `MULTIPART_MAX_PARTS` | 64 | |

Raising `MAX_ASSEMBLED_FILE_BYTES` also raises the disk you need: assembly
writes the whole file into `DOWNLOAD_TMP_DIR` before it is filed, so the peak is
the assembled size plus the parts still on disk.
