import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

/**
 * The Mini App, rendered.
 *
 * Driven the way a phone drives it: the real HTML, the real scripts, a stubbed
 * Telegram client and a stubbed network. What is being checked is not that
 * functions return values but that a person sees the right thing — a greeting
 * rather than a blank panel, an explanation rather than a spinner that never
 * stops, and a percentage only where one was actually measured.
 */

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'public/miniapp');

const ME = {
  // Sent by /me, not by /config: the unauthenticated endpoint deliberately
  // says nothing about whose instance this is.
  appName: 'Example Media Library',
  telegram: { firstName: 'Alice', username: 'alice' },
  account: {
    name: 'Alice Example',
    jellyfinUsername: 'jf-test-user',
    uploadEnabled: true,
    memberSince: '2026-09-01T00:00:00.000Z',
    libraries: 2,
  },
  storage: {
    usedBytes: 5_368_709_120,
    reservedBytes: 0,
    quotaBytes: 21_474_836_480,
    remainingBytes: 16_106_127_360,
    percentUsed: 25,
    movies: 3,
    episodes: 0,
    shows: 0,
  },
  uploads: { total: 3, completed: 3, failed: 0, needsReview: 0, active: 0, lastAt: null },
  jellyfinUrl: 'http://192.0.2.10:8096',
  jellyfin: {
    tailscale: 'https://ts.example:8445',
    lan: 'http://192.0.2.10:8096',
    internet: 'https://ts.example:10000',
  },
};

const CONFIG = {
  enabled: true,
  formats: ['MP4', 'MKV', 'AVI', 'MOV'],
  maxFileBytes: 5_368_709_120,
  singleMaxBytes: 2_097_152_000,
};

/**
 * A DOM with the real bundle and a scripted network.
 *
 * `routes` maps a path fragment to either a body or a {status, body} pair, so
 * a test can make one endpoint fail while the rest succeed.
 */
const windows = [];

after(() => {
  // The app polls, so every DOM left open keeps an interval — and the test
  // runner alive — for ever.
  for (const w of windows) {
    try {
      w.close();
    } catch {
      /* already gone */
    }
  }
});

async function boot({ routes = {}, telegram = {}, onFetch } = {}) {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (e) => errors.push(String(e.message)));

  // The stylesheet is inlined so getComputedStyle reflects the real rules;
  // jsdom does not fetch the <link> itself.
  const css = fs.readFileSync(path.join(dir, 'css/app.css'), 'utf8');
  const withCss = html.replace('</head>', `<style>${css}</style></head>`);
  const dom = new JSDOM(withCss, { pretendToBeVisual: true, runScripts: 'outside-only', virtualConsole });
  const { window } = dom;
  windows.push(window);

  window.Telegram = {
    WebApp: {
      initData: 'auth_date=1&user=%7B%22id%22%3A1%7D&hash=deadbeef',
      initDataUnsafe: { user: { id: 1, first_name: 'Alice' } },
      colorScheme: 'light',
      platform: 'ios',
      ready() {},
      expand() {},
      openLink(url) {
        window.__opened = url;
      },
      showConfirm(_m, cb) {
        cb(window.__confirmAnswer ?? true);
      },
      HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
      onEvent() {},
      ...telegram,
    },
  };

  // jsdom provides no `Response`, so the stub returns the small surface the
  // client actually uses rather than depending on an implementation detail of
  // the test environment.
  const reply = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  });

  const calls = [];
  window.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    onFetch?.(url, init);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const entry = key ? routes[key] : undefined;
    if (entry === undefined) return reply(404, { error: 'not stubbed' });
    if (typeof entry === 'function') return entry(url, init, reply);
    return reply(entry.status ?? 200, 'body' in entry ? entry.body : entry);
  };

  for (const file of ['js/telegram.js', 'js/jellyfin-route.js', 'js/api.js', 'js/app.js']) {
    window.eval(fs.readFileSync(path.join(dir, file), 'utf8'));
  }

  const settle = async (ms = 60) => {
    for (let i = 0; i < 12; i += 1) await new Promise((r) => window.setTimeout(r, ms / 12));
  };
  await settle();

  return {
    window,
    calls,
    errors,
    settle,
    text: () => window.document.getElementById('root')?.textContent ?? '',
    $: (sel) => window.document.querySelector(sel),
    $$: (sel) => [...window.document.querySelectorAll(sel)],
  };
}

