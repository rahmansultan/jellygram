import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { config, ensureDirectories } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { runMigrations } from '../db/migrate.js';
import { closePool } from '../db/pool.js';
import { adminsRepo } from '../db/repositories.js';
import { purgeExpiredSessions } from './auth.js';
import { router } from './routes/index.js';
import { uploadRouter } from './upload.js';
import { miniappRouter } from './miniapp.js';
import { admitRequest } from './flood.js';
import { reportStartupFailure } from '../lib/startup.js';

/**
 * Admin dashboard server: JSON API under /api plus the static single-page
 * frontend. It never touches the media pipeline directly; everything goes
 * through the same repositories the worker uses.
 */

const log = createLogger('api');
const app = express();

// `req.ip` must reflect the real client when a reverse proxy terminates TLS.
// Only loopback is trusted to say so: the proxy in front of this (Tailscale)
// connects from 127.0.0.1, while LAN clients reach the port directly, so a
// forwarded-for header they invent is ignored and cannot borrow another
// address to spend someone else's rate-limit budget.
if (config.admin.trustProxy) app.set('trust proxy', 'loopback');
app.disable('x-powered-by');

/**
 * Whether this deployment actually terminates TLS.
 *
 * `ADMIN_COOKIE_SECURE` is already the flag that says "reachable over HTTPS",
 * so the three headers that only make sense on a secure origin key off it.
 */
const servedOverTls = config.admin.cookieSecure;

/**
 * The same question, asked per request instead of per deployment.
 *
 * One process now answers on two very different origins: plain HTTP on the LAN,
 * and HTTPS through a proxy from the public internet. A single startup-time
 * flag cannot be right for both — it either withholds HSTS from the origin that
 * needs it or promises TLS to the one that has none. `req.secure` reads the
 * forwarded protocol, and is trustworthy for exactly the reason `req.ip` is:
 * only loopback, where the proxy sits, is believed.
 */
function requestOverTls(req: Request): boolean {
  return servedOverTls || req.secure;
}

/**
 * The dashboard's policy, unchanged — and a second one for the Mini App.
 *
 * `frame-ancestors 'none'` is right for an admin dashboard and fatal for a
 * Mini App: on Telegram Desktop and Telegram Web the app is rendered in an
 * iframe, so that single directive would leave a blank panel with a console
 * error and no other symptom. Rather than weakening the dashboard, the two
 * surfaces get their own policies and a request is dispatched to one or the
 * other by path.
 */
const MINIAPP_PATHS = /^\/(app|api\/miniapp)(\/|$)/;

/**
 * The origins the Mini App is allowed to measure its way to Jellyfin through.
 *
 * Choosing a route means fetching from each candidate, which is cross-origin,
 * so each one has to be named in connect-src. Only https routes are listed: a
 * plain-http address is refused by the browser as mixed content before any
 * policy is consulted, so listing it would promise something that will never
 * be delivered — which is also why the LAN address is opened, never probed.
 */
const jellyfinProbeOrigins = [config.jellyfin.tailscaleUrl, config.jellyfin.internetUrl]
  .filter((url): url is string => Boolean(url) && url.startsWith('https://'))
  .map((url) => new URL(url).origin);

const buildMiniappHelmet = (tls: boolean): ReturnType<typeof helmet> => helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Telegram's own SDK, which is what injects the theme, the viewport and
      // the signed initData. It is the one script this origin does not serve
      // itself, and the app falls back to reading initData from the URL
      // fragment if it fails to load, so the allowance buys the polish rather
      // than the authentication.
      scriptSrc: ["'self'", 'https://telegram.org'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      // Posters are proxied through this origin precisely so no third-party
      // host is needed — see the poster route in miniapp.ts. `blob:` is
      // required because the bytes are fetched with the credential in a header
      // and handed to the element as an object URL; an `<img src>` pointed
      // straight at the proxy would carry no header and always 401.
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", ...jellyfinProbeOrigins],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      // The only difference from the dashboard's policy.
      frameAncestors: ["'self'", 'https://web.telegram.org', 'https://*.telegram.org'],
      upgradeInsecureRequests: tls ? [] : null,
    },
  },
  hsts: tls,
  crossOriginOpenerPolicy: false,
  // The page is embedded by Telegram; an opener/embedder policy would fight
  // that for no benefit here.
  crossOriginEmbedderPolicy: false,
  // Telegram frames the app, so a legacy X-Frame-Options: SAMEORIGIN would
  // override the frame-ancestors list above in browsers that honour both.
  frameguard: false,
});

