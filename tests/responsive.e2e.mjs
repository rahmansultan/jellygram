import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Layout verification in a real browser.
 *
 * The CSS contract test pins the rules; this measures what they actually
 * produce. Chrome renders every page at each width the product claims to
 * support and reports the elements that are wider than the screen — the one
 * defect a stylesheet review reliably misses, because it emerges from the
 * interaction of a grid, a long filename and a padding, not from any single
 * declaration.
 *
 * Usage: node tests/responsive.e2e.mjs <admin-username> <admin-password>
 */

const BASE = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:8300';
const USERNAME = process.argv[2];
const PASSWORD = process.argv[3];
const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';

if (!USERNAME || !PASSWORD) {
  process.stdout.write('Usage: node tests/responsive.e2e.mjs <username> <password>\n');
  process.exit(2);
}

/** The widths that matter, and why each one is in the list. */
const VIEWPORTS = [
  { width: 320, height: 640, label: '320  smallest phone still in use' },
  { width: 375, height: 667, label: '375  iPhone SE / mini' },
  { width: 390, height: 844, label: '390  iPhone 14' },
  { width: 430, height: 932, label: '430  iPhone Pro Max' },
  { width: 768, height: 1024, label: '768  tablet portrait' },
  { width: 1024, height: 768, label: '1024 tablet landscape' },
  { width: 1366, height: 768, label: '1366 laptop' },
];

const ROUTES = [
  'dashboard',
  'health',
  'uploads',
  'multipart',
  'mtproto',
  'media',
  'storage',
  'users',
  'privacy',
  'settings',
  'logs',
];

let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, fn) {
  try {
    fn();
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// A minimal CDP client. Node 22 has WebSocket built in; nothing else is needed.
// ---------------------------------------------------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      const resolver = this.pending.get(msg.id);
      if (!resolver) return;
      this.pending.delete(msg.id);
      if (msg.error) resolver.reject(new Error(msg.error.message));
      else resolver.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 20_000);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed');
    }
    return result.result.value;
  }
}

/**
 * Every element wider than the viewport, with enough identity to find it.
 *
 * Only the widest offender per selector is reported: one bad grid produces a
 * hundred oversized children and a list of them says nothing extra.
 */
const OVERFLOW_PROBE = `(() => {
  const width = document.documentElement.clientWidth;
  const seen = new Map();
  for (const node of document.querySelectorAll('#app-view *')) {
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    // An element allowed to scroll inside itself is not an overflow.
    let scrollable = false;
    for (let p = node.parentElement; p; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (style.overflowX === 'auto' || style.overflowX === 'scroll') { scrollable = true; break; }
    }
    if (scrollable) continue;
    const overhang = Math.round(rect.right - width);
    if (overhang <= 1 && Math.round(rect.width) <= width + 1) continue;
    const key = node.tagName.toLowerCase() + (node.className && typeof node.className === 'string'
      ? '.' + node.className.trim().split(/\\s+/).join('.')
      : '');
    const previous = seen.get(key);
    if (!previous || overhang > previous.overhang) {
      seen.set(key, { key, overhang, width: Math.round(rect.width) });
    }
  }
  return {
    documentOverflow: Math.round(document.documentElement.scrollWidth - width),
    viewport: width,
    offenders: [...seen.values()].sort((a, b) => b.overhang - a.overhang).slice(0, 6),
  };
})()`;

/** Interactive controls smaller than a finger. */
const TOUCH_PROBE = `(() => {
  const small = [];
  for (const node of document.querySelectorAll('#app-view button, #app-view a.btn, #app-view summary, #app-view .sidebar a, #app-view input, #app-view select')) {
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.height < 30) {
      small.push({
        tag: node.tagName.toLowerCase(),
        label: (node.textContent || node.getAttribute('aria-label') || '').trim().slice(0, 30),
        height: Math.round(rect.height),
      });
    }
  }
  return small.slice(0, 6);
})()`;

