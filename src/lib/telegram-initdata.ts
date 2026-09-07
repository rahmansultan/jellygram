import crypto from 'node:crypto';

/**
 * Telegram Mini App `initData` verification.
 *
 * A Mini App runs in a WebView that Telegram hands a signed blob describing
 * who opened it. Everything a browser can say about itself is forgeable — the
 * user id, the username, the whole payload — so the *only* thing that
 * establishes identity is this signature, computed with a key derived from the
 * bot token. Nothing else in the request may be believed.
 *
 * The scheme is Telegram's:
 *
 *   secret     = HMAC-SHA256(key: "WebAppData", data: bot_token)
 *   expected   = HMAC-SHA256(key: secret, data: data_check_string)
 *
 * where `data_check_string` is every field except `hash`, as `key=value`,
 * sorted by key, joined with newlines. The `signature` field (used for the
 * newer third-party Ed25519 scheme) is excluded as well: Telegram adds it to
 * initData but does not include it in the HMAC.
 *
 * Deliberately dependency-free and side-effect-free so every failure mode can
 * be tested directly.
 */

export type InitDataFailure =
  | 'missing'
  | 'malformed'
  | 'missing-hash'
  | 'bad-signature'
  | 'missing-auth-date'
  | 'expired'
  | 'future-dated'
  | 'missing-user'
  | 'bot-not-configured';

export interface InitDataUser {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  isPremium?: boolean;
  photoUrl?: string;
}

/**
 * Which convention the client signed with. Recorded, not chosen: it is the
 * only way to find out what real clients actually do, and it costs a string.
 */
export type SignedOver = 'fields' | 'fields-with-signature';

export type InitDataResult =
  | {
      ok: true;
      user: InitDataUser;
      authDate: Date;
      queryId?: string;
      signedOver: SignedOver;
      raw: URLSearchParams;
    }
  | { ok: false; reason: InitDataFailure };

/**
 * The maximum length of an initData string we will even parse.
 *
 * Verification is cheap, but it is reachable before authentication, so an
 * unbounded body would let anyone make the server hash megabytes per request.
 * Real initData is well under a kilobyte.
 */
export const MAX_INIT_DATA_BYTES = 4096;

/** Compare two hex digests without leaking where they first differ. */
function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let left: Buffer;
  let right: Buffer;
  try {
    left = Buffer.from(a, 'hex');
    right = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

export interface VerifyOptions {
  /** Seconds an `auth_date` stays acceptable. */
  maxAgeSec: number;
  /** Clock injection point for tests. */
  now?: number;
  /**
   * Tolerance for a client clock running ahead of ours. A signature is proof
   * of origin, not of time, so a small skew is accepted rather than treated as
   * an attack; a wildly future date is not, because it would otherwise extend
   * the replay window indefinitely.
   */
  futureSkewSec?: number;
}

/**
 * Verify an initData string and extract who it belongs to.
 *
 * Returns a discriminated result rather than throwing: every branch here is an
 * expected condition on a public endpoint, and the caller needs to tell them
 * apart to decide between "sign in again" and "you are not registered".
 */
export function verifyInitData(
  initData: string | undefined | null,
  botToken: string,
  options: VerifyOptions,
): InitDataResult {
  if (!botToken) return { ok: false, reason: 'bot-not-configured' };
  if (!initData || initData.length === 0) return { ok: false, reason: 'missing' };
  if (Buffer.byteLength(initData, 'utf8') > MAX_INIT_DATA_BYTES) {
    return { ok: false, reason: 'malformed' };
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: 'missing-hash' };

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const given = hash.toLowerCase();
  const entries = [...params.entries()].filter(([key]) => key !== 'hash');

  const checkString = (pairs: Array<[string, string]>): string =>
    pairs.map(([key, value]) => `${key}=${value}`).sort().join('\n');
  const hmac = (data: string): string =>
    crypto.createHmac('sha256', secret).update(data).digest('hex');

  // Two conventions are in the wild. Telegram documents the check string as
  // every received field except `hash`, and `signature` — the Ed25519 field
  // added for third-party validation — is a received field; but several widely
  // used libraries leave `signature` out as well, and clients are signed both
  // ways. Both are accepted. Each is an HMAC over a fully determined string
  // keyed by the bot token, so admitting the second forges nothing the first
  // did not already admit: without the token neither can be produced.
  //
  // Checked before anything else in the payload is read: an unsigned blob has
  // no fields, only claims.
  let signedOver: SignedOver | null = null;
  if (timingSafeHexEqual(hmac(checkString(entries.filter(([key]) => key !== 'signature'))), given)) {
    signedOver = 'fields';
  } else if (params.has('signature') && timingSafeHexEqual(hmac(checkString(entries)), given)) {
    signedOver = 'fields-with-signature';
  }
  if (!signedOver) return { ok: false, reason: 'bad-signature' };

  const authDateRaw = params.get('auth_date');
  if (!authDateRaw || !/^\d{1,15}$/.test(authDateRaw)) {
    return { ok: false, reason: 'missing-auth-date' };
  }
  const authDateSec = Number(authDateRaw);
  const nowSec = Math.floor((options.now ?? Date.now()) / 1000);
  const ageSec = nowSec - authDateSec;

  if (ageSec > options.maxAgeSec) return { ok: false, reason: 'expired' };
  if (-ageSec > (options.futureSkewSec ?? 300)) return { ok: false, reason: 'future-dated' };

  const userJson = params.get('user');
  if (!userJson) return { ok: false, reason: 'missing-user' };

  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(userJson);
    // Telegram sends an object. `null`, an array or a scalar is well-formed
    // JSON that would still throw on the first property read below.
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: 'malformed' };
    }
    parsed = value as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const id = parsed['id'];
  // A Telegram id is a positive integer well inside the safe range, and it
  // arrives as a JSON number — not a string, a boolean or an array that
  // `Number()` would happily coerce. Anything else would be handed to a query
  // that expects a bigint.
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    return { ok: false, reason: 'missing-user' };
  }

  const str = (key: string): string | undefined => {
    const value = parsed[key];
    return typeof value === 'string' && value.length > 0 ? value.slice(0, 128) : undefined;
  };

  return {
    ok: true,
    user: {
      id,
      firstName: str('first_name') ?? '',
      lastName: str('last_name'),
      username: str('username'),
      languageCode: str('language_code'),
      isPremium: parsed['is_premium'] === true,
      photoUrl: str('photo_url'),
    },
    authDate: new Date(authDateSec * 1000),
    queryId: params.get('query_id') ?? undefined,
    signedOver,
    raw: params,
  };
}

/**
 * Build a signed initData string. Test helper, and the only way to exercise
 * the verifier honestly — a fixture with a hard-coded hash would silently stop
 * proving anything the moment the algorithm changed.
 */
export function signInitData(
  fields: Record<string, string>,
  botToken: string,
  options: { signedOver?: SignedOver } = {},
): string {
  const overSignature = options.signedOver === 'fields-with-signature';
  const pairs = Object.entries(fields)
    .filter(([k]) => k !== 'hash' && (overSignature || k !== 'signature'))
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');

  const params = new URLSearchParams(fields);
  params.set('hash', hash);
  return params.toString();
}
