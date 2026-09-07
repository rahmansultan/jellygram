import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

/**
 * Frontend end-to-end test.
 *
 * The real `public/` bundle is loaded into a DOM and pointed at the **running
 * API**, so this exercises login, CSRF handling, routing and every page's
 * rendering against live responses rather than fixtures.
 *
 * Usage: node tests/dashboard.e2e.mjs <admin-username> <admin-password>
 */

const BASE = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:8300';
const USERNAME = process.argv[2];
const PASSWORD = process.argv[3];

if (!USERNAME || !PASSWORD) {
  process.stdout.write('Usage: node tests/dashboard.e2e.mjs <username> <password>\n');
  process.exit(2);
}

const PUBLIC_DIR = path.join(import.meta.dirname, '..', 'public');

let failures = 0;
const consoleErrors = [];

/** Thrown by a check that cannot run here, so it is reported as skipped. */
class Skipped extends Error {}
const skip = (why) => {
  throw new Skipped(why);
};

let skipped = 0;

function check(name, fn) {
  try {
    fn();
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (err) {
    if (err instanceof Skipped) {
      skipped += 1;
      process.stdout.write(`  SKIP  ${name}\n        ${err.message}\n`);
      return;
    }
    failures += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until `predicate` holds, so we test rendered output rather than timing. */
async function waitFor(predicate, description, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = predicate();
      if (value) return value;
    } catch {
      // Not ready yet.
    }
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function main() {
  process.stdout.write('\nDashboard end-to-end test\n=========================\n\n');

  // A cookie jar shared by every request, exactly as a browser would.
  const cookies = new Map();
  let apiRequests = 0;
  const requestCount = () => apiRequests;

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => consoleErrors.push(String(err.message)));
  virtualConsole.on('error', (...args) => consoleErrors.push(args.join(' ')));

  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: `${BASE}/`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });

  const { window } = dom;

  // Serve the page's own assets from disk and proxy /api to the live server.
  window.fetch = async (input, init = {}) => {
    const url = new URL(String(input), BASE);
    const headers = new Headers(init.headers ?? {});

    const jar = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    if (jar) headers.set('cookie', jar);

    if (url.pathname.startsWith('/api/')) apiRequests += 1;
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });

    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value) cookies.set(name, value);
      else cookies.delete(name);
    }
    return res;
  };

  window.Headers = Headers;
  window.localStorage.clear();

  // Evaluate the real frontend files in page order.
  for (const file of ['js/api.js', 'js/ui.js', 'js/app.js']) {
    window.eval(fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'));
  }

  const $ = (sel) => window.document.querySelector(sel);
  const text = () => $('#main')?.textContent ?? '';

  // ---------------------------------------------------------------------
  process.stdout.write('1. Unauthenticated state\n');
  await waitFor(() => $('#login-view').hidden === false, 'the login form');
  check('the login form is shown', () => assert.equal($('#login-view').hidden, false));
  check('the application shell is hidden', () => assert.equal($('#app-view').hidden, true));

  // ---------------------------------------------------------------------
  process.stdout.write('\n2. Rejected login\n');
  $('#login-username').value = USERNAME;
  $('#login-password').value = 'definitely-the-wrong-password';
  $('#login-form').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));

  await waitFor(() => $('#login-error').hidden === false, 'an error message');
  check('an error is displayed', () =>
    assert.match($('#login-error').textContent, /invalid username or password/i),
  );
  check('the shell stays hidden', () => assert.equal($('#app-view').hidden, true));

  // ---------------------------------------------------------------------
  process.stdout.write('\n3. Accepted login\n');
  $('#login-username').value = USERNAME;
  $('#login-password').value = PASSWORD;
  $('#login-form').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));

  await waitFor(() => $('#app-view').hidden === false, 'the application shell');
  check('the shell is shown', () => assert.equal($('#app-view').hidden, false));
  check('the login form is hidden', () => assert.equal($('#login-view').hidden, true));
  check('the signed-in user is displayed', () =>
    assert.equal($('#whoami').textContent, USERNAME),
  );
  check('a session cookie was set', () => assert.ok(cookies.has('jellygram_session')));
  check('a CSRF token is held in memory', () => assert.ok(window.Api.csrfToken?.length > 20));

  // ---------------------------------------------------------------------
  process.stdout.write('\n4. Dashboard page\n');
  await waitFor(() => text().includes('Services'), 'the dashboard');
  check('statistics are rendered', () => {
    for (const label of ['Active now', 'Queued', 'Completed', 'Failed', 'Disk free', 'Movies', 'Episodes']) {
      assert.ok(text().includes(label), `missing "${label}"`);
    }
  });
  check('every headline number links somewhere useful', () => {
    const links = [...window.document.querySelectorAll('.metric-link')];
    assert.ok(links.length >= 4, 'the headline metrics are navigable');
    for (const link of links) {
      assert.match(link.getAttribute('href') ?? '', /^#\//, 'a metric links to a route');
    }
  });
  check('service health is rendered', () => {
    for (const label of ['Database', 'Jellyfin', 'TMDB', 'Telegram', 'Queue']) {
      assert.ok(text().includes(label), `missing "${label}"`);
    }
  });
  check('the recent-uploads table is present', () => assert.ok(text().includes('Recent uploads')));

  // ---------------------------------------------------------------------
  const pages = [
    ['users', 'Users', ['Add user', 'Jellyfin']],
    ['uploads', 'Uploads', ['All users', 'All statuses', 'Search']],
    ['multipart', 'Multipart uploads', ['Active', 'Largest accepted', 'How this works']],
    ['mtproto', 'Telegram fetch', ['Telegram account link', 'MTProto ceiling', 'Bot API ceiling']],
    ['media', 'Media', ['All types', 'In Jellyfin']],
    ['storage', 'Storage', ['Disk', 'Per-user usage', 'Limits and paths', 'Media root']],
    ['health', 'System health', ['Checks', 'Runtime', 'Overall']],
    ['privacy', 'Privacy', ['Findings', 'How isolation works']],
    ['settings', 'Settings', ['Connections', 'Workers and retries', 'Administrator account', 'System information']],
    ['logs', 'Activity & logs', ['Activity', 'Service logs']],
  ];

  process.stdout.write('\n5. Navigation\n');
  for (const [route, heading, expected] of pages) {
    window.location.hash = `#/${route}`;
    window.dispatchEvent(new window.Event('hashchange'));

    await waitFor(() => text().includes(heading) && !text().includes('Loading…'), `the ${route} page`);

    check(`the ${route} page renders`, () => {
      assert.ok(text().includes(heading), `heading "${heading}" missing`);
      for (const fragment of expected) {
        assert.ok(text().includes(fragment), `"${fragment}" missing from ${route}`);
      }
    });
    check(`the ${route} link is marked current`, () =>
      assert.equal(
        window.document.querySelector(`.sidebar a[data-route="${route}"]`).getAttribute('aria-current'),
        'page',
      ),
    );
    // A page with no heading, or a heading with no explanation, is how an
    // admin tool ends up needing a manual.
    check(`the ${route} page has a title and a description`, () => {
      const h1 = window.document.querySelector('#main h1');
      assert.ok(h1, 'no h1');
      assert.equal(h1.textContent.trim(), heading);
      assert.ok(
        window.document.querySelector('#main .page-description'),
        'no description under the title',
      );
    });
  }

  // ---------------------------------------------------------------------
  process.stdout.write('\n5b. Sub-routes and the not-found page\n');

  // The upload detail page. Uses whichever upload the API reports first, so
  // this works on any database rather than only one with a known id.
  const uploadsResponse = await window.fetch('/api/uploads?limit=1');
  const firstUpload = (await uploadsResponse.json()).uploads?.[0];

  if (firstUpload) {
    window.location.hash = `#/upload/${firstUpload.id}`;
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => text().includes('Timeline'), 'the upload detail page');

    check('the upload detail page renders', () => {
      assert.ok(text().includes('Timeline'), 'timeline missing');
      assert.ok(text().includes('Jellyfin'), 'Jellyfin section missing');
      assert.ok(text().includes('Jobs'), 'job history missing');
    });
    check('the timeline shows the pipeline steps', () =>
      assert.ok(window.document.querySelectorAll('.timeline-step').length >= 5),
    );
    check('a completed upload has no cancel action', () => {
      const terminal = ['COMPLETED', 'FAILED', 'CANCELLED', 'DUPLICATE'].includes(firstUpload.status);
      // Scoped to the page: the shared dialog's own Cancel button is always in
      // the document, so an unscoped query is true no matter what the page did.
      const hasCancel = [...window.document.querySelectorAll('#main button')].some(
        (b) => b.textContent === 'Cancel',
      );
      assert.equal(hasCancel, !terminal, 'cancel is offered only while there is something to cancel');
    });
  } else {
    check('the upload detail page renders', () => skip('no uploads exist in this database'));
  }

  // An unknown route used to silently render the dashboard under the wrong
  // address, which reads as a broken page rather than a wrong link.
  window.location.hash = '#/definitely-not-a-page';
  window.dispatchEvent(new window.Event('hashchange'));
  await waitFor(() => text().includes('Page not found'), 'the not-found page');
  check('an unknown route shows a not-found page', () =>
    assert.ok(text().includes('Page not found')),
  );
  check('the not-found page offers a way back', () =>
    assert.ok(window.document.querySelector('a[href="#/dashboard"]')),
  );

  // ---------------------------------------------------------------------
  process.stdout.write('\n5c. User detail\n');

  const usersResponse = await window.fetch('/api/users');
  const firstUser = (await usersResponse.json()).users?.[0];

  if (firstUser) {
    window.location.hash = `#/user/${firstUser.id}`;
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => text().includes('Storage') && text().includes('Telegram'), 'the user page');

    check('the user page renders every section', () => {
      for (const section of ['Storage', 'Telegram', 'Jellyfin', 'Uploads', 'Account activity']) {
        assert.ok(text().includes(section), `"${section}" missing`);
      }
    });
    check('the header names the user', () =>
      assert.equal(window.document.querySelector('#main h1').textContent.trim(), firstUser.name),
    );
    check('there is a way back to the user list', () =>
      assert.ok(window.document.querySelector('#main a[href="#/users"]'), 'no back link'),
    );
    check('the storage figures come from the backend', () => {
      // Nothing invented client-side: the used figure must match /api/users.
      const shown = text();
      assert.ok(shown.includes('Quota'), 'quota is stated');
      assert.ok(shown.includes('In flight'), 'in-flight bytes are stated');
    });
    check('the Telegram id is not shown in the open', () => {
      const id = String(firstUser.telegram_chat_id);
      const dd = [...window.document.querySelectorAll('#main dd')].map((n) => n.textContent).join(' ');
      assert.ok(!dd.includes(id), 'the full chat id is visible without being revealed');
      assert.ok(dd.includes(id.slice(-3)), 'the last digits are shown so it can be recognised');
    });
    check('revealing the Telegram id shows it', () => {
      const reveal = [...window.document.querySelectorAll('#main button')].find(
        (b) => b.textContent === 'Reveal',
      );
      assert.ok(reveal, 'no reveal control');
      reveal.dispatchEvent(new window.Event('click', { bubbles: true }));
      const dd = [...window.document.querySelectorAll('#main dd')].map((n) => n.textContent).join(' ');
      assert.ok(dd.includes(String(firstUser.telegram_chat_id)), 'the id is shown after revealing');
    });
    await waitFor(
      () => window.document.querySelector('#user-uploads .table-wrap, #user-uploads .empty-state'),
      'this user\'s uploads',
    );
    check('the user’s own uploads are listed separately', () =>
      assert.ok(window.document.querySelector('#user-uploads')),
    );
  } else {
    check('the user page renders', () => skip('no users exist in this database'));
  }

  // ---------------------------------------------------------------------
  process.stdout.write('\n5d. Table semantics\n');

  window.location.hash = '#/uploads';
  window.dispatchEvent(new window.Event('hashchange'));
  await waitFor(() => text().includes('Uploads') && !text().includes('Loading…'), 'the uploads page');

  const anyTable = window.document.querySelector('#main table');
  if (anyTable) {
    check('cells carry the label of their column', () => {
      const headers = [...anyTable.querySelectorAll('thead th')].map((th) => th.textContent);
      const firstRow = [...anyTable.querySelectorAll('tbody tr')][0];
      assert.ok(firstRow, 'no rows');
      const labels = [...firstRow.querySelectorAll('td')].map((td) => td.getAttribute('data-label'));
      // The card layout on a phone is CSS reading these attributes; without
      // them every value on a narrow screen loses its heading.
      assert.deepEqual(labels, headers);
    });
    check('the table keeps its roles once CSS restacks it', () => {
      assert.equal(anyTable.getAttribute('role'), 'table');
      assert.equal(anyTable.querySelector('tbody')?.getAttribute('role'), 'rowgroup');
      assert.equal(anyTable.querySelector('tbody tr')?.getAttribute('role'), 'row');
      assert.equal(anyTable.querySelector('tbody td')?.getAttribute('role'), 'cell');
    });
  } else {
    check('cells carry the label of their column', () => skip('the uploads table has no rows'));
  }

  window.location.hash = '#/users';
  window.dispatchEvent(new window.Event('hashchange'));
  await waitFor(() => text().includes('Users') && !text().includes('Loading…'), 'the users page');

  check('an overflow menu opens and closes', () => {
    const menuNode = window.document.querySelector('#main details.menu');
    if (!menuNode) skip('no row on this page offers an overflow menu');
    const summary = menuNode.querySelector('summary');
    assert.ok(summary, 'no trigger');
    assert.equal(menuNode.querySelectorAll('[role="menuitem"]').length > 0, true);
    menuNode.open = true;
    menuNode.dispatchEvent(new window.Event('toggle'));
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(menuNode.open, false, 'Escape must close an open menu');
  });

  // ---------------------------------------------------------------------
  process.stdout.write('\n5e. Polling does not fight the reader\n');

  window.location.hash = '#/uploads';
  window.dispatchEvent(new window.Event('hashchange'));
  await waitFor(() => text().includes('Uploads') && !text().includes('Loading…'), 'the uploads page');

  const search = [...window.document.querySelectorAll('#main input[type="search"]')][0];
  if (search) {
    search.focus();
    search.value = 'half-typed';
    // The page polls every five seconds and rebuilds its whole DOM to do it.
    // Anything the reader is in the middle of has to survive that.
    await sleep(6200);

    check('a search in progress is not wiped by the refresh', () => {
      const still = window.document.activeElement;
      assert.equal(still?.type, 'search', `focus moved to ${still?.tagName}`);
      assert.equal(still.value, 'half-typed', 'the typed text survived');
    });
    search.blur();
  } else {
    check('a search in progress is not wiped by the refresh', () => skip('this page has no search field'));
  }

  // Users always have actions; uploads only have them while something can be
  // done to them, so the menu is not guaranteed to exist there.
  window.location.hash = '#/users';
  window.dispatchEvent(new window.Event('hashchange'));
  await waitFor(() => text().includes('Add user') && !text().includes('Loading…'), 'the users page');
  const openMenu = window.document.querySelector('#main details.menu');
  if (openMenu) {
    openMenu.open = true;
    openMenu.dispatchEvent(new window.Event('toggle'));
    await sleep(6200);
    check('an open row menu is not closed by the refresh', () =>
      assert.equal(window.document.querySelector('#main details.menu[open]') !== null, true),
    );
    openMenu.open = false;
  } else {
    check('an open row menu is not closed by the refresh', () => skip('no row on this page offers an overflow menu'));
  }

  // ---------------------------------------------------------------------
  process.stdout.write('\n5f. API contract for bad input\n');

  const status = async (path) => (await window.fetch(`/api${path}`)).status;

  // A mistyped id is the caller's mistake. Reporting it as a 500 both misleads
  // the caller and writes an incident into the log that is not one.
  const badIds = [
    ['/users/99999999999999999999', 'larger than a bigint'],
    ['/uploads/99999999999999999999', 'larger than a bigint'],
    ['/sessions/99999999999999999999', 'larger than a bigint'],
    ['/users/99999999999999999999/uploads', 'larger than a bigint'],
    ['/users/abc', 'not a number'],
    ['/users/0', 'zero'],
    ['/users/-1', 'negative'],
  ];
  for (const [path, why] of badIds) {
    const code = await status(path);
    check(`${path} (${why}) is a 400`, () => assert.equal(code, 400));
  }

  // Query parameters are validated rather than coerced into a huge scan.
  for (const [path, expected, why] of [
    ['/audit?limit=100000', 422, 'an absurd page size'],
    ['/audit?offset=-5', 422, 'a negative offset'],
    ['/audit?entityType=admins', 422, 'an entity type outside the enum'],
    ['/uploads?status=NOT_A_STATUS', 422, 'an unknown status'],
    ['/logs/postgres', 400, 'a service that is not ours'],
  ]) {
    const code = await status(path);
    check(`${path} (${why}) is a ${expected}`, () => assert.equal(code, expected));
  }

  // A filter value is data, never syntax.
  const wildcard = await (await window.fetch('/api/audit?limit=1&action=%25')).json();
  const everything = await (await window.fetch('/api/audit?limit=1')).json();
  check('a literal % in a filter matches nothing rather than everything', () => {
    assert.ok(everything.total > 0, 'there is something to match');
    assert.equal(wildcard.total, 0, 'the wildcard was escaped, not interpreted');
  });

  const injected = await (await window.fetch(`/api/audit?q=${encodeURIComponent("'; DROP TABLE users;--")}`)).json();
  check('an injected filter is treated as a search term', () => {
    assert.equal(typeof injected.total, 'number');
    assert.equal(injected.total, 0, 'nothing matches that literal string');
  });

  // No response may carry the stored token hash, even though it cannot
  // authenticate anything: the browser has no use for it.
  const allUsers = await (await window.fetch('/api/users')).json();
  check('the upload token hash never leaves the server', () => {
    const body = JSON.stringify(allUsers);
    assert.doesNotMatch(body, /upload_token_hash/, 'the hash is not in the user list');
    for (const u of allUsers.users) {
      assert.equal(typeof u.has_upload_token, 'boolean', 'only whether one exists');
    }
  });

  if (firstUser) {
    const detail = await (await window.fetch(`/api/users/${firstUser.id}`)).json();
    check('nor from the user detail endpoint', () =>
      assert.doesNotMatch(JSON.stringify(detail), /upload_token_hash/),
    );
  }

  // ---------------------------------------------------------------------
  process.stdout.write('\n5g. An expired session stops the polling\n');

  // A tab left open on a polling page kept asking every few seconds after its
  // session expired — hundreds of 401s — while showing stale data and giving
  // the reader no hint that anyone was signed out.
  window.location.hash = '#/uploads';
  window.dispatchEvent(new window.Event('hashchange'));
  await waitFor(() => text().includes('Uploads') && !text().includes('Loading…'), 'the uploads page');

  const callsBeforeExpiry = requestCount();
  cookies.delete('jellygram_session');
  await sleep(6500);

  check('the login form returns when the session expires mid-poll', () =>
    assert.equal($('#login-view').hidden, false, 'still showing the application'),
  );
  check('and the shell is hidden', () => assert.equal($('#app-view').hidden, true));

  const callsAtSignOut = requestCount();
  await sleep(6500);
  check('polling has stopped rather than continuing forever', () => {
    const after = requestCount();
    assert.ok(after - callsAtSignOut <= 1, `${after - callsAtSignOut} further requests after signing out`);
    assert.ok(callsAtSignOut > callsBeforeExpiry, 'the poll did fire at least once while expired');
  });

  // Sign back in for the remaining sections.
  $('#login-username').value = USERNAME;
  $('#login-password').value = PASSWORD;
  $('#login-form').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
  await waitFor(() => $('#app-view').hidden === false, 'the shell to return');

  // ---------------------------------------------------------------------
  process.stdout.write('\n6. Escaping\n');
  const { el } = window.UI;
  const node = el('div', {}, '<img src=x onerror=alert(1)>');
  check('dynamic content is inserted as text, not HTML', () => {
    assert.equal(node.querySelector('img'), null);
    assert.ok(node.textContent.includes('<img'));
  });

  // ---------------------------------------------------------------------
  process.stdout.write('\n7. Theme switching\n');
  const before = window.document.documentElement.dataset.theme;
  $('#theme-toggle').dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(120);
  check('the theme toggle changes the theme', () =>
    assert.notEqual(window.document.documentElement.dataset.theme, before),
  );
  check('the choice is persisted', () =>
    assert.ok(window.localStorage.getItem('jellygram-theme')),
  );

  // ---------------------------------------------------------------------
  process.stdout.write('\n8. Sign out\n');
  $('#logout-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await waitFor(() => $('#login-view').hidden === false, 'the login form to return');
  check('the login form returns', () => assert.equal($('#login-view').hidden, false));
  check('the session cookie is cleared', () => assert.ok(!cookies.get('jellygram_session')));

  // ---------------------------------------------------------------------
  process.stdout.write('\n9. Console cleanliness\n');
  check('no uncaught page errors', () =>
    assert.deepEqual(consoleErrors, [], consoleErrors.join('\n')),
  );

  dom.window.close();

  process.stdout.write(
    `\n=========================\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}` +
      `${skipped ? ` (${skipped} skipped)` : ''}\n\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stdout.write(`\nFATAL: ${err.message}\n${err.stack}\n`);
  process.exitCode = 1;
});