async function main() {
  process.stdout.write('\nResponsive layout test (real browser)\n=====================================\n\n');

  // Sign in with plain fetch and hand the session cookie to the browser, so
  // the browser never sees the password.
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  assert.equal(login.status, 200, `login failed with ${login.status}`);
  const setCookie = login.headers.getSetCookie().find((c) => c.startsWith('jellygram_session='));
  assert.ok(setCookie, 'no session cookie returned');
  const sessionValue = setCookie.split(';')[0].split('=').slice(1).join('=');

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jellygram-chrome-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not report a debugging port')), 20_000);
    chrome.stderr.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = /ws:\/\/[^\s]+/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    chrome.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited with ${code}`));
    });
  });

  /**
   * Stop Chrome, then remove its profile.
   *
   * Removing it immediately after the signal raced Chrome's own shutdown
   * writes: `rmSync` walked the tree, Chrome recreated a lock file behind it,
   * and the whole run failed with `ENOTEMPTY` *after every check had passed* —
   * intermittently, and only on a machine slow enough to lose the race.
   *
   * So: wait for the process to actually exit, and treat a leftover temporary
   * directory as the triviality it is rather than as a test failure.
   */
  const cleanup = async () => {
    if (chrome.exitCode === null) {
      const exited = new Promise((resolve) => chrome.once('exit', resolve));
      try {
        chrome.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      const forced = setTimeout(() => {
        try {
          chrome.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 5_000);
      forced.unref();
      await exited;
      clearTimeout(forced);
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* a profile left in the system temp directory is not a failure */
    }
  };

  try {
    // Attach to a page target rather than the browser endpoint.
    const targets = await (await fetch(wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*/, '/json/list'))).json();
    const page = targets.find((t) => t.type === 'page');
    assert.ok(page, 'no page target');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('could not attach to Chrome')), { once: true });
    });
    const cdp = new Cdp(ws);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCookie', {
      name: 'jellygram_session',
      value: sessionValue,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
    });

    for (const viewport of VIEWPORTS) {
      process.stdout.write(`\n${viewport.label}\n`);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.width <= 768,
      });

      const problems = [];
      for (const route of ROUTES) {
        await cdp.send('Page.navigate', { url: `${BASE}/#/${route}` });
        // The shell boots, authenticates, then renders; wait for the page to
        // settle rather than for a fixed delay.
        await cdp.evaluate(`new Promise((resolve) => {
          const deadline = Date.now() + 12000;
          const tick = () => {
            const main = document.getElementById('main');
            const ready = main && main.querySelector('h1') && !main.querySelector('.loading');
            if (ready || Date.now() > deadline) return resolve(ready ? 'ready' : 'timeout');
            setTimeout(tick, 120);
          };
          tick();
        })`);
        await sleep(120);

        const report = await cdp.evaluate(OVERFLOW_PROBE);
        if (report.documentOverflow > 1 || report.offenders.length) {
          problems.push({ route, ...report });
        }
      }

      check(`nothing overflows ${viewport.width}px`, () => {
        assert.deepEqual(
          problems.map((p) => `${p.route}: +${p.documentOverflow}px ${p.offenders.map((o) => o.key).join(', ')}`),
          [],
        );
      });

      if (viewport.width >= 1024) {
        const reach = [];
        for (const route of ['uploads', 'users', 'media', 'multipart', 'mtproto']) {
          await cdp.send('Page.navigate', { url: `${BASE}/#/${route}` });
          await cdp.evaluate(`new Promise((resolve) => {
            const deadline = Date.now() + 12000;
            const tick = () => {
              const main = document.getElementById('main');
              (main && main.querySelector('h1') && !main.querySelector('.loading')) || Date.now() > deadline
                ? resolve(1)
                : setTimeout(tick, 120);
            };
            tick();
          })`);
          const hidden = await cdp.evaluate(`(() => {
            const wrap = document.querySelector('#main .table-wrap');
            if (!wrap) return null;
            const cell = document.querySelector('#main tbody td:last-child');
            if (!cell) return null;
            const box = wrap.getBoundingClientRect();
            const action = cell.getBoundingClientRect();
            return action.right > box.right + 1 ? Math.round(action.right - box.right) : 0;
          })()`);
          if (hidden) reach.push(`${route}: actions ${hidden}px past the edge`);
        }
        check(`the actions column is reachable without scrolling at ${viewport.width}px`, () => {
          assert.deepEqual(reach, [], 'a table must not hide its own actions behind a horizontal scroll');
        });
      }

      if (viewport.width <= 430) {
        await cdp.send('Page.navigate', { url: `${BASE}/#/uploads` });
        await sleep(1200);
        const small = await cdp.evaluate(TOUCH_PROBE);
        check(`controls are tappable at ${viewport.width}px`, () => {
          assert.deepEqual(small, [], 'every control is at least 30px tall');
        });

        const cards = await cdp.evaluate(`(() => {
          const row = document.querySelector('#main tbody tr');
          if (!row) return { skipped: true };
          const cell = row.querySelector('td');
          return {
            skipped: false,
            rowDisplay: getComputedStyle(row).display,
            headerHidden: getComputedStyle(document.querySelector('#main thead')).display,
            labelShown: getComputedStyle(cell, '::before').content,
          };
        })()`);
        check(`the uploads table is a card stack at ${viewport.width}px`, () => {
          if (cards.skipped) return;
          assert.equal(cards.rowDisplay, 'block', 'rows stack');
          assert.equal(cards.headerHidden, 'none', 'the header row is hidden');
          assert.notEqual(cards.labelShown, 'none', 'each cell prints its column label');
        });
      }
    }

    // --- Telegram Mini App -------------------------------------------------
    //
    // A separate bundle at /app with its own layout, so it gets its own sweep.
    // It is measured *unauthenticated*: the boot screen is what a stranger
    // sees, and it must be readable rather than a blank panel. The signed-in
    // views are covered by the jsdom suite, which can hold a credential.
    process.stdout.write('\nTelegram Mini App layout\n');
    for (const width of [320, 375, 390, 430]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 780,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await cdp.send('Page.navigate', { url: `${BASE}/app/` });
      // Waited for rather than slept through: the first navigation is a cold
      // load and a fixed delay measured the delay, not the layout.
      await cdp.evaluate(`new Promise((resolve) => {
        const deadline = Date.now() + 12000;
        const tick = () => {
          const root = document.getElementById('root');
          const ready = root && root.textContent.trim().length > 0 && !root.querySelector('#boot');
          if (ready || Date.now() > deadline) return resolve(ready ? 'ready' : 'timeout');
          setTimeout(tick, 120);
        };
        tick();
      })`);
      await sleep(200);

      const report = await cdp.evaluate(`(() => {
        const w = document.documentElement.clientWidth;
        const offenders = [];
        for (const node of document.querySelectorAll('body *')) {
          const r = node.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (Math.round(r.right) > w + 1 || Math.round(r.width) > w + 1) {
            offenders.push((node.tagName + '.' + (typeof node.className === 'string' ? node.className : '')).slice(0, 60));
          }
        }
        const small = [];
        for (const node of document.querySelectorAll('button, a.btn, .tab')) {
          const r = node.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.height < 30) small.push(node.textContent.trim().slice(0, 20) + ':' + Math.round(r.height));
        }
        return {
          documentOverflow: Math.round(document.documentElement.scrollWidth - w),
          offenders: [...new Set(offenders)].slice(0, 5),
          small: small.slice(0, 5),
          rendered: (document.getElementById('root')?.textContent ?? '').trim().length > 0,
        };
      })()`);

      check(`the mini app fits ${width}px`, () => {
        assert.equal(report.documentOverflow <= 1, true, `overflows by ${report.documentOverflow}px`);
        assert.deepEqual(report.offenders, []);
      });
      check(`the mini app renders something at ${width}px`, () =>
        assert.equal(report.rendered, true, 'the panel was blank'),
      );
      check(`mini app controls are tappable at ${width}px`, () => assert.deepEqual(report.small, []));
    }

    // Telegram frames the app on Desktop and Web; the dashboard must stay
    // unframeable. This is the one header that decides both.
    process.stdout.write('\nFraming policy\n');
    const framing = await cdp.evaluate(`(async () => {
      const read = async (path) => {
        const res = await fetch(path, { method: 'GET' });
        return res.headers.get('content-security-policy') ?? '';
      };
      return { app: await read('/app/'), dashboard: await read('/') };
    })()`);

    check('the mini app may be framed by Telegram', () => {
      assert.match(framing.app, /frame-ancestors[^;]*telegram\.org/);
    });
    check('the dashboard may still not be framed at all', () => {
      assert.match(framing.dashboard, /frame-ancestors 'none'/);
    });

    // The drawer is the only navigation on a phone; if it does not open there
    // is no way to reach any other page.
    process.stdout.write('\nNavigation drawer at 375px\n');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 667,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdp.send('Page.navigate', { url: `${BASE}/#/dashboard` });
    await sleep(1500);

    // Driven entirely inside the page, with the wait on the browser's side of
    // the connection: reading state across three separate round trips was
    // measuring the round trips as much as the drawer.
    const drawer = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const sidebar = document.getElementById('sidebar');
      const toggle = document.getElementById('nav-toggle');
      const scrim = document.getElementById('sidebar-scrim');
      const timeline = [];
      const snap = (at) =>
        timeline.push({ at, expanded: toggle.getAttribute('aria-expanded'), open: sidebar.classList.contains('open') });

      const before = sidebar.getBoundingClientRect();
      const toggleVisible = toggle.getBoundingClientRect().width > 0;
      snap('before');

      toggle.click();
      snap('clicked');
      await sleep(400);
      snap('settled');

      const after = sidebar.getBoundingClientRect();
      const links = [...sidebar.querySelectorAll('a')].map((a) => Math.round(a.getBoundingClientRect().height));
      const opened = {
        shownAfter: after.left >= 0 && after.width > 0,
        expanded: toggle.getAttribute('aria-expanded'),
        scrimShown: !scrim.hidden,
        smallestLink: Math.min(...links),
      };

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(300);
      snap('escaped');

      return {
        toggleVisible,
        hiddenBefore: before.right <= 0,
        ...opened,
        closedAfterEscape: toggle.getAttribute('aria-expanded'),
        timeline,
      };
    })()`);

    check('the drawer toggle is visible on a phone', () => assert.equal(drawer.toggleVisible, true));
    check('the drawer is off-screen until opened', () => assert.equal(drawer.hiddenBefore, true));
    check('tapping the toggle opens it', () => {
      const trace = JSON.stringify(drawer.timeline);
      assert.equal(drawer.shownAfter, true, `drawer stayed off-screen ${trace}`);
      assert.equal(drawer.expanded, 'true', `aria-expanded wrong ${trace}`);
      assert.equal(drawer.scrimShown, true, `the rest of the page must be covered ${trace}`);
    });
    check('its links are thumb-sized', () => assert.ok(drawer.smallestLink >= 44, `smallest link ${drawer.smallestLink}px`));
    check('Escape closes it again', () => assert.equal(drawer.closedAfterEscape, 'false'));

    // A dialog on a phone is where layout most often goes wrong: it must fit,
    // scroll its own body, and keep its buttons reachable.
    process.stdout.write('\nDialog at 320px\n');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 640,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdp.send('Page.navigate', { url: `${BASE}/#/users` });
    await sleep(1800);

    const dialog = await cdp.evaluate(`(() => {
      const trigger = [...document.querySelectorAll('#main button')].find((b) => b.textContent === 'Add user');
      if (!trigger) return { skipped: true };
      trigger.click();
      const modal = document.getElementById('modal');
      const rect = modal.getBoundingClientRect();
      const actions = document.querySelector('.modal-actions').getBoundingClientRect();
      const body = document.getElementById('modal-body');
      const result = {
        skipped: false,
        fitsWidth: Math.round(rect.width) <= window.innerWidth,
        fitsHeight: Math.round(rect.height) <= window.innerHeight,
        actionsOnScreen: actions.bottom <= window.innerHeight + 1,
        bodyScrolls: getComputedStyle(body).overflowY,
        buttonHeight: Math.round(actions.querySelector ? 0 : 0) || Math.round(document.getElementById('modal-submit').getBoundingClientRect().height),
        focused: document.activeElement?.tagName?.toLowerCase(),
      };
      modal.close();
      return result;
    })()`);

    check('a dialog fits a 320px screen', () => {
      if (dialog.skipped) return;
      assert.equal(dialog.fitsWidth, true, 'the dialog is no wider than the screen');
      assert.equal(dialog.fitsHeight, true, 'and no taller');
    });
    check('its buttons stay reachable', () => {
      if (dialog.skipped) return;
      assert.equal(dialog.actionsOnScreen, true, 'the actions are not pushed below the fold');
      assert.equal(dialog.bodyScrolls, 'auto', 'the body scrolls, not the dialog');
      assert.ok(dialog.buttonHeight >= 40, `submit is ${dialog.buttonHeight}px tall`);
    });
    check('opening a dialog moves focus into it', () => {
      if (dialog.skipped) return;
      assert.ok(['input', 'button', 'select'].includes(dialog.focused), `focus went to ${dialog.focused}`);
    });
  } finally {
    await cleanup();
  }
}

main()
  .then(() => {
    process.stdout.write(
      `\n=====================================\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n\n`,
    );
    if (failures > 0) process.exitCode = 1;
  })
  .catch((err) => {
    process.stdout.write(`\nFATAL: ${err.message}\n${err.stack}\n`);
    process.exitCode = 1;
  });
