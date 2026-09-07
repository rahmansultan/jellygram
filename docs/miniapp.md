# The Telegram Mini App

A second interface running inside Telegram: your library with posters, an upload
button, live transfer progress, and your history. Same accounts, same pipeline,
same private Jellyfin libraries. A different door, not a different system.

It is optional and off until `MINIAPP_URL` names an **https** address.

## Enabling it

1. Get an https URL that Telegram will open — see
   [networking.md](networking.md). Plain HTTP, a bare IP address and a
   self-signed certificate are all refused by Telegram, not by this application.
2. Point `.env` at it:

   ```env
   MINIAPP_ENABLED=true
   MINIAPP_URL=https://media.example.com/app
   ```

3. Restart the bot. It registers the menu button itself.

With `MINIAPP_URL` empty, no button is registered at all — better than one that
opens a page Telegram will not load.

## Authentication

Telegram hands a Mini App a signed blob describing who opened it. That signature
is the **only** thing that establishes identity: a WebView can be made to claim
any user id, any username, anything at all.

```
secret   = HMAC-SHA256(key: "WebAppData", data: bot_token)
expected = HMAC-SHA256(key: secret, data: data_check_string)
```

`data_check_string` is every field except `hash` — and except `signature`, which
Telegram appends for its newer scheme and does not include in the HMAC — as
`key=value`, sorted, newline-joined. Implemented in
[`src/lib/telegram-initdata.ts`](../src/lib/telegram-initdata.ts) with no
dependencies, and compared in constant time.

Every request carries it as a header:

```
Authorization: tma <initData>
```

It is **re-verified on every request** rather than exchanged once for a session
of our own. That keeps the credential's lifetime Telegram's business, adds no
table to expire and purge, and means a deactivated user loses access on their
very next request rather than whenever a session we minted happened to run out.

After the signature checks out, the Telegram id is looked up in the **existing**
`users` table. A genuine signature from an account nobody registered gets a 403:
authentication succeeded, authorisation did not.

| Condition | Response |
| --- | --- |
| No `Authorization` header | 401 `NO_INIT_DATA` |
| Bad or edited signature | 401 `BAD_INIT_DATA` |
| `auth_date` older than `MINIAPP_MAX_AGE_SEC` | 401 `EXPIRED` |
| Valid signature, unknown Telegram account | 403 `NOT_REGISTERED` |
| Valid signature, deactivated account | 403 `DEACTIVATED` |

The credential is bound to the bot that signed it: a blob signed by a different
bot token fails verification, so one deployment's credential is useless against
another's.

### No CSRF token, deliberately

The credential is a custom header, not a cookie. A browser attaches cookies to
cross-site requests automatically — which is the entire reason CSRF exists — but
it will not let another origin set `Authorization` without this server's CORS
permission, which is never granted.

The admin dashboard keeps its cookie-plus-CSRF scheme unchanged, because a
cookie is exactly the case CSRF defends.

### Flood control

Repeated bad signatures from one client are throttled
(`src/api/flood.ts`), and the throttle is keyed so that an attacker hammering
the endpoint cannot lock out a legitimate user. Verification is attempted only
after a cheap size check, so an oversized blob is rejected without spending an
HMAC on it.

## What the client may ask for

Nothing that names a user. There is **no `userId` parameter on any endpoint**,
and one supplied in a query string is ignored rather than honoured. Every query
is constrained server-side to the account the signature resolved to, and every
route that takes an id in the path loads the row and checks it belongs to the
caller.

Somebody else's row is reported as **404 rather than 403**, so the endpoint
cannot be walked to learn which ids exist.

| Endpoint | Returns |
| --- | --- |
| `GET /api/miniapp/config` | Unauthenticated. Whether the app is on, and what it accepts |
| `GET /api/miniapp/me` | Identity, storage, counts, the Jellyfin addresses, `appName` |
| `GET /api/miniapp/library` | Your media, paged, filtered by type |
| `GET /api/miniapp/uploads` | Your history, paged, filtered by status |
| `GET /api/miniapp/active` | Your transfers still in flight |
| `POST /api/miniapp/uploads/:id/cancel` | Yours only |
| `POST /api/miniapp/uploads/:id/retry` | Yours only |
| `GET /api/miniapp/poster/:id` | Yours only |

`/config` is unauthenticated and says only that the app exists and what it would
accept — no name, no branding, no counts, nothing about *whose* instance it is.
`APP_NAME` rides on `/me`, which requires a verified credential. The Mini App is
opened over a public URL, so an anonymous caller should learn as little as
possible; `tests/miniapp.test.ts` asserts this.

## Uploading

The Mini App does **not** implement uploading. It calls `/api/upload` — the same
endpoints the command-line uploader uses, with the same size planning, the same
resumable multi-part flow, the same quota and disk checks, the same
deduplication. The only change to that router was its authentication, which now
accepts either credential:

```
Authorization: Bearer <upload token>   the command-line uploader
Authorization: tma <initData>          the Mini App
```

Every route below that already constrained itself to `req.uploadUser.id`, so
extending the credential widened nothing.

Transfer progress in the browser comes from `XMLHttpRequest`'s upload progress
events — the browser's own count of bytes written to the socket. Progress
*after* the transfer comes from the worker's recorded snapshot and carries
`byteAccurate`, which says whether the percentage was measured or is merely a
position in the pipeline. A stage estimate is never given a speed or an ETA,
because an invented ETA is worse than none.

## Posters

Proxied through this origin rather than fetched by the phone. Three reasons:

- A Jellyfin image is usually plain HTTP and would be blocked as mixed content
  on an HTTPS page.
- Loading straight from TMDB would tell TMDB which titles a private library
  holds, from the owner's own phone.
- Same-origin images keep `img-src 'self'` intact in the CSP.

Ownership is checked before a poster is served.

## Opening Jellyfin

The "Open Jellyfin" button **measures** rather than assumes. It probes the
configured addresses in the order **tailscale → lan → internet** and opens the
first that answers.

```env
JELLYFIN_TAILSCALE_URL=https://jellyfin.tailnet.ts.net:8443
JELLYFIN_PUBLIC_URL=http://192.0.2.10:8096
JELLYFIN_INTERNET_URL=https://jellyfin.example.com
```

So a phone at home takes the fast local route and the same phone elsewhere still
works — without the user choosing, and without this application knowing where
the phone is. Only set the addresses that are real; one that never answers costs
a probe timeout on every open.

## Framing

The Mini App is loaded inside Telegram's own WebView, so it must be frameable by
Telegram and by nothing else. The dashboard, which must never be framed at all,
keeps its own stricter headers. The two are served under different paths with
different policies rather than one compromise policy for both.

## Development

`public/miniapp/` has no build step. Edit a file, reload.

Testing it outside Telegram is awkward by design — there is no valid `initData`
without a real Telegram client. `tests/miniapp-ui.test.mjs` drives the real
bundle in jsdom with a scripted network and a stubbed `window.Telegram`, which
covers rendering and behaviour; `tests/miniapp.test.ts` exercises the API over
real HTTP with credentials it signs itself using the suite's own bot token.

Between them: two users are created for every run and each one's credential is
pointed at the other's data — their uploads, their media, cancelling and
retrying their transfers, fetching their posters. A single one of those
succeeding would be a privacy breach in a system whose entire purpose is that
one person cannot see another's library.
