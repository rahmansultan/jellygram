import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

/**
 * The dashboard's shared UI primitives, exercised in a DOM.
 *
 * These are the pieces every page depends on — the modal, the table, the
 * toasts — so a defect here is a defect everywhere. The dialog behaviour in
 * particular is worth pinning: a modal that never settles its promise leaves
 * every caller's follow-up work silently undone.
 */

const root = path.resolve(import.meta.dirname, '..');

/** A DOM with the real index.html and ui.js, and no network. */
function makeDom() {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { pretendToBeVisual: true, runScripts: 'outside-only', virtualConsole });

  // jsdom has no <dialog> implementation; these are the parts ui.js uses.
  const dialog = dom.window.document.getElementById('modal');
  dialog.showModal = function showModal() {
    this.open = true;
  };
  dialog.close = function close() {
    this.open = false;
    this.dispatchEvent(new dom.window.Event('close'));
  };

  dom.window.eval(fs.readFileSync(path.join(root, 'public/js/ui.js'), 'utf8'));
  return dom;
}

test('a modal resolves when it is closed with Escape', async () => {
  const dom = makeDom();
  const { openModal } = dom.window.UI;
  const dialog = dom.window.document.getElementById('modal');

  const pending = openModal({ title: 'Edit', fields: [{ name: 'x', label: 'X' }] });

  // Escape on a native <dialog> fires `cancel`, then `close`. Nothing in the
  // form's own handlers runs, so without an explicit handler the promise
  // stayed pending forever and the caller's toast and refresh never happened.
  dialog.dispatchEvent(new dom.window.Event('cancel'));

  const result = await Promise.race([
    pending,
    new Promise((resolve) => dom.window.setTimeout(() => resolve('TIMED_OUT'), 500)),
  ]);
  assert.equal(result, null, 'Escape resolves as "no result", not as a hang');
});

test('a confirmation resolves false when it is dismissed with Escape', async () => {
  const dom = makeDom();
  const { confirmDialog } = dom.window.UI;
  const dialog = dom.window.document.getElementById('modal');

  const pending = confirmDialog({ title: 'Delete?', message: 'Gone for good.', danger: true });
  dialog.dispatchEvent(new dom.window.Event('cancel'));

  const result = await Promise.race([
    pending,
    new Promise((resolve) => dom.window.setTimeout(() => resolve('TIMED_OUT'), 500)),
  ]);
  assert.equal(result, false, 'dismissing a confirmation must mean "no"');
});

test('a dangerous confirmation does not leave the next dialog looking dangerous', async () => {
  const dom = makeDom();
  const { confirmDialog, openModal } = dom.window.UI;
  const dialog = dom.window.document.getElementById('modal');
  const submit = dom.window.document.getElementById('modal-submit');

  const danger = confirmDialog({ title: 'Delete?', message: 'x', danger: true });
  assert.match(submit.className, /btn-danger/, 'a destructive action looks destructive');
  dialog.dispatchEvent(new dom.window.Event('cancel'));
  await danger;

  const ordinary = openModal({ title: 'Edit', fields: [] });
  assert.doesNotMatch(submit.className, /btn-danger/, 'an ordinary dialog looks ordinary again');
  dialog.dispatchEvent(new dom.window.Event('cancel'));
  await ordinary;
});

test('the submit button is disabled while a modal is submitting', async () => {
  const dom = makeDom();
  const { openModal } = dom.window.UI;
  const submit = dom.window.document.getElementById('modal-submit');
  const form = dom.window.document.getElementById('modal-form');

  let release;
  const inFlight = new Promise((resolve) => {
    release = resolve;
  });

  const pending = openModal({
    title: 'Save',
    fields: [{ name: 'x', label: 'X' }],
    onSubmit: () => inFlight,
  });

  form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await new Promise((r) => dom.window.setTimeout(r, 0));
  assert.equal(submit.disabled, true, 'a double submit must not be possible');

  release();
  await pending;
  assert.equal(submit.disabled, false, 'and the button is usable again afterwards');
});

test('a failing submit shows the error and keeps the dialog open', async () => {
  const dom = makeDom();
  const { openModal } = dom.window.UI;
  const form = dom.window.document.getElementById('modal-form');
  const errorNode = dom.window.document.getElementById('modal-error');
  const dialog = dom.window.document.getElementById('modal');

  const pending = openModal({
    title: 'Save',
    fields: [{ name: 'x', label: 'X' }],
    onSubmit: () => Promise.reject(new Error('That name is already taken')),
  });

  form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await new Promise((r) => dom.window.setTimeout(r, 0));

  assert.equal(errorNode.hidden, false, 'the failure is shown');
  assert.match(errorNode.textContent, /already taken/);
  assert.equal(dialog.open, true, 'the dialog stays open so the input can be corrected');

  dialog.dispatchEvent(new dom.window.Event('cancel'));
  await pending;
});