const miniappHelmetTls = buildMiniappHelmet(true);
const miniappHelmetPlain = buildMiniappHelmet(false);

const buildDashboardHelmet = (tls: boolean): ReturnType<typeof helmet> => helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // The dashboard is a single self-contained page with no CDN use.
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // `upgrade-insecure-requests` makes the browser rewrite every http://
        // subresource to https:// before requesting it. Served over plain HTTP
        // that points the browser at a port speaking no TLS, so the page loads
        // but every stylesheet and script fails with ERR_SSL_PROTOCOL_ERROR.
        //
        // Helmet ships the directive in its defaults and *merges* them with the
        // directives given here, so it has to be removed explicitly with null
        // rather than simply left out. It returns automatically once the
        // dashboard is behind TLS.
        upgradeInsecureRequests: tls ? [] : null,
      },
    },
    // HSTS would pin browsers to an HTTPS endpoint that does not exist here.
    hsts: tls,
    // Cross-Origin-Opener-Policy is ignored by browsers on a non-secure origin
    // and only emits a console warning there, so it is applied with TLS.
    crossOriginOpenerPolicy: tls ? { policy: 'same-origin' } : false,
    crossOriginEmbedderPolicy: false,
});

// Decided per request, like the Mini App's: the dashboard is reached over
// plain HTTP on the LAN and over TLS through the loopback proxy, and only the
// second of those should be told to pin itself to HTTPS.
const dashboardHelmetTls = buildDashboardHelmet(true);
const dashboardHelmetPlain = buildDashboardHelmet(false);

/**
 * The paths reachable from outside this network, and the only ones the flood
 * ceiling applies to. The dashboard and the admin API are not on the list
 * because they are not exposed; if that ever changes this is the line to
 * revisit, not a reason to leave them uncounted.
 */
const PUBLIC_PATHS = /^\/(app|api\/miniapp|api\/upload)(\/|$)/;

// First in the chain, ahead of even the security headers: a request that will
// not be served should cost as little as possible to refuse.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!PUBLIC_PATHS.test(req.path)) return next();
  const verdict = admitRequest(req.ip ?? 'unknown');
  if (verdict.allowed) return next();
  log.warn({ ip: req.ip, path: req.path }, 'Request refused: address is flooding');
  res.setHeader('Retry-After', String(verdict.retryAfterSec));
  res.status(429).json({ error: 'Too many requests. Slow down.', code: 'FLOOD' });
});

app.use((req: Request, res: Response, next: NextFunction) => {
  const tls = requestOverTls(req);
  if (MINIAPP_PATHS.test(req.path)) {
    const guard = tls ? miniappHelmetTls : miniappHelmetPlain;
    return guard(req, res, next);
  }
  return (tls ? dashboardHelmetTls : dashboardHelmetPlain)(req, res, next);
});

// The ingest routes stream multi-gigabyte bodies straight to disk, so they are
// mounted ahead of the JSON parser, which would otherwise try to buffer them.
app.use('/api/upload', uploadRouter);

app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// Request logging, minus health checks which would drown everything else.
app.use((req: Request, res: Response, next: NextFunction) => {
  const startedAt = Date.now();
  // Captured now: by the time 'finish' fires, a mounted router has rewritten
  // `req.path` relative to its mount point, so `/api/miniapp/active` reads as
  // `/active` — which is why the exclusion below never matched, and why the
  // admin and Mini App routers' requests were indistinguishable in the log.
  const path = req.originalUrl.split('?')[0] ?? req.path;
  res.on('finish', () => {
    // The Mini App polls this every few seconds while a transfer runs; logging
    // each tick buries everything else on a small host.
    if (path === '/api/health' || path === '/api/miniapp/active') return;
    log.info(
      {
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
        ip: req.ip,
      },
      'request',
    );
  });
  next();
});

if (config.miniapp.enabled) app.use('/api/miniapp', miniappRouter);
app.use('/api', router);

const publicDir = path.join(config.projectRoot, 'public');
const miniappDir = path.join(publicDir, 'miniapp');

// The Mini App is a separate bundle with its own shell. Mounted before the
// dashboard's static handler and its catch-all, both of which would otherwise
// answer /app with the dashboard's index.html.
/**
 * Options for every `res.sendFile` below.
 *
 * `dotfiles: 'allow'` is about the *installation* path, not about anything a
 * caller sends. `send` refuses any path with a dot-prefixed segment in it, and
 * it applies that rule to the whole absolute path — so a checkout under
 * `~/.local/share/jellygram`, or any other hidden directory, made every one of
 * these routes fail with a 404 from `send` that arrived at the browser as a 500.
 * The dashboard's first page still loaded, because `express.static` checks the
 * request path rather than its own root, which made it look like the SPA was
 * broken only on refresh and only on some machines.
 *
 * There is no traversal risk here: each filename below is a literal joined to
 * the project root, and no part of it comes from the request.
 */