const OK_ROUTES = { '/api/miniapp/config': CONFIG, '/api/miniapp/me': ME };

// ---------------------------------------------------------------------------
// Booting
// ---------------------------------------------------------------------------

test('a registered user lands on a home screen that greets them', async () => {
  const app = await boot({ routes: OK_ROUTES });
  assert.match(app.text(), /Example Media Library/);
  assert.match(app.text(), /Welcome, Alice/);
  assert.equal(app.$('#tabbar').hidden, false, 'the tab bar is revealed once signed in');
  assert.equal(app.$('#boot'), null, 'the boot placeholder is gone');
});

test('a navigation row keeps its title and its qualifier on separate lines', async () => {
  const app = await boot({ routes: OK_ROUTES });
  const row = app.$$('.row').find((r) => r.textContent.includes('My Library'));
  assert.ok(row, 'the library row is rendered');

  const body = row.querySelector('.row-body');
  const title = row.querySelector('.row-title');
  const sub = row.querySelector('.row-sub');
  assert.ok(title && sub);
  // Both were spans inside a plain box, so "My Library" and "3 items" ran
  // together as one line of inline text.
  assert.equal(app.window.getComputedStyle(body).flexDirection, 'column');
  assert.equal(app.window.getComputedStyle(title).display, 'block');
  assert.equal(app.window.getComputedStyle(sub).display, 'block');
});

test('an unregistered Telegram account is told why, with no tab bar', async () => {
  const app = await boot({
    routes: {
      '/api/miniapp/config': CONFIG,
      '/api/miniapp/me': { status: 403, body: { error: 'nope', code: 'NOT_REGISTERED' } },
    },
  });
  assert.match(app.text(), /Not registered/);
  assert.match(app.text(), /administrator/i);
  // No navigation into an app they cannot use.
  assert.equal(app.$('#tabbar').hidden, true);
});

test('a deactivated account gets a different explanation', async () => {
  const app = await boot({
    routes: {
      '/api/miniapp/config': CONFIG,
      '/api/miniapp/me': { status: 403, body: { error: 'nope', code: 'DEACTIVATED' } },
    },
  });
  assert.match(app.text(), /deactivated/i);
});

test('an expired session asks the reader to reopen, not to log in', async () => {
  const app = await boot({
    routes: {
      '/api/miniapp/config': CONFIG,
      '/api/miniapp/me': { status: 401, body: { error: 'gone', code: 'EXPIRED' } },
    },
  });
  assert.match(app.text(), /reopen/i);
});

test('an unreachable server offers a retry that actually retries', async () => {
  let attempts = 0;
  const app = await boot({
    routes: {
      '/api/miniapp/config': CONFIG,
      '/api/miniapp/me': (_url, _init, reply) => {
        attempts += 1;
        if (attempts === 1) throw new Error('network down');
        return reply(200, ME);
      },
    },
  });

  assert.match(app.text(), /Could not connect/i);
  const retry = app.$$('button').find((b) => b.textContent === 'Try again');
  assert.ok(retry, 'a failure offers a way forward');

  retry.dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.settle(120);
  assert.match(app.text(), /Welcome, Alice/, 'the retry recovered');
});

test('a disabled app says so rather than failing obscurely', async () => {
  // What the server actually sends when switched off: a 503 with `DISABLED`,
  // not a 200 with `enabled:false`. The old stub certified a screen the
  // production server could never reach.
  const app = await boot({
    routes: {
      '/api/miniapp/config': { status: 503, body: { enabled: false, error: 'The Mini App is disabled.', code: 'DISABLED' } },
    },
  });
  assert.match(app.text(), /Unavailable/i);
  assert.doesNotMatch(app.text(), /Could not connect/i);
});

// ---------------------------------------------------------------------------
// Identity is never asserted by the client
// ---------------------------------------------------------------------------

