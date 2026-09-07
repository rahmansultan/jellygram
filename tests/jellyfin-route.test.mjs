import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The route chooser, exercised with a scripted network.
 *
 * What matters is not that it opens *a* Jellyfin but that it opens the right
 * one for where the phone is, decides quickly, and never pays for a dead route
 * twice. Timing is asserted in generous bands rather than exact numbers — the
 * property is "one timeout, not the sum", not "exactly 60 ms".
 */

// The module attaches itself to `window`; in Node the global object stands in.
globalThis.window = globalThis;
(0, eval)(fs.readFileSync(path.join(process.cwd(), 'public/miniapp/js/jellyfin-route.js'), 'utf8'));
const { choose, PROBE_PATH } = globalThis.JellyfinRoute;

const TAILSCALE = 'https://ts.example:8445';
const INTERNET = 'https://ts.example:10000';

const answer = (status, delayMs = 0) => () =>
  new Promise((resolve) => setTimeout(() => resolve({ ok: status >= 200 && status < 300, status }), delayMs));
const refuse = () => () => Promise.reject(new TypeError('Failed to fetch'));
const hang = () => (_url, init) =>
  new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));

/** A fetch that answers by URL prefix and records every call as it is made. */
function network(script) {
  const calls = [];
  const fetch = (url, init) => {
    calls.push({ url, at: Date.now() });
    const key = Object.keys(script).find((k) => url.startsWith(k));
    if (!key) return Promise.reject(new Error(`unscripted: ${url}`));
    return script[key](url, init);
  };
  return { fetch, calls };
}

const candidates = (overrides = {}) => [
  { name: 'Tailscale', url: TAILSCALE, timeoutMs: 60, ...overrides.tailscale },
  { name: 'Internet', url: INTERNET, timeoutMs: 400, ...overrides.internet },
];

test('the tailnet route wins when it answers', async () => {
  const net = network({ [TAILSCALE]: answer(200), [INTERNET]: answer(200) });
  const { chosen } = await choose(candidates(), { fetch: net.fetch });
  assert.equal(chosen?.name, 'Tailscale');
  assert.equal(chosen.url, TAILSCALE);
  assert.ok(Number.isInteger(chosen.ms) && chosen.ms >= 0, 'a measured duration');
});

test('every candidate is asked at once, not one after another', async () => {
  const net = network({ [TAILSCALE]: answer(200, 30), [INTERNET]: answer(200, 30) });
  await choose(candidates(), { fetch: net.fetch });
  assert.equal(net.calls.length, 2, 'both probes were sent');
  assert.ok(net.calls[1].at - net.calls[0].at < 15, 'sent together, not after the first answered');
  assert.ok(net.calls.every((c) => c.url.endsWith(PROBE_PATH)), 'the cheap public endpoint');
});

test('a refused route falls straight through to the next', async () => {
  const net = network({ [TAILSCALE]: refuse(), [INTERNET]: answer(200) });
  const { chosen, results } = await choose(candidates(), { fetch: net.fetch });
  assert.equal(chosen?.name, 'Internet');
  assert.equal(results[0].ok, false, 'the refusal is on record');
});

test('a route that never answers costs its own timeout and nothing more', async () => {
  const net = network({ [TAILSCALE]: hang(), [INTERNET]: answer(200, 5) });
  const started = Date.now();
  const { chosen } = await choose(candidates(), { fetch: net.fetch });
  const took = Date.now() - started;
  assert.equal(chosen?.name, 'Internet');
  assert.ok(took >= 50, `waited for the tailnet timeout (${took} ms)`);
  assert.ok(took < 300, `but not for the internet one as well (${took} ms)`);
});

test('a server that answers but refuses (503) is not a usable route', async () => {
  const net = network({ [TAILSCALE]: answer(503), [INTERNET]: answer(200) });
  const { chosen, results } = await choose(candidates(), { fetch: net.fetch });
  assert.equal(chosen?.name, 'Internet');
  assert.equal(results[0].status, 503);
});

test('when nothing answers, the caller is told so rather than handed a guess', async () => {
  const net = network({ [TAILSCALE]: refuse(), [INTERNET]: refuse() });
  const { chosen, results } = await choose(candidates(), { fetch: net.fetch });
  assert.equal(chosen, null);
  assert.equal(results.length, 2);
});

test('candidates without a usable http(s) address are ignored', async () => {
  const net = network({ [INTERNET]: answer(200) });
  const { chosen } = await choose(
    [{ name: 'LAN', url: null }, { name: 'Odd', url: 'ftp://x' }, { name: 'Internet', url: INTERNET }],
    { fetch: net.fetch },
  );
  assert.equal(chosen?.name, 'Internet');
  assert.equal(net.calls.length, 1, 'only the real candidate was asked');
});

test('probes are cache-free, credential-free, cross-origin GETs with a cancel signal', async () => {
  let seen;
  const net = network({ [TAILSCALE]: (url, init) => { seen = init; return answer(200)(); }, [INTERNET]: answer(200) });
  await choose(candidates(), { fetch: net.fetch });
  assert.equal(seen.method, 'GET');
  assert.equal(seen.mode, 'cors');
  assert.equal(seen.cache, 'no-store');
  assert.equal(seen.credentials, 'omit');
  assert.ok(seen.signal, 'abortable');
});