const shellFile = { dotfiles: 'allow' } as const;

if (config.miniapp.enabled) {
  // Answered before the static mount, which would otherwise redirect `/app` to
  // `/app/`. Telegram launches the app with its credential in the URL fragment,
  // and a fragment is the one part of a URL a redirect is under no obligation
  // to carry, so the entry point must not redirect at all.
  app.get('/app', (_req: Request, res: Response) => {
    res.sendFile(path.join(miniappDir, 'index.html'), shellFile);
  });
  app.use('/app', express.static(miniappDir, { index: 'index.html', maxAge: '5m', etag: true }));
  app.get(/^\/app(\/.*)?$/, (_req: Request, res: Response) => {
    res.sendFile(path.join(miniappDir, 'index.html'), shellFile);
  });
}

// The shell is revalidated on every navigation, so a deploy is picked up on
// the next page load rather than up to an hour later; the assets it names are
// still cached, but only briefly, since nothing versions their URLs.
const noCacheShell = (res: Response, file: string): void => {
  if (file.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
};
app.use(
  express.static(publicDir, {
    index: 'index.html',
    maxAge: '5m',
    etag: true,
    setHeaders: noCacheShell,
  }),
);

// Client-side routing: anything not under /api falls back to the SPA shell.
app.get(/.*/, (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, 'index.html'), shellFile);
});

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;

  // Some failures are the client's, and reporting them as 500 sends an honest
  // caller off to read server logs that say nothing is wrong. body-parser
  // raises these with a status of its own; anything else is genuinely ours.
  const status = (err as { status?: number; statusCode?: number }).status
    ?? (err as { statusCode?: number }).statusCode;
  const type = (err as { type?: string }).type;

  if (status === 413 || type === 'entity.too.large') {
    log.warn({ path: req.path, method: req.method }, 'Request body too large');
    return void res.status(413).json({ error: 'That request is too large.' });
  }
  if (type === 'entity.parse.failed' || err instanceof SyntaxError) {
    log.warn({ path: req.path, method: req.method }, 'Malformed request body');
    return void res.status(400).json({ error: 'That request body is not valid JSON.' });
  }

  // A file this server tried to send and could not is a 404, not a 500. It is
  // reported at `warn` with the path, because the only ways to get here are a
  // missing asset (`/favicon.ico` on a deployment that ships none) or a broken
  // installation — neither of which is worth a stack trace on every page load.
  if (status === 404 || (err as { code?: string }).code === 'ENOENT') {
    log.warn({ path: req.path, method: req.method }, 'Not found');
    return void res.status(404).json({ error: 'Not found' });
  }

  log.error({ err, path: req.path, method: req.method }, 'Unhandled request error');
  res.status(500).json({
    // Internal messages stay in the logs; the client gets a stable string.
    error: 'Internal server error',
  });
});

async function main(): Promise<void> {
  ensureDirectories();
  await runMigrations();

  if ((await adminsRepo.count()) === 0) {
    log.warn('No administrator account exists yet. Run: npm run admin:create');
  }

  // Housekeeping: expired sessions would otherwise accumulate forever.
  const purgeTimer = setInterval(
    () => {
      purgeExpiredSessions()
        .then((n) => n > 0 && log.debug({ purged: n }, 'Purged expired sessions'))
        .catch((err) => log.warn({ err }, 'Session purge failed'));
    },
    30 * 60 * 1000,
  );
  purgeTimer.unref();

  const server = app.listen(config.admin.port, config.admin.bindHost, () => {
    log.info(
      { host: config.admin.bindHost, port: config.admin.port, mediaRoot: config.storage.mediaRoot },
      'Admin dashboard listening',
    );
  });

  // Node's 300s default `requestTimeout` silently aborts any upload that takes
  // longer than five minutes, which a multi-gigabyte part on a slow link does.
  // The headers timeout stays short, so an idle connection is still bounded.
  server.requestTimeout = config.admin.requestTimeoutMs;
  server.headersTimeout = config.admin.headersTimeoutMs;

  const shutdown = (signal: string) => {
    log.info({ signal }, 'Shutting down API');
    server.close(() => {
      void closePool().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => log.error({ err: reason }, 'Unhandled rejection'));

main().catch((err) => {
  log.fatal({ err }, 'API failed to start');
  reportStartupFailure(err);
  process.exit(1);
});
