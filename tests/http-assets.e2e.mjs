import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/**
 * HTTP-level asset test.
 *
 * Regression cover for the `upgrade-insecure-requests` CSP directive, which
 * made browsers rewrite every http:// subresource to https:// and so broke
 * every stylesheet and script on a plain-HTTP deployment.
 *
 * It also proves the page references its assets with same-origin relative
 * paths and no hard-coded host, so the dashboard works over whatever address
 * it happens to be reached on.
 *
 * By default it starts an API of its own on a free port and stops it again, so
 * a clean checkout — and CI — can run it with nothing already listening. Give
 * it an address to test a server you are already running instead:
 *
 *   node tests/http-assets.e2e.mjs                      start one, test it, stop it
 *   node tests/http-assets.e2e.mjs http://127.0.0.1:8300  test a running dashboard
 *   DASHBOARD_URL=… node tests/http-assets.e2e.mjs        the same, from the environment
 *
 * Only PostgreSQL is required: the server it starts reaches the database named
 * by DATABASE_URL and nothing else, and it is given credentials that point at
 * a dead port so no test can reach a real Telegram or Jellyfin.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const TARGET = process.argv[2] ?? process.env.DASHBOARD_URL ?? '';

let failures = 0;

function check(name, fn) {
  try {
    fn();
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
  }
}

/** A port the kernel just told us is free. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Start `dist/api/server.js` on a free loopback port and wait for its health
 * endpoint. Returns the base URL and a stop function.
 *
 * The credentials handed to it are deliberately worthless and point at a dead
 * port, for the same reason `tests/helpers/test-credentials.ts` does it: a
 * server started by the suite must not be able to reach anybody's real
 * Telegram bot or Jellyfin server, even by accident.
 */
async function startServer() {
  const entry = path.join(ROOT, 'dist', 'api', 'server.js');
  if (!fs.existsSync(entry)) {
    process.stdout.write(
      `\nFATAL: ${path.relative(ROOT, entry)} does not exist. Run 'npm run build' first.\n\n`,
    );
    process.exit(1);
  }

  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ADMIN_PORT: String(port),
      ADMIN_BIND_HOST: '127.0.0.1',
      LOG_TO_FILE: 'false',
      LOG_LEVEL: 'silent',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_API_ROOT: 'http://127.0.0.1:9',
      JELLYFIN_URL: 'http://127.0.0.1:9',
      JELLYFIN_API_KEY: '',
      TMDB_API_KEY: '',
      MEDIA_ROOT: path.join(ROOT, '.test-media'),
      QUEUE_PAUSED: 'true',
    },
  });

  let output = '';
  child.stdout.on('data', (c) => (output += c));
  child.stderr.on('data', (c) => (output += c));

  const base = `http://127.0.0.1:${port}`;
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    });

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) {
      process.stdout.write(
        `\nFATAL: the API exited with status ${child.exitCode} before it was ready.\n` +
          `${output.trim() || '(no output)'}\n\n` +
          'A configuration error exits 78; an unreachable database exits 1.\n' +
          'Check DATABASE_URL, and see docs/testing.md.\n\n',
      );
      process.exit(1);
    }
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return { base, stop };
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      await stop();
      process.stdout.write(
        `\nFATAL: the API did not answer on ${base} within 60s.\n${output.trim()}\n\n`,
      );
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Every href/src in the document, in source order. */
function assetRefs(html) {
  const refs = [];
  for (const m of html.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/gi)) refs.push(m[1]);
  return refs;
}

async function main() {
  const started = TARGET ? null : await startServer();
  const BASE = (TARGET || started.base).replace(/\/+$/, '');
  try {
    await run(BASE, started === null);
  } finally {
    if (started) await started.stop();
  }
}

