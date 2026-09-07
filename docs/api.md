# HTTP API reference

Three routers, three authentication schemes:

| Base path | Who calls it | Credential |
| --- | --- | --- |
| `/api` | The admin dashboard | Session cookie + `x-csrf-token` on writes |
| `/api/miniapp` | The Telegram Mini App | `Authorization: tma <initData>` |
| `/api/upload` | The uploader and the Mini App | `Authorization: Bearer <token>` or `tma <initData>` |

All responses are JSON. Errors carry `{ error, code }`, where `code` is a stable
machine-readable string and `error` is a sentence meant for a person.

## Admin API — `/api`

Every route except `/api/health` and `/api/auth/login` requires a session
cookie. Every non-`GET` additionally requires the `x-csrf-token` header.

### Authentication

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/auth/login` | `{username, password}` → `{username, csrfToken, expiresAt}` |
| `POST` | `/auth/logout` | Destroy the session |
| `GET` | `/auth/me` | The current administrator and a fresh CSRF token |
| `POST` | `/auth/password` | `{currentPassword, newPassword}`; invalidates every session |

### Users

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/users` | All users, with storage usage and libraries |
| `POST` | `/users` | Create and provision |
| `PATCH` | `/users/:id` | Update |
| `DELETE` | `/users/:id` | Delete records and libraries. **Never deletes files** |
| `POST` | `/users/:id/provision` | Re-apply directories, libraries and access policy |
| `GET` | `/users/:id/uploads` | That user's upload history |

### Uploads and media

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/uploads` | Filter by `userId`, `status`, `mediaType`, `q`; paginated |
| `GET` | `/uploads/:id` | One upload, with its failure diagnostics |
| `POST` | `/uploads/:id/retry` | Requeue a failed or cancelled upload |
| `POST` | `/uploads/:id/cancel` | Request cancellation; the worker stops at the next chunk |
| `GET` | `/media` | Filter by `userId`, `type`, `q`; paginated |
| `DELETE` | `/media/:id` | `{deleteFile: boolean}` — the record always, the file optionally |

### Multi-part sessions and MTProto jobs

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/sessions` | Multi-part sessions from either ingest route |
| `GET` | `/sessions/:id` | One session and its parts |
| `POST` | `/sessions/:id/cancel` | Cancel and release its parts |
| `GET` | `/mtproto` | Forwarded-media jobs, with progress, speed and ETA |
| `POST` | `/mtproto/:id/retry` | Retry a failed fetch |
| `POST` | `/mtproto/:id/cancel` | Cancel one |

### System

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/dashboard` | Counts, storage, recent uploads |
| `GET` | `/storage` | Disk, per-user usage, thresholds, paths |
| `GET` | `/storage/scan` | Actual on-disk sizes, measured rather than summed |
| `GET` | `/system/status` | Database, Jellyfin, TMDB, Telegram, queue |
| `GET` | `/system/health` | The health checks behind the alerting |
| `GET` | `/system/privacy` | The isolation audit, derived from Jellyfin |
| `POST` | `/system/privacy/enforce` | Re-apply isolation for every managed user |
| `POST` | `/system/jellyfin/scan` | Trigger a full library scan |
| `GET` | `/settings` | Effective configuration; secrets as flags only |
| `PUT` | `/settings` | Set a non-secret override |
| `GET` | `/audit` | The audit log, paginated |
| `GET` | `/logs/:service` | Tail of the `api`, `bot` or `worker` log |
| `GET` | `/health` | **Unauthenticated** liveness probe |

`GET /health` returns `{status, database, appName}` and is the only admin route
that answers without a session. It is what a container healthcheck or an uptime
monitor should poll.

`PUT /settings` refuses any key matching `token|key|secret|password`. Settings
are otherwise read-only by design — configuration lives in `.env` and is applied
by restarting, so what the dashboard reports is what the processes actually
loaded.

## Mini App API — `/api/miniapp`

`Authorization: tma <initData>`, re-verified on every request. Full model in
[miniapp.md](miniapp.md).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/config` | **Unauthenticated.** Whether the app is on, and what it accepts |
| `GET` | `/me` | Identity, storage, counts, Jellyfin addresses, `appName` |
| `GET` | `/library` | Your media. `limit`, `offset`, `type`, `q` |
| `GET` | `/uploads` | Your history. `limit`, `offset`, `status` |
| `GET` | `/active` | Your transfers still in flight |
| `POST` | `/uploads/:id/cancel` | Yours only |
| `POST` | `/uploads/:id/retry` | Yours only |
| `GET` | `/poster/:id` | Yours only; proxied through this origin |

There is **no `userId` parameter** on any of these. One supplied in a query
string is ignored, not honoured. Another user's row is reported as 404, not 403.

`/config` deliberately carries no name and no counts: an unauthenticated caller
learns that the app exists and what it would accept, and nothing about whose it
is.

| Auth failure | Status | Code |
| --- | --- | --- |
| No `Authorization` header | 401 | `NO_INIT_DATA` |
| Bad or edited signature | 401 | `BAD_INIT_DATA` |
| Older than `MINIAPP_MAX_AGE_SEC` | 401 | `EXPIRED` |
| Valid signature, unknown account | 403 | `NOT_REGISTERED` |
| Valid signature, deactivated account | 403 | `DEACTIVATED` |

## Upload ingest — `/api/upload`

Accepts either credential:

```
Authorization: Bearer <upload token>   the command-line uploader
Authorization: tma <initData>          the Mini App
```

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/begin` | Declare a filename and size. Returns the plan: single or `n` parts |
| `PUT` | `/part/:sessionId/:index` | Stream one part. Idempotent — an already-received part is skipped |
| `POST` | `/complete/:sessionId` | Assemble and hand to the pipeline |
| `POST` | `/single` | Stream a whole file in one request |
| `GET` | `/status/:sessionId` | Which parts the server already holds |

`/begin` decides from the **declared** size, before any bytes move, so the 2 GiB
and 5 GiB boundaries can be exercised without transferring gigabytes. That is
also how the uploader resumes: it asks `/status`, then sends only what is
missing.

Each part's length is verified on arrival; a truncated part is rejected with an
explanation and is not recorded. `UPLOAD_PART_MAX_BYTES` is a hard cap on any
single request body.

## Status codes

| Code | Meaning |
| --- | --- |
| `200` | Success |
| `201` | Created |
| `400` | Malformed request |
| `401` | Unauthenticated |
| `403` | CSRF failure, or authenticated but not permitted |
| `404` | Missing — **or** present but not yours |
| `409` | Conflict: a duplicate, or a session in the wrong state |
| `413` | Body over `UPLOAD_PART_MAX_BYTES` |
| `422` | Validation failed; the body names the field |
| `429` | Throttled |
| `500` | Internal. The response carries no detail; the log does |
| `503` | A dependency is down, or the Mini App is disabled |

## Timeouts

`API_REQUEST_TIMEOUT_SEC` (4 hours by default) governs how long one request may
take, because Node's 300-second default silently kills any upload over five
minutes. `API_HEADERS_TIMEOUT_SEC` stays short so slowloris is still bounded.

Behind a reverse proxy, raise its limits to match — nginx's
`client_max_body_size` and `proxy_read_timeout` will otherwise cut an upload off
long before this application does.
