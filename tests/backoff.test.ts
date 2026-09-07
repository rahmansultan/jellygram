import test from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs } from '../src/lib/backoff.js';

/**
 * Retry delays.
 *
 * The schedule used to be linear, so three attempts spanned three minutes and
 * a dependency that was genuinely down stayed down for all of them.
 */

const opts = { baseMs: 30_000, maxMs: 1_800_000, jitter: 0 };

test('the delay doubles with each attempt', () => {
  assert.equal(backoffMs(1, opts), 30_000);
  assert.equal(backoffMs(2, opts), 60_000);
  assert.equal(backoffMs(3, opts), 120_000);
  assert.equal(backoffMs(4, opts), 240_000);
});

test('the delay is capped, however many attempts have been made', () => {
  assert.equal(backoffMs(20, opts), opts.maxMs);
  assert.equal(backoffMs(1000, opts), opts.maxMs, 'no overflow to Infinity');
  assert.ok(Number.isFinite(backoffMs(1000, opts)));
});

test('jitter spreads the delay without letting it collapse', () => {
  // With one worker this still matters: several uploads failing against the
  // same dead dependency would otherwise all wake at the same instant.
  const withJitter = { baseMs: 30_000, maxMs: 1_800_000, jitter: 0.2 };
  const samples = Array.from({ length: 200 }, () => backoffMs(3, withJitter));

  const min = Math.min(...samples);
  const max = Math.max(...samples);
  assert.ok(min >= 30_000, `never faster than the base delay, got ${min}`);
  assert.ok(max <= 1_800_000, 'never beyond the cap');
  assert.ok(new Set(samples).size > 10, 'the values genuinely vary');
  assert.ok(max - min > 1000, 'and the spread is meaningful');
});

test('a nonsensical attempt number does not produce a nonsensical delay', () => {
  assert.equal(backoffMs(0, opts), 30_000, 'treated as the first attempt');
  assert.equal(backoffMs(-5, opts), 30_000);
  assert.ok(Number.isFinite(backoffMs(1.5, opts)));
});
