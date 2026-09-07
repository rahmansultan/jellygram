import './helpers/test-database.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../src/db/pool.js';
import { type HealthCheck, type HealthState, alertFor, runHealthChecks, worstState } from '../src/services/health.js';

/**
 * Health checks and when they are worth announcing.
 *
 * The alerting rule matters more than any individual check: a channel that
 * repeats "disk is low" every five minutes is a channel nobody reads.
 */

test.after(() => closePool());

const check = (state: HealthState): HealthCheck => ({ id: 'x', label: 'X', state, detail: '' });

test('the overall state is the worst of its parts', () => {
  assert.equal(worstState([check('ok'), check('ok')]), 'ok');
  assert.equal(worstState([check('ok'), check('warn')]), 'warn');
  assert.equal(worstState([check('warn'), check('down')]), 'down');
  assert.equal(worstState([check('ok'), check('unknown')]), 'unknown');
  assert.equal(worstState([check('down'), check('unknown')]), 'down', 'down outranks unknown');
  assert.equal(worstState([]), 'ok', 'nothing to report is not a problem');
});

test('an unchanged state is never announced', () => {
  // The sweep runs every few minutes; without this every check would alert on
  // every tick for as long as the condition lasted.
  for (const s of ['ok', 'warn', 'down', 'unknown'] as HealthState[]) {
    assert.equal(alertFor(s, s), null, `${s} -> ${s}`);
  }
});

test('getting worse is announced once, at the moment it changes', () => {
  assert.equal(alertFor('ok', 'warn'), 'worsened');
  assert.equal(alertFor('ok', 'down'), 'worsened');
  assert.equal(alertFor('warn', 'down'), 'worsened', 'an escalation is worth a second message');
});

test('recovery is announced, because that is what makes silence trustworthy', () => {
  assert.equal(alertFor('down', 'ok'), 'recovered');
  assert.equal(alertFor('warn', 'ok'), 'recovered');
});

test('easing off without recovering is not announced again', () => {
  // Already told them it was down; "still bad, slightly less so" adds nothing.
  assert.equal(alertFor('down', 'warn'), null);
});

test('a check that could not run does not raise a false alarm', () => {
  // "I could not look" is not "it is broken". Treating the two the same
  // produces alerts every time a dependency is slow to start.
  assert.equal(alertFor('ok', 'unknown'), null);
  assert.equal(alertFor('unknown', 'ok'), null);
  assert.equal(alertFor('unknown', 'warn'), null);
  assert.equal(alertFor('unknown', 'down'), 'worsened', 'but a definite failure still counts');
});

test('every check reports a state, a label and a usable detail', async () => {
  const checks = await runHealthChecks();
  assert.ok(checks.length >= 6, `expected the full set, got ${checks.length}`);

  for (const c of checks) {
    assert.ok(c.id && c.label, 'each check identifies itself');
    assert.ok(['ok', 'warn', 'down', 'unknown'].includes(c.state), `${c.id} has a valid state`);
    assert.equal(typeof c.detail, 'string');
    // Anything not ok must say what to do about it, or it is just noise.
    if (c.state === 'down' || c.state === 'warn') {
      assert.ok(c.action, `${c.id} is ${c.state} but suggests no action`);
    }
  }
});

test('checks come back worst-first', async () => {
  const rank = { down: 0, warn: 1, unknown: 2, ok: 3 };
  const checks = await runHealthChecks();
  const order = checks.map((c) => rank[c.state]);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the most serious thing is listed first');
});

test('health checks never throw, whatever a dependency does', async () => {
  // Called on a timer in the worker: an exception here would take down the
  // sweep and with it every future alert.
  await assert.doesNotReject(() => runHealthChecks());
});

test('the system reports whether its own alerting is configured', async () => {
  // Every other check is pointless if there is nowhere to send the result:
  // notifyAdmin silently does nothing without an admin chat id, so a system
  // with alerting on and one with it off look identical from outside.
  const checks = await runHealthChecks();
  const alerts = checks.find((c) => c.id === 'alerts');
  assert.ok(alerts, 'the alerting path is itself checked');
  assert.ok(['ok', 'warn'].includes(alerts.state));
  if (alerts.state === 'warn') {
    assert.match(alerts.action ?? '', /TELEGRAM_ADMIN_CHAT_ID/, 'and it says how to fix it');
  }
});