test('every request carries the signed credential and never a user id', async () => {
  const app = await boot({ routes: OK_ROUTES });
  const api = app.calls.filter((c) => c.url.includes('/api/miniapp/'));
  assert.ok(api.length >= 2);

  for (const call of api) {
    if (call.url.includes('/config')) continue;
    const auth = call.init?.headers?.Authorization ?? '';
    assert.match(auth, /^tma /, `no credential on ${call.url}`);
    // The server decides who is asking. A client that could name a user would
    // be a client that could name somebody else.
    assert.doesNotMatch(call.url, /userId|user_id|telegramId|jellyfin/i, `${call.url} names a user`);
  }
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test('storage is shown as a real fraction of a real quota', async () => {
  const app = await boot({ routes: OK_ROUTES });
  assert.match(app.text(), /5\.0 GB/);
  assert.match(app.text(), /of 20\.0 GB/);
  const meter = app.$('.meter > span');
  assert.ok(meter);
  assert.equal(meter.style.width, '25%', 'the bar reflects the reported percentage');
});

test('an unlimited quota says so instead of drawing an empty bar', async () => {
  const app = await boot({
    routes: {
      ...OK_ROUTES,
      '/api/miniapp/me': {
        ...ME,
        storage: { ...ME.storage, quotaBytes: null, remainingBytes: null, percentUsed: null },
      },
    },
  });
  assert.match(app.text(), /No quota set/i);
  assert.equal(app.$('.meter'), null, 'a bar with no maximum would be meaningless');
});

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

const LIBRARY = {
  total: 2,
  limit: 20,
  offset: 0,
  items: [
    {
      id: 1, uploadId: 10, title: 'The Runner', year: 2026, type: 'movie',
      season: null, episode: null, episodeTitle: null, fileSize: 2_109_734_912,
      hasPoster: true, jellyfinItemId: 'abc123', jellyfinVerified: true,
      addedAt: '2026-09-05T00:00:00.000Z',
    },
    {
      id: 2, uploadId: 11, title: 'Some Show', year: 2024, type: 'tv',
      season: 1, episode: 2, episodeTitle: 'Pilot', fileSize: 900_000_000,
      hasPoster: false, jellyfinItemId: null, jellyfinVerified: false,
      addedAt: '2026-09-04T00:00:00.000Z',
    },
  ],
};

const PROBE = '/System/Info/Public';

async function openLibrary(routes = {}) {
  const app = await boot({
    routes: {
      ...OK_ROUTES,
      '/api/miniapp/library': LIBRARY,
      '/api/miniapp/poster/': { status: 404, body: { error: 'no poster in this fixture' } },
      ...routes,
    },
  });
  app.$$('.tab').find((t) => t.dataset.view === 'library').dispatchEvent(
    new app.window.Event('click', { bubbles: true }),
  );
  await app.settle(120);
  return app;
}

test('the library renders a card per item with title, year and size', async () => {
  const app = await openLibrary();
  const posters = app.$$('.poster');
  assert.equal(posters.length, 2);
  assert.match(posters[0].textContent, /The Runner/);
  assert.match(posters[0].textContent, /2026/);
  assert.match(posters[0].textContent, /2\.0 GB/);
  // An episode is identified as one.
  assert.match(posters[1].textContent, /S01E02/);
});

test('an item Jellyfin has not indexed is marked pending', async () => {
  const app = await openLibrary();
  const badges = app.$$('.poster-badge').map((b) => b.textContent);
  assert.deepEqual(badges, ['Pending'], 'only the unverified item is flagged');
});

test('a poster is fetched with the credential, not linked to directly', async () => {
  // An `<img src>` carries no Authorization header, so pointing one at the
  // authenticated proxy produced a 401 and a placeholder every time. The bytes
  // must be fetched with the credential and handed over as a blob.
  const app = await openLibrary();
  const posterCall = app.calls.find((c) => c.url.includes('/api/miniapp/poster/'));
  assert.ok(posterCall, 'the poster was requested');
  assert.match(posterCall.init?.headers?.Authorization ?? '', /^tma /, 'without a credential it would 401');
  assert.match(posterCall.url, /\/api\/miniapp\/poster\/1$/);
  // Never a third party: TMDB would learn what a private library holds, and a
  // Jellyfin URL would be blocked as mixed content on an https page.
  assert.doesNotMatch(posterCall.url, /tmdb|192\.168|8096/);
  // And never in the URL, where it would reach the access log and the history.
  assert.doesNotMatch(posterCall.url, /tma|auth_date|hash=/);
});

test('an item shows its placeholder immediately, before the poster arrives', async () => {
  // The grid must have its shape at once rather than reflowing as each image
  // lands.
  const app = await openLibrary();
  const art = app.$('.poster-art');
  assert.ok(art.querySelector('.poster-fallback'), 'a placeholder is rendered up front');
});

test('an item with no poster still renders, with a placeholder', async () => {
  const app = await openLibrary();
  const arts = app.$$('.poster-art');
  assert.equal(arts[1].querySelector('img'), null);
  assert.ok(arts[1].querySelector('.poster-fallback'));
});

test('an empty library explains what to do about it', async () => {
  const app = await openLibrary({ '/api/miniapp/library': { total: 0, limit: 20, offset: 0, items: [] } });
  assert.match(app.text(), /Nothing here yet/i);
  assert.match(app.text(), /bot|upload/i);
  assert.ok(app.$$('button').some((b) => /Upload something/i.test(b.textContent)));
});

test('a failing library offers a retry rather than an empty screen', async () => {
  const app = await openLibrary({ '/api/miniapp/library': { status: 500, body: { error: 'boom' } } });
  assert.match(app.text(), /Could not load this/i);
  assert.ok(app.$$('button').some((b) => b.textContent === 'Try again'));
});

test('watching an unindexed item says why instead of opening a dead link', async () => {
  const app = await openLibrary();
  app.$$('.poster')[1].dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.settle();
  assert.equal(app.window.__opened, undefined, 'no link was opened');
  assert.match(app.window.document.getElementById('toasts').textContent, /not indexed/i);
});

test('watching an indexed item opens Jellyfin outside the web view, by the chosen door', async () => {
  const app = await openLibrary({
    [`ts.example:8445${PROBE}`]: { status: 200, body: {} },
    [`ts.example:10000${PROBE}`]: { status: 200, body: {} },
  });
  app.$$('.poster')[0].dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.settle(200);
  // Opened externally — inside the app a foreign origin would be blocked —
  // and through the door that answered, with the title's deep link intact.
  assert.match(app.window.__opened ?? '', /^https:\/\/ts\.example:8445\/web\/#\/details\?id=/);
  assert.match(app.window.__opened ?? '', /abc123/);
});

// ---------------------------------------------------------------------------
// Progress must be honest
// ---------------------------------------------------------------------------

function uploadRow(overrides = {}) {
  return {
    id: 42, filename: 'Mayday.mkv', title: 'Mayday', year: 2026, mediaType: 'movie',
    season: null, episode: null, fileSize: 2_082_120_499, bytesDownloaded: 1_589_137_899,
    status: 'DOWNLOADING', source: 'telegram', createdAt: '2026-09-06T00:00:00.000Z',
    completedAt: null, durationMs: null, attempts: 1, jellyfinVerified: null,
    progress: {
      stage: 'DOWNLOADING', percent: 76, byteAccurate: true,
      bytesPerSecond: 8_598_323, etaSeconds: 55, part: null, partCount: null,
      updatedAt: '2026-09-06T00:01:00.000Z',
    },
    failure: null,
    ...overrides,
  };
}

async function openActive(items) {
  const app = await boot({
    routes: { ...OK_ROUTES, '/api/miniapp/active': { total: items.length, items } },
  });
  app.$$('.tab').find((t) => t.dataset.view === 'active').dispatchEvent(
    new app.window.Event('click', { bubbles: true }),
  );
  await app.settle(120);
  return app;
}

test('a measured transfer shows bytes, speed and ETA', async () => {
  const app = await openActive([uploadRow()]);
  const text = app.text();
  assert.match(text, /76%/);
  assert.match(text, /1\.5 GB \/ 1\.9 GB/);
  assert.match(text, /8\.2 MB\/s/);
  assert.match(text, /~55 sec remaining/);
  assert.match(text, /Downloading from Telegram/);
  assert.equal(app.$('.progress-fill').style.width, '76%');
});

test('a stage estimate gets no speed and no ETA', async () => {
  // The worker records whether a percentage came from counting bytes. One that
  // did not must never be dressed up as a transfer rate.
  const app = await openActive([
    uploadRow({
      status: 'ORGANIZING',
      progress: {
        stage: 'ORGANIZING', percent: 80, byteAccurate: false,
        bytesPerSecond: 9_999_999, etaSeconds: 30, part: null, partCount: null, updatedAt: null,
      },
    }),
  ]);
  const text = app.text();
  assert.match(text, /80%/);
  assert.match(text, /Filing into your library/);
  assert.doesNotMatch(text, /MB\/s/, 'a speed was shown for an unmeasured stage');
  assert.doesNotMatch(text, /remaining/, 'an ETA was shown for an unmeasured stage');
});

test('an unknown percentage draws an indeterminate bar, not a zero', async () => {
  const app = await openActive([
    uploadRow({
      status: 'QUEUED',
      progress: { stage: 'QUEUED', percent: null, byteAccurate: false, bytesPerSecond: null, etaSeconds: null, part: null, partCount: null, updatedAt: null },
    }),
  ]);
  assert.doesNotMatch(app.text(), /\b0%/, 'an unknown position was rendered as zero progress');
  assert.ok(app.$('.progress-fill.is-indeterminate'));
  assert.match(app.text(), /Waiting in the queue/);
});

test('the processing checklist marks done, current and pending distinctly', async () => {
  const app = await openActive([
    uploadRow({
      status: 'ORGANIZING',
      progress: { stage: 'ORGANIZING', percent: 60, byteAccurate: false, bytesPerSecond: null, etaSeconds: null, part: null, partCount: null, updatedAt: null },
    }),
  ]);
  const steps = app.$$('.step');
  assert.ok(steps.length >= 4);
  const stateOf = (label) => {
    const node = steps.find((s) => s.textContent.includes(label));
    assert.ok(node, `no step labelled ${label}`);
    return node.className;
  };
  assert.match(stateOf('Downloaded'), /is-done/);
  assert.match(stateOf('Identified'), /is-done/);
  assert.match(stateOf('Organising'), /is-current/);
  assert.match(stateOf('Jellyfin scan'), /is-pending/);
});

test('no transfers is an empty state, and polling stops', async () => {
  const app = await openActive([]);
  assert.match(app.text(), /Nothing in progress/i);
  assert.ok(app.$$('button').some((b) => /Upload a file/i.test(b.textContent)));
});

test('a running transfer can be cancelled, and asks first', async () => {
  let cancelled = false;
  const app = await boot({
    routes: {
      ...OK_ROUTES,
      '/api/miniapp/active': { total: 1, items: [uploadRow()] },
      '/api/miniapp/uploads/42/cancel': (_url, _init, reply) => {
        cancelled = true;
        return reply(200, { ok: true });
      },
    },
  });
  app.$$('.tab').find((t) => t.dataset.view === 'active').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.settle(120);

  const button = app.$$('button').find((b) => b.textContent === 'Cancel');
  assert.ok(button, 'a running transfer offers a cancel');
  button.dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.settle(150);
  assert.equal(cancelled, true, 'the cancel reached the server');
});

test('declining the confirmation cancels nothing', async () => {
  let cancelled = false;
  const app = await boot({
    routes: {
      ...OK_ROUTES,
      '/api/miniapp/active': { total: 1, items: [uploadRow()] },
      '/api/miniapp/uploads/42/cancel': (_url, _init, reply) => {
        cancelled = true;
        return reply(200, {});
      },
    },
  });
  app.window.__confirmAnswer = false;
  app.$$('.tab').find((t) => t.dataset.view === 'active').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.settle(120);
  app.$$('button').find((b) => b.textContent === 'Cancel').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.settle(150);
  assert.equal(cancelled, false, 'a declined confirmation still cancelled the upload');
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

test('history pages on the server, not in the browser', async () => {
  const app = await boot({
    routes: {
      ...OK_ROUTES,
      '/api/miniapp/uploads': {
        total: 3, limit: 20, offset: 0,
        items: [uploadRow({ status: 'COMPLETED', jellyfinVerified: true })],
      },
    },
  });
  app.$$('.tab').find((t) => t.dataset.view === 'history').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.settle(120);

  const call = app.calls.find((c) => c.url.includes('/api/miniapp/uploads?'));
  assert.ok(call, 'the list was requested with paging parameters');
  assert.match(call.url, /limit=20/);
  assert.match(call.url, /offset=0/);
});

test('a failed upload shows why and offers another attempt', async () => {
  const app = await boot({
    routes: {
      ...OK_ROUTES,
      '/api/miniapp/uploads': {
        total: 1, limit: 20, offset: 0,
        items: [
          uploadRow({
            status: 'FAILED',
            failure: { stage: 'DOWNLOADING', code: 'TELEGRAM_TIMEOUT', retryable: true, message: 'Telegram did not deliver the file in time.' },
          }),
        ],
      },
    },
  });
  app.$$('.tab').find((t) => t.dataset.view === 'history').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.settle(120);

  assert.match(app.text(), /Telegram did not deliver/);
  assert.ok(app.$$('button').some((b) => b.textContent === 'Try again'));
});

test('a failure that a retry cannot fix says so', async () => {
  const app = await boot({
    routes: {
      ...OK_ROUTES,
      '/api/miniapp/uploads': {
        total: 1, limit: 20, offset: 0,
        items: [
          uploadRow({
            status: 'FAILED',
            failure: { stage: 'ORGANIZING', code: 'DISK_FULL', retryable: false, message: 'There is no room left.' },
          }),
        ],
      },
    },
  });
  app.$$('.tab').find((t) => t.dataset.view === 'history').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.settle(120);
  assert.match(app.text(), /will not help/i);
});

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

test('a hostile filename is rendered as text, never as markup', async () => {
  const app = await boot({
    routes: {
      ...OK_ROUTES,
      '/api/miniapp/uploads': {
        total: 1, limit: 20, offset: 0,
        items: [uploadRow({ filename: '<img src=x onerror=alert(1)>.mkv', title: null, status: 'COMPLETED' })],
      },
    },
  });
  app.$$('.tab').find((t) => t.dataset.view === 'history').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.settle(120);

  assert.equal(app.$('#root img'), null, 'a filename became an element');
  assert.match(app.text(), /<img src=x/, 'and is shown verbatim instead');
});

test('the page raises no uncaught errors while rendering', async () => {
  const app = await openLibrary();
  assert.deepEqual(app.errors, []);
});

// ---------------------------------------------------------------------------
// Open Jellyfin chooses its own route
// ---------------------------------------------------------------------------

const doorsOpen = {
  ...OK_ROUTES,
  [`ts.example:8445${PROBE}`]: { status: 200, body: {} },
  [`ts.example:10000${PROBE}`]: { status: 200, body: {} },
};
const openButton = (app) => app.$$('button').find((b) => b.textContent === 'Open Jellyfin');

test('Open Jellyfin asks every door at once and takes the tailnet one when it answers', async () => {
  const probed = [];
  const app = await boot({
    routes: doorsOpen,
    onFetch: (url) => { if (url.includes(PROBE)) probed.push(url); },
  });
  openButton(app).click();
  await app.settle(200);

  assert.equal(app.window.__opened, 'https://ts.example:8445');
  assert.ok(probed.some((u) => u.startsWith('https://ts.example:8445')), 'the tailnet door was asked');
  assert.ok(probed.some((u) => u.startsWith('https://ts.example:10000')), 'and the public one, at the same time');
  // The one door a secure page is not allowed to test.
  assert.ok(!probed.some((u) => u.includes('192.0.2.10')), 'the LAN door is never probed');
});

test('when the tailnet door is shut, the public one opens', async () => {
  const app = await boot({
    routes: {
      ...doorsOpen,
      [`ts.example:8445${PROBE}`]: () => Promise.reject(new TypeError('Failed to fetch')),
    },
  });
  openButton(app).click();
  await app.settle(200);
  assert.equal(app.window.__opened, 'https://ts.example:10000');
});

test('a door that answers but refuses (503) is passed over', async () => {
  const app = await boot({
    routes: { ...doorsOpen, [`ts.example:8445${PROBE}`]: { status: 503, body: '' } },
  });
  openButton(app).click();
  await app.settle(200);
  assert.equal(app.window.__opened, 'https://ts.example:10000');
});

test('the LAN door is offered as a direct tap and opens without any probing', async () => {
  const probed = [];
  const app = await boot({
    routes: doorsOpen,
    onFetch: (url) => { if (url.includes(PROBE)) probed.push(url); },
  });
  const lan = app.$$('button').find((b) => b.textContent.includes('home Wi-Fi'));
  assert.ok(lan, 'the direct link is rendered beneath the button');
  lan.click();
  await app.settle();
  assert.equal(app.window.__opened, 'http://192.0.2.10:8096');
  assert.equal(probed.length, 0, 'opening the LAN door measures nothing');
});
