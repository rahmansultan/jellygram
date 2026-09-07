import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/index.js';
import { planUpload } from '../src/api/upload.js';

/**
 * The size decision, at and around every boundary.
 *
 * This is the rule the whole uploader hangs on, and it is taken from the
 * original file's size before a byte moves, so it is worth pinning exactly.
 */

const GiB = 1024 * 1024 * 1024;
const SINGLE_MAX = config.upload.singleMaxBytes; // 2 GiB
const ASSEMBLED_MAX = config.multipart.maxAssembledBytes; // 5 GiB

test('the thresholds are the documented values', () => {
  assert.equal(SINGLE_MAX, 2 * GiB, 'single-upload ceiling should be 2 GiB');
  assert.equal(SINGLE_MAX, 2_147_483_648);
  assert.equal(ASSEMBLED_MAX, 5 * GiB, 'assembled ceiling should be 5 GiB');
  assert.equal(ASSEMBLED_MAX, 5_368_709_120);
});

// ---------------------------------------------------------------------------
// Below the single-upload ceiling
// ---------------------------------------------------------------------------

test('a small file is sent whole', () => {
  const plan = planUpload(12 * 1024 * 1024);
  assert.equal(plan.mode, 'single');
  assert.equal(plan.partCount, 1);
});

test('1.9 GB is sent whole', () => {
  assert.equal(planUpload(Math.floor(1.9 * GiB)).mode, 'single');
});

test('1.99 GB is sent whole', () => {
  assert.equal(planUpload(Math.floor(1.99 * GiB)).mode, 'single');
});

test('exactly 2 GiB is sent whole', () => {
  const plan = planUpload(SINGLE_MAX);
  assert.equal(plan.mode, 'single', 'the boundary itself is inclusive');
  assert.equal(plan.partCount, 1);
});

test('one byte under 2 GiB is sent whole', () => {
  assert.equal(planUpload(SINGLE_MAX - 1).mode, 'single');
});

// ---------------------------------------------------------------------------
// Above it, and below the assembled ceiling
// ---------------------------------------------------------------------------

test('one byte over 2 GiB switches to multi-part', () => {
  const plan = planUpload(SINGLE_MAX + 1);
  assert.equal(plan.mode, 'multipart', 'the very next byte must switch modes');
  assert.ok(plan.partCount >= 2);
});

test('2.01 GB is multi-part', () => {
  assert.equal(planUpload(Math.ceil(2.01 * GiB)).mode, 'multipart');
});

test('3 GB is multi-part', () => {
  const plan = planUpload(3 * GiB);
  assert.equal(plan.mode, 'multipart');
  assert.equal(plan.partCount, Math.ceil((3 * GiB) / plan.partSize));
});

test('4 GB is multi-part', () => {
  assert.equal(planUpload(4 * GiB).mode, 'multipart');
});

test('exactly 5 GiB is multi-part, not refused', () => {
  const plan = planUpload(ASSEMBLED_MAX);
  assert.equal(plan.mode, 'multipart', 'the ceiling itself is inclusive');
  assert.ok(plan.partCount >= 2);
  assert.ok(plan.partCount <= config.multipart.maxParts);
});

test('one byte under 5 GiB is multi-part', () => {
  assert.equal(planUpload(ASSEMBLED_MAX - 1).mode, 'multipart');
});

// ---------------------------------------------------------------------------
// Above the assembled ceiling
// ---------------------------------------------------------------------------

test('one byte over 5 GiB is refused', () => {
  const plan = planUpload(ASSEMBLED_MAX + 1);
  assert.equal(plan.mode, 'reject');
  assert.match(plan.reason ?? '', /maximum/i);
});

test('5.01 GB is refused', () => {
  assert.equal(planUpload(Math.ceil(5.01 * GiB)).mode, 'reject');
});

test('10 GB is refused', () => {
  assert.equal(planUpload(10 * GiB).mode, 'reject');
});

test('an empty file is refused', () => {
  assert.equal(planUpload(0).mode, 'reject');
  assert.equal(planUpload(-1).mode, 'reject');
});

// ---------------------------------------------------------------------------
// Part arithmetic
// ---------------------------------------------------------------------------

test('parts cover the file exactly, with a short final part', () => {
  for (const size of [SINGLE_MAX + 1, 3 * GiB, 4 * GiB, ASSEMBLED_MAX, ASSEMBLED_MAX - 12345]) {
    const plan = planUpload(size);
    assert.equal(plan.mode, 'multipart', `${size} should be multi-part`);

    const full = (plan.partCount - 1) * plan.partSize;
    const lastPart = size - full;

    assert.ok(lastPart > 0, 'the final part must contain something');
    assert.ok(lastPart <= plan.partSize, 'the final part must not exceed the part size');
    assert.equal(full + lastPart, size, 'the parts must sum to the original size');
  }
});

test('no part exceeds what one request may carry', () => {
  for (const size of [SINGLE_MAX + 1, 3 * GiB, ASSEMBLED_MAX]) {
    assert.ok(planUpload(size).partSize <= config.upload.partMaxBytes);
  }
});

test('the part count stays within the session limit', () => {
  assert.ok(planUpload(ASSEMBLED_MAX).partCount <= config.multipart.maxParts);
});

test('the mode is a pure function of size', () => {
  // Same input, same answer: the decision must not depend on anything else.
  for (const size of [1024, SINGLE_MAX, SINGLE_MAX + 1, ASSEMBLED_MAX, ASSEMBLED_MAX + 1]) {
    assert.deepEqual(planUpload(size), planUpload(size));
  }
});

test('every size maps to exactly one mode, with no gaps', () => {
  const boundaries = [
    1,
    1024,
    SINGLE_MAX - 1,
    SINGLE_MAX,
    SINGLE_MAX + 1,
    ASSEMBLED_MAX - 1,
    ASSEMBLED_MAX,
    ASSEMBLED_MAX + 1,
  ];
  const expected = [
    'single',
    'single',
    'single',
    'single',
    'multipart',
    'multipart',
    'multipart',
    'reject',
  ];
  assert.deepEqual(
    boundaries.map((b) => planUpload(b).mode),
    expected,
  );
});
