import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

/**
 * The responsive and accessibility contract of the stylesheet.
 *
 * This does not lay the page out — jsdom has no layout engine, so nothing here
 * can claim a screen "looks right" at 320px. What it can do is pin the rules
 * that make narrow screens work at all, because each of them is a one-line
 * edit away from silently regressing: a grid whose minimum is wider than a
 * phone pushes the whole page sideways, a table that never restacks buries its
 * actions two swipes off-screen, and a motion preference that stops being
 * honoured cannot be noticed by anyone who does not need it.
 */

const root = path.resolve(import.meta.dirname, '..');
const cssText = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');

/** The stylesheet, parsed by a real CSS parser rather than by regex. */
function sheet() {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(`<style>${cssText}</style>`, { virtualConsole });
  return dom.window.document.styleSheets[0];
}

function flatten(rules, media = null) {
  const out = [];
  for (const rule of rules) {
    if (rule.cssRules && rule.media) {
      out.push(...flatten(rule.cssRules, rule.media.mediaText));
    } else if (rule.cssRules) {
      out.push(...flatten(rule.cssRules, media));
    } else if (rule.selectorText) {
      out.push({ selector: rule.selectorText, style: rule.style, media });
    }
  }
  return out;
}

const allRules = flatten(sheet().cssRules);

function find(selector, { media = null } = {}) {
  return allRules.filter((r) => r.selector === selector && r.media === media);
}

function declared(selector, property, opts) {
  for (const rule of find(selector, opts)) {
    const value = rule.style.getPropertyValue(property);
    if (value) return value;
  }
  return null;
}

test('the stylesheet parses without dropping rules', () => {
  assert.ok(allRules.length > 150, `only ${allRules.length} rules parsed`);
});