test('tables carry the semantics a screen reader needs', () => {
  const dom = makeDom();
  const { table } = dom.window.UI;

  const node = table(
    [
      { label: 'File', render: (r) => r.name },
      { label: 'Size', render: (r) => r.size },
    ],
    [{ name: 'Movie.mkv', size: '1.4 GiB' }],
    'Nothing to show',
    'Recent uploads',
  );

  const headers = [...node.querySelectorAll('th')];
  assert.equal(headers.length, 2);
  for (const th of headers) {
    assert.equal(th.getAttribute('scope'), 'col', 'a header must say what it heads');
  }
  assert.equal(node.querySelector('caption')?.textContent, 'Recent uploads');
  // The wrapper scrolls horizontally, so it must be reachable by keyboard.
  assert.equal(node.getAttribute('tabindex'), '0');
  assert.equal(node.getAttribute('role'), 'region');
});

test('an empty table explains itself instead of rendering a bare frame', () => {
  const dom = makeDom();
  const { table } = dom.window.UI;
  const node = table([{ label: 'File' }], [], 'No uploads yet.');
  assert.match(node.textContent, /No uploads yet\./);
  assert.equal(node.querySelector('table'), null);
});

test('cell content is inserted as text, never as markup', () => {
  const dom = makeDom();
  const { table } = dom.window.UI;
  const node = table(
    [{ label: 'File', render: (r) => r.name }],
    [{ name: '<img src=x onerror=alert(1)>' }],
    'empty',
  );
  assert.equal(node.querySelector('img'), null, 'a hostile filename must not become an element');
  assert.match(node.textContent, /<img src=x/, 'it is shown verbatim as text');
});

// ---------------------------------------------------------------------------
// The design-system primitives
// ---------------------------------------------------------------------------

test('a status never depends on colour alone', () => {
  const dom = makeDom();
  const { badge, statusBadge } = dom.window.UI;

  for (const [tone, glyph] of [['ok', '✓'], ['warn', '!'], ['danger', '✕']]) {
    const node = badge('Something', tone);
    assert.match(node.className, new RegExp(`is-${tone}`), 'the tone is on the class');
    assert.ok(node.textContent.includes(glyph), `${tone} carries a glyph as well as a colour`);
    assert.equal(
      node.querySelector('.badge-glyph')?.getAttribute('aria-hidden'),
      'true',
      'the glyph is decoration; the word is the accessible content',
    );
  }

  // A screen reader should hear words, not a constant name.
  assert.match(statusBadge('NEEDS_REVIEW').textContent, /Needs review/);
  assert.match(statusBadge('JELLYFIN_SCAN').textContent, /Scanning/);
  assert.match(statusBadge('DOWNLOADING').textContent, /Downloading/);
});

test('a meter states its value in words, not only as a bar', () => {
  const dom = makeDom();
  const { meter } = dom.window.UI;

  const node = meter({ value: 30, max: 120, caption: '30 GB of 120 GB', label: 'Quota used' });
  const bar = node.querySelector('.meter');
  assert.equal(bar.getAttribute('role'), 'meter');
  assert.equal(bar.getAttribute('aria-valuenow'), '25');
  assert.equal(bar.getAttribute('aria-label'), 'Quota used');
  assert.match(node.textContent, /30 GB of 120 GB/, 'the number is readable without the bar');
});

test('a meter with no maximum does not divide by zero', () => {
  const dom = makeDom();
  const { meter } = dom.window.UI;
  const node = meter({ value: 5, max: 0 });
  assert.equal(node.querySelector('.meter').getAttribute('aria-valuenow'), '0');
});

test('an async button cannot be pressed twice and always recovers', async () => {
  const dom = makeDom();
  const { actionButton } = dom.window.UI;

  let release;
  let calls = 0;
  const inFlight = new Promise((resolve) => {
    release = resolve;
  });

  const button = actionButton({
    label: 'Retry',
    busyLabel: 'Queueing…',
    onClick: () => {
      calls += 1;
      return inFlight;
    },
  });

  button.dispatchEvent(new dom.window.Event('click'));
  await new Promise((r) => dom.window.setTimeout(r, 0));

  assert.equal(button.disabled, true, 'the button locks while the request is in flight');
  assert.equal(button.textContent, 'Queueing…');

  button.dispatchEvent(new dom.window.Event('click'));
  assert.equal(calls, 1, 'a second press during the request does nothing');

  release();
  await new Promise((r) => dom.window.setTimeout(r, 0));
  assert.equal(button.disabled, false, 'and it is usable again afterwards');
  assert.equal(button.textContent, 'Retry');
});