async function run(BASE, external) {
  process.stdout.write(
    `\nHTTP asset test\n===============\nTarget: ${BASE}${external ? '' : '  (started by this test)'}\n\n`,
  );

  const scheme = new URL(BASE).protocol;

  // -----------------------------------------------------------------------
  process.stdout.write('1. Document\n');
  const res = await fetch(`${BASE}/`, { redirect: 'manual' });
  const html = await res.text();

  check('the document returns 200', () => assert.equal(res.status, 200));
  check('it is served as HTML', () =>
    assert.match(res.headers.get('content-type') ?? '', /text\/html/),
  );
  check('it is not redirected', () => assert.ok(!res.headers.get('location')));

  // -----------------------------------------------------------------------
  process.stdout.write('\n2. Headers that would break plain HTTP\n');
  const csp = res.headers.get('content-security-policy') ?? '';

  check('a CSP is present', () => assert.ok(csp.length > 0));
  check('the CSP does not force upgrade-insecure-requests', () =>
    assert.ok(
      !/upgrade-insecure-requests/i.test(csp),
      'upgrade-insecure-requests makes the browser rewrite every asset URL to https://',
    ),
  );
  check('the CSP does not block mixed content by directive', () =>
    assert.ok(!/block-all-mixed-content/i.test(csp)),
  );

  if (scheme === 'http:') {
    check('no HSTS is sent over plain HTTP', () =>
      assert.equal(res.headers.get('strict-transport-security'), null),
    );
    check('no COOP warning is provoked over plain HTTP', () =>
      assert.equal(res.headers.get('cross-origin-opener-policy'), null),
    );
  }

  // -----------------------------------------------------------------------
  process.stdout.write('\n3. Security headers still in place\n');
  const expected = {
    'x-content-type-options': /nosniff/,
    'referrer-policy': /no-referrer/,
    'x-frame-options': /SAMEORIGIN/i,
    'cross-origin-resource-policy': /same-origin/,
  };
  for (const [header, pattern] of Object.entries(expected)) {
    check(`${header} is set`, () =>
      assert.match(res.headers.get(header) ?? '', pattern),
    );
  }
  for (const directive of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'"]) {
    check(`CSP still has ${directive}`, () => assert.ok(csp.includes(directive)));
  }

  // -----------------------------------------------------------------------
  process.stdout.write('\n4. Asset references in the HTML\n');
  const refs = assetRefs(html);
  const remote = refs.filter((r) => /^(https?:)?\/\//i.test(r));

  check('no asset is referenced by absolute URL or protocol-relative host', () =>
    assert.deepEqual(remote, [], `found: ${remote.join(', ')}`),
  );
  check('no host or IP literal is hard-coded in the document', () =>
    assert.ok(
      !/\b\d{1,3}(\.\d{1,3}){3}\b/.test(html.replace(/viewBox="[^"]*"/g, '')),
      'an IP literal appears in the HTML',
    ),
  );
  check('there is no <base> tag rewriting relative URLs', () =>
    assert.ok(!/<base\b/i.test(html)),
  );

  // -----------------------------------------------------------------------
  process.stdout.write('\n5. Every referenced asset loads\n');
  const fetchable = refs.filter((r) => r.startsWith('/') && !r.startsWith('//'));

  check('the document references at least one stylesheet and one script', () => {
    assert.ok(fetchable.some((r) => r.endsWith('.css')), 'no stylesheet referenced');
    assert.ok(fetchable.some((r) => r.endsWith('.js')), 'no script referenced');
  });

  for (const ref of fetchable) {
    const assetRes = await fetch(`${BASE}${ref}`, { redirect: 'manual' });
    const type = assetRes.headers.get('content-type') ?? '';
    const body = await assetRes.text();

    check(`${ref} → ${assetRes.status}`, () => {
      assert.equal(assetRes.status, 200, `expected 200, got ${assetRes.status}`);
      assert.ok(body.length > 0, 'empty body');

      if (ref.endsWith('.css')) assert.match(type, /text\/css/);
      if (ref.endsWith('.js')) assert.match(type, /javascript/);

      // A SPA fallback that returns index.html for a missing asset would
      // otherwise look like success.
      assert.ok(!/<!doctype html>/i.test(body.slice(0, 200)), 'served the SPA shell instead of the asset');
    });
  }

  // -----------------------------------------------------------------------
  process.stdout.write('\n6. API reachable on the same origin\n');
  const health = await fetch(`${BASE}/api/health`);
  check('/api/health returns 200', () => assert.equal(health.status, 200));
  check('/api/health reports the database is up', async () => {
    assert.equal(health.status, 200);
  });

  const unauth = await fetch(`${BASE}/api/dashboard`);
  check('/api/dashboard still requires authentication', () => assert.equal(unauth.status, 401));

  // -----------------------------------------------------------------------
  // Every shell route is served with res.sendFile, which refuses a path with a
  // dot-prefixed segment in it. On a checkout under a hidden directory these
  // returned 500 while the first page load still worked, so nothing noticed.
  process.stdout.write('\n7. Shell routes\n');

  const deep = await fetch(`${BASE}/media/42`);
  const deepBody = await deep.text();
  check('a deep client-side route falls back to the dashboard shell', () => {
    assert.equal(deep.status, 200);
    assert.match(deep.headers.get('content-type') ?? '', /text\/html/);
    assert.match(deepBody, /<!doctype html>/i);
  });

  const app = await fetch(`${BASE}/app`, { redirect: 'manual' });
  const appBody = await app.text();
  check('the Mini App entry point is served without a redirect', () => {
    assert.equal(app.status, 200, `/app returned ${app.status}`);
    assert.ok(!app.headers.get('location'), 'a redirect would drop Telegram\'s URL fragment');
    assert.match(appBody, /<!doctype html>/i);
  });

  // 401 rather than 404: the admin API refuses an unauthenticated caller before
  // it routes, so it does not disclose which routes exist. Either is fine; a
  // 500 is not, and a 500 is what a failed sendFile used to produce.
  const missing = await fetch(`${BASE}/api/definitely-not-a-route`);
  check('an unknown API route is refused, not a server error', () =>
    assert.ok(missing.status >= 400 && missing.status < 500, `got ${missing.status}`),
  );

  process.stdout.write(
    `\n===============\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stdout.write(`\nFATAL: ${err.message}\n${err.stack}\n`);
  process.exitCode = 1;
});