test('no grid can be wider than the screen it is on', () => {
  // `repeat(auto-fit, minmax(320px, 1fr))` does not shrink below 320px: on a
  // 320px phone the track overflows and the entire page scrolls sideways.
  const offenders = allRules
    .filter((r) =>
      /repeat\(\s*auto-(fit|fill)\s*,\s*minmax\(\s*\d+px/.test(
        r.style.getPropertyValue('grid-template-columns') ?? '',
      ),
    )
    .map((r) => r.selector);
  assert.deepEqual(offenders, [], 'every auto-fit minimum must be wrapped in min(…, 100%)');

  // An explicit fixed column is allowed, but only one narrow enough to fit
  // alongside its content on the smallest screen the product supports.
  for (const rule of allRules) {
    const columns = rule.style.getPropertyValue('grid-template-columns') ?? '';
    const fixed = /minmax\(\s*(\d+)px/.exec(columns);
    if (!fixed || columns.includes('auto-fit') || columns.includes('auto-fill')) continue;
    assert.ok(
      Number(fixed[1]) <= 160,
      `${rule.selector} pins a ${fixed[1]}px column, too wide to sit beside its value at 320px`,
    );
  }
});

test('tables become cards before their actions go off-screen', () => {
  const cardLayout = allRules.filter((r) => r.media && /max-width:\s*760px/.test(r.media));
  assert.ok(cardLayout.length > 0, 'there is a card breakpoint for tables');

  const restacked = cardLayout.find((r) => r.selector.includes('td') && r.selector.includes('tr'));
  assert.ok(restacked, 'rows and cells are restacked');
  assert.equal(restacked.style.getPropertyValue('display'), 'block');

  const labelled = cardLayout.find((r) => r.selector.includes('td::before'));
  assert.ok(labelled, 'each cell prints the label of its column');
  assert.match(labelled.style.getPropertyValue('content'), /attr\(data-label\)/);

  const header = cardLayout.find((r) => r.selector === 'thead');
  assert.equal(header?.style.getPropertyValue('display'), 'none', 'the header row is hidden');
});

test('a phone drops only the columns marked droppable', () => {
  const narrow = allRules.filter((r) => r.media && /max-width:\s*420px/.test(r.media));
  const hidden = narrow.find((r) => r.selector.includes('is-secondary'));
  assert.ok(hidden, 'secondary columns are hidden on the narrowest screens');
  assert.equal(hidden.style.getPropertyValue('display'), 'none');
});

test('touch targets stay large enough to hit', () => {
  // 38px is the desktop baseline; the drawer and the modal's stacked buttons
  // are the two places a thumb is actually used, and both go larger.
  assert.equal(declared('.btn', 'min-height'), '38px');
  assert.equal(declared('.icon-btn', 'height'), '38px');

  const drawer = allRules.find((r) => r.media?.includes('900px') && r.selector === '.sidebar a');
  assert.equal(drawer?.style.getPropertyValue('min-height'), '46px', 'navigation is thumb-sized on a phone');

  const modalButton = allRules.find(
    (r) => r.media?.includes('480px') && r.selector === '.modal-actions .btn',
  );
  assert.equal(modalButton?.style.getPropertyValue('min-height'), '44px');
});

test('a dialog fits and scrolls on a phone instead of overflowing it', () => {
  const modal = allRules.filter((r) => r.media?.includes('480px') && r.selector === '.modal')[0];
  assert.ok(modal, 'the modal has a phone layout');
  assert.equal(modal.style.getPropertyValue('max-width'), '100vw');
  assert.match(modal.style.getPropertyValue('max-height'), /dvh/, 'height follows the visible viewport');

  // The body scrolls, not the dialog: otherwise a long form pushes its own
  // buttons past the bottom of the screen where they cannot be reached.
  assert.equal(declared('#modal-body', 'overflow-y'), 'auto');
  assert.equal(declared('.modal-actions', 'flex'), 'none');
});

test('the motion preference is honoured', () => {
  const reduced = allRules.filter((r) => r.media?.includes('prefers-reduced-motion'));
  assert.ok(reduced.length > 0, 'there is a reduced-motion block');
  const universal = reduced.find((r) => r.selector.includes('*'));
  assert.ok(universal, 'it applies to everything, not to a hand-picked list');
  assert.match(universal.style.getPropertyValue('animation-duration'), /0\.001ms/);
  assert.match(universal.style.getPropertyValue('transition-duration'), /0\.001ms/);
});

test('both themes are defined without either depending on a media query alone', () => {
  // A colour whose only definition lives inside a media query disappears for
  // anyone whose system preference goes the other way.
  const base = allRules.find((r) => r.selector === ':root' && r.media === null);
  assert.ok(base, ':root carries the light palette unconditionally');
  for (const token of ['--bg', '--surface', '--text', '--accent', '--ok', '--warn', '--danger']) {
    assert.ok(base.style.getPropertyValue(token), `${token} has a default`);
  }

  const explicitDark = allRules.find((r) => r.selector === ':root[data-theme="dark"]');
  assert.ok(explicitDark, 'an explicit dark choice overrides the system preference');

  const systemDark = allRules.find(
    (r) => r.media?.includes('prefers-color-scheme: dark') && r.selector.includes('data-theme="light"'),
  );
  assert.ok(systemDark, 'the system preference yields to an explicit light choice');
});

test('the page never scrolls sideways as a whole', () => {
  // Wide content is allowed to scroll inside its own container; the body is
  // not. `overflow-x: auto` on the table wrapper is what keeps that true.
  assert.equal(declared('.table-wrap', 'overflow-x'), 'auto');
  assert.match(declared('.kv', 'grid-template-columns') ?? '', /minmax\(120px, max-content\) 1fr/);

  const narrowKv = allRules.find((r) => r.media?.includes('480px') && r.selector === '.kv');
  assert.equal(narrowKv?.style.getPropertyValue('grid-template-columns'), '1fr', 'labels stack under 480px');
});

test('long unbroken strings wrap instead of widening the page', () => {
  // Paths, checksums and filenames have no spaces to break at.
  for (const selector of ['.kv dd', '.log-detail', '.static-value']) {
    assert.equal(declared(selector, 'overflow-wrap'), 'anywhere', `${selector} must wrap anywhere`);
  }
  assert.equal(declared('code,\n.mono', 'overflow-wrap') ?? declared('code', 'overflow-wrap'), 'anywhere');
});

test('focus is always visible, from one rule', () => {
  const focus = find(':focus-visible');
  assert.ok(focus.length, 'there is a single focus style');
  assert.match(focus[0].style.getPropertyValue('outline'), /2px solid/);
  assert.ok(focus[0].style.getPropertyValue('outline-offset'), 'the ring is offset so it stays legible');
});

test('the screen-reader-only class actually hides content visually', () => {
  assert.equal(declared('.sr-only', 'position'), 'absolute');
  assert.equal(declared('.sr-only', 'width'), '1px');
  assert.equal(declared('.sr-only', 'overflow'), 'hidden');
  assert.equal(declared('.sr-only', 'white-space'), 'nowrap');
});
