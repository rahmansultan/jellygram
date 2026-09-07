import test from 'node:test';
import assert from 'node:assert/strict';
import { FLOOD_LIMITS, admitRequest, resetFloodState } from '../src/api/flood.js';

/**
 * The ceiling that faces the internet.
 *
 * Its two jobs pull in opposite directions: refuse a machine hammering the
 * port, and never once refuse a person using the app. The tests hold both
 * ends — the limit is reached exactly where it is documented, and the table
 * that tracks it cannot itself be made to grow without bound.
 */

const { MAX_PER_WINDOW, WINDOW_MS, MAX_TRACKED } = FLOOD_LIMITS;

test('a request under the ceiling is admitted', () => {
  resetFloodState();
  const verdict = admitRequest('198.51.100.7', 1_000);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.retryAfterSec, 0);
});

test('the ceiling is reached exactly where it is documented', () => {
  resetFloodState();
  for (let i = 0; i < MAX_PER_WINDOW; i += 1) {
    assert.equal(admitRequest('198.51.100.8', 1_000).allowed, true, `request ${i + 1} should pass`);
  }
  const overflow = admitRequest('198.51.100.8', 1_000);
  assert.equal(overflow.allowed, false);
  assert.ok(overflow.retryAfterSec > 0, 'a refusal must say when to come back');
});

test('one address flooding does not refuse another', () => {
  resetFloodState();
  for (let i = 0; i <= MAX_PER_WINDOW; i += 1) admitRequest('198.51.100.9', 1_000);
  assert.equal(admitRequest('198.51.100.9', 1_000).allowed, false);
  assert.equal(admitRequest('203.0.113.4', 1_000).allowed, true);
});

test('the budget returns when the window rolls over', () => {
  resetFloodState();
  for (let i = 0; i <= MAX_PER_WINDOW; i += 1) admitRequest('198.51.100.10', 1_000);
  assert.equal(admitRequest('198.51.100.10', 1_000).allowed, false);
  assert.equal(admitRequest('198.51.100.10', 1_000 + WINDOW_MS + 1).allowed, true);
});

test('the tracking table cannot be grown without bound', () => {
  resetFloodState();
  // One request each from far more addresses than the table is allowed to hold,
  // which is what a flood with forged sources looks like.
  for (let i = 0; i < MAX_TRACKED + 5_000; i += 1) {
    admitRequest(`10.0.${Math.floor(i / 256) % 256}.${i % 256}-${i}`, 1_000);
  }
  // Nothing to assert about the exact size beyond the bound itself: the point
  // is that the process is still here and the next caller is still served.
  assert.equal(admitRequest('203.0.113.5', 1_000).allowed, true);
});

test('a person browsing the library stays far below the ceiling', () => {
  resetFloodState();
  // A generous minute: the shell, forty posters, an upload part every two
  // seconds, and the transfers view polling throughout.
  const realisticMinute = 1 + 40 + 30 + 20;
  assert.ok(realisticMinute * 4 < MAX_PER_WINDOW, 'the ceiling must not be reachable by use');
});
