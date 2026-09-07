/**
 * Give the suite credentials of its own, so no test can use yours.
 *
 * Several behaviours are gated on whether a credential is configured at all:
 * the Mini App refuses every request with 503 when there is no bot token to
 * verify a signature against, the Jellyfin client throws before it builds a
 * request when there is no API key, and the progress reporter sends nothing
 * when Telegram is not configured. Without this helper those tests passed on a
 * machine whose `.env` happened to be filled in and failed on a fresh clone —
 * which is the wrong way round, because a fresh clone is the case that has to
 * work.
 *
 * The values are forced rather than defaulted. Deferring to whatever `.env`
 * holds would mean that a developer with a working deployment runs the suite
 * against their real bot token and their real Jellyfin key, and the first test
 * that forgets to stub `fetch` reaches their live server. A test must not be
 * able to do that even by accident, so the real values are never visible here.
 *
 * The tokens are syntactically valid and semantically worthless: the bot token
 * matches the shape `config.telegram.configured` checks for, and signing with
 * it produces credentials this suite can verify and nobody else can.
 *
 * Imported for its side effect, *before* the config module — ESM evaluates
 * imported modules in statement order, so this import must come first in the
 * test file, alongside the database and media-root helpers.
 */

/** Shaped like a real token so `configured` is true; not one. */
process.env['TELEGRAM_BOT_TOKEN'] = '123456789:AA-suite-token-never-issued-by-telegram';

/**
 * An address nothing listens on.
 *
 * Every test that talks to Telegram or Jellyfin stubs `fetch` or drives a
 * local server. If one ever fails to, it fails on a refused connection here
 * instead of quietly reaching api.telegram.org or the developer's own Jellyfin
 * — a loud, immediate failure rather than a silent side effect on a live
 * system. Port 9 is discard, and 127.0.0.1 never leaves the machine.
 */
process.env['TELEGRAM_API_ROOT'] = 'http://127.0.0.1:9';
process.env['JELLYFIN_URL'] = 'http://127.0.0.1:9';
process.env['JELLYFIN_PUBLIC_URL'] = 'http://127.0.0.1:9';
process.env['JELLYFIN_TAILSCALE_URL'] = '';
process.env['JELLYFIN_INTERNET_URL'] = '';
process.env['JELLYFIN_API_KEY'] = 'suite-jellyfin-key-not-a-real-credential';
process.env['JELLYFIN_LIBRARY_PREFIX'] = '';

/**
 * TMDB stays off. It is the one integration with no local stand-in — an
 * enabled key would make identification tests depend on a third party's
 * uptime, rate limits and catalogue, and would spend the developer's quota to
 * do it.
 */
process.env['TMDB_API_KEY'] = '';

/** Nothing in the unit suite may open a real MTProto session. */
process.env['TELEGRAM_MTPROTO_ENABLED'] = 'false';

/** No admin chat, so `notifyAdmin` has nowhere to send and says so. */
process.env['TELEGRAM_ADMIN_CHAT_ID'] = '';

/** A deterministic name, so branding assertions do not depend on `.env`. */
process.env['APP_NAME'] = 'Test Media Library';

export const TEST_BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN'];