test('an async button that fails reports it instead of spinning forever', async () => {
  const dom = makeDom();
  const { actionButton } = dom.window.UI;

  const button = actionButton({
    label: 'Verify',
    onClick: () => Promise.reject(new Error('Jellyfin is unreachable')),
  });

  button.dispatchEvent(new dom.window.Event('click'));
  await new Promise((r) => dom.window.setTimeout(r, 0));

  assert.equal(button.disabled, false, 'a rejected promise must not leave the button dead');
  assert.equal(button.textContent, 'Verify');
  const toasts = dom.window.document.getElementById('toasts');
  assert.match(toasts.textContent, /Jellyfin is unreachable/, 'the failure is surfaced');
});

test('a confirmed action does nothing when the confirmation is dismissed', async () => {
  const dom = makeDom();
  const { actionButton } = dom.window.UI;
  const dialog = dom.window.document.getElementById('modal');

  let ran = false;
  const button = actionButton({
    label: 'Delete',
    confirm: { title: 'Delete?', message: 'Gone for good.', danger: true },
    onClick: async () => {
      ran = true;
    },
  });

  button.dispatchEvent(new dom.window.Event('click'));
  await new Promise((r) => dom.window.setTimeout(r, 0));
  dialog.dispatchEvent(new dom.window.Event('cancel'));
  await new Promise((r) => dom.window.setTimeout(r, 0));

  assert.equal(ran, false, 'dismissing the confirmation cancels the action');
  assert.equal(button.disabled, false);
});

test('an identical toast is not repeated by a polling page', () => {
  const dom = makeDom();
  const { toast } = dom.window.UI;
  const host = dom.window.document.getElementById('toasts');

  toast('Could not reach the server.', 'error');
  toast('Could not reach the server.', 'error');
  toast('Could not reach the server.', 'error');
  assert.equal(host.querySelectorAll('.toast').length, 1, 'a five-second poll must not stack errors');

  toast('Something else happened', 'ok');
  assert.equal(host.querySelectorAll('.toast').length, 2, 'a different message still appears');
});

test('a toast can be dismissed by hand', () => {
  const dom = makeDom();
  const { toast } = dom.window.UI;
  const host = dom.window.document.getElementById('toasts');

  toast('Upload retry started', 'ok');
  const close = host.querySelector('.toast-close');
  assert.ok(close, 'every toast is dismissible');
  close.dispatchEvent(new dom.window.Event('click'));
  assert.equal(host.querySelectorAll('.toast').length, 0);
});

test('table cells carry their column label for the card layout', () => {
  const dom = makeDom();
  const { table } = dom.window.UI;

  const node = table(
    [
      { label: 'File', render: (r) => r.name },
      { label: 'Size', numeric: true, render: (r) => r.size },
      { label: 'Owner', secondary: true, render: (r) => r.owner },
    ],
    [{ name: 'Movie.mkv', size: '1.4 GiB', owner: 'alice' }],
    'empty',
  );

  const cells = [...node.querySelectorAll('td')];
  // Below the card breakpoint the header row is hidden and CSS prints these
  // instead; without them every value on a phone loses its heading.
  assert.deepEqual(
    cells.map((td) => td.getAttribute('data-label')),
    ['File', 'Size', 'Owner'],
  );
  assert.match(cells[1].className, /is-numeric/);
  assert.match(cells[2].className, /is-secondary/, 'a droppable column is marked as such');
});

test('a table keeps its roles once CSS stops it being a table', () => {
  const dom = makeDom();
  const { table } = dom.window.UI;
  const node = table([{ label: 'File', render: (r) => r.name }], [{ name: 'a.mkv' }], 'empty');

  // `display: block` in the card layout strips the implicit ARIA table roles,
  // so they are stated explicitly.
  assert.equal(node.querySelector('table').getAttribute('role'), 'table');
  assert.equal(node.querySelector('thead').getAttribute('role'), 'rowgroup');
  assert.equal(node.querySelector('tbody tr').getAttribute('role'), 'row');
  assert.equal(node.querySelector('th').getAttribute('role'), 'columnheader');
  assert.equal(node.querySelector('td').getAttribute('role'), 'cell');
});

test('an empty table can offer the action that would fill it', () => {
  const dom = makeDom();
  const { table, emptyState, el } = dom.window.UI;

  const node = table(
    [{ label: 'File' }],
    [],
    emptyState({
      title: 'No uploads yet',
      message: 'Send a video to the bot.',
      action: el('a', { class: 'btn', href: '#/users' }, 'Manage tokens'),
    }),
  );

  assert.match(node.textContent, /No uploads yet/);
  assert.match(node.textContent, /Send a video to the bot\./, 'it says why it is empty');
  assert.ok(node.querySelector('a[href="#/users"]'), 'and offers a way out of the empty state');
});

test('an overflow menu drops the actions that do not apply', () => {
  const dom = makeDom();
  const { menu } = dom.window.UI;

  const node = menu({
    label: 'Actions',
    items: [{ label: 'Retry', onClick: () => {} }, null, { label: 'Cancel', danger: true, onClick: () => {} }],
  });

  const items = [...node.querySelectorAll('[role="menuitem"]')];
  assert.equal(items.length, 2, 'a null item is not rendered as an empty row');
  assert.match(items[1].className, /is-danger/);
  assert.equal(node.querySelector('[role="menu"]').getAttribute('role'), 'menu');
  assert.equal(node.querySelector('summary').getAttribute('aria-label'), 'Actions');
});

test('a menu with nothing to offer is not rendered at all', () => {
  const dom = makeDom();
  const { menu } = dom.window.UI;
  // A trigger that opens an empty popup is a control that appears clickable
  // and does nothing.
  assert.equal(menu({ items: [null, false] }), null);
});

test('a page head states where you are and how to get back', () => {
  const dom = makeDom();
  const { pageHead, el } = dom.window.UI;

  const node = pageHead({
    title: 'Some User',
    description: 'Everything this account has.',
    back: { href: '#/users', label: 'Users' },
    actions: [el('button', {}, 'Edit'), null],
  });

  assert.equal(node.querySelector('h1').textContent, 'Some User');
  assert.equal(node.querySelector('.page-description').textContent, 'Everything this account has.');
  assert.equal(node.querySelector('.back-link').getAttribute('href'), '#/users');
  assert.equal(node.querySelectorAll('.page-actions button').length, 1, 'a null action is dropped');
});

test('a metric that links somewhere is a link, and one that does not is not', () => {
  const dom = makeDom();
  const { metric } = dom.window.UI;

  const linked = metric({ label: 'Failed', value: '3', href: '#/uploads', tone: 'danger' });
  assert.equal(linked.tagName, 'A');
  assert.equal(linked.getAttribute('href'), '#/uploads');
  assert.match(linked.querySelector('.metric').className, /is-danger/);

  const plain = metric({ label: 'Movies', value: '12' });
  assert.equal(plain.tagName, 'DIV', 'a number with nowhere to go must not look clickable');
});

test('durations read as time, not as a large number of seconds', () => {
  const dom = makeDom();
  const { duration, bytes } = dom.window.UI;

  assert.equal(duration(45_000), '45s');
  assert.equal(duration(125_000), '2m 5s');
  assert.equal(duration(3_725_000), '1h 2m', 'hours matter for a 5 GiB transfer');
  assert.equal(duration(null), '—');
  assert.equal(bytes(null), '—');
});

test('a relative time keeps the exact time available', () => {
  const dom = makeDom();
  const { when } = dom.window.UI;
  const node = when(new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());
  assert.match(node.textContent, /3h ago/);
  assert.ok(node.getAttribute('title')?.length > 6, 'the precise timestamp is one hover away');
  assert.equal(when(null), '—');
});

test('a cell with nothing in it is marked so a phone can drop it', () => {
  const dom = makeDom();
  const { table } = dom.window.UI;

  const node = table(
    [
      { label: 'File', render: (r) => r.name },
      { label: 'Progress', render: () => '—' },
      { label: 'Took', render: () => null },
      { label: 'Size', render: (r) => r.size },
    ],
    [{ name: 'Movie.mkv', size: '1.4 GiB' }],
    'empty',
  );

  const cells = [...node.querySelectorAll('td')];
  assert.equal(cells[0].className.includes('is-empty'), false, 'the identity cell is never dropped');
  assert.match(cells[1].className, /is-empty/, 'an em dash is nothing to say');
  assert.match(cells[2].className, /is-empty/, 'and neither is null');
  assert.equal(cells[2].textContent, '—', 'but the wide table still renders a placeholder');
  assert.equal(cells[3].className.includes('is-empty'), false);
});
