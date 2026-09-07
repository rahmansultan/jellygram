/* global window, performance, AbortController */
'use strict';

/**
 * Which way to Jellyfin.
 *
 * The server has more than one door, and which is fastest depends on where the
 * phone is: on the tailnet the private route is direct; anywhere else only the
 * public one answers. Rather than infer that from anything the device says
 * about itself, every candidate is asked the same cheap question at the same
 * moment — a GET of Jellyfin's public info endpoint — and the answers decide.
 *
 * Candidates are probed in parallel and chosen in priority order. The first in
 * the list to answer wins the instant it answers, without waiting for the rest;
 * if it fails, the next is already in flight, so a dead route costs at most its
 * own timeout and never the sum of them.
 *
 * Only routes this page can actually test are candidates. The page is served
 * over HTTPS, and a browser will not let it fetch a plain-http address at all
 * (mixed content), so a LAN address on http:// cannot be probed from here. It
 * can still be opened — a top-level navigation is exempt from that rule — which
 * is why the app offers it rather than measuring it.
 */
window.JellyfinRoute = (() => {
  const DEFAULT_TIMEOUT_MS = 1500;
  const PROBE_PATH = '/System/Info/Public';

  function clock() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /** Ask one candidate; never throws, always reports how long it took. */
  function probe(candidate, timeoutMs, fetchImpl, now) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), candidate.timeoutMs ?? timeoutMs);
    const startedAt = now();
    const elapsed = () => Math.max(0, Math.round(now() - startedAt));

    return fetchImpl(`${candidate.url}${PROBE_PATH}`, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    })
      .then((res) => ({ ...candidate, ok: Boolean(res.ok), status: res.status, ms: elapsed() }))
      .catch(() => ({ ...candidate, ok: false, status: 0, ms: elapsed() }))
      .finally(() => clearTimeout(timer));
  }

  /**
   * @param {Array<{name: string, url: string, timeoutMs?: number}>} candidates
   *   in priority order; entries without an http(s) url are ignored.
   * @returns {Promise<{chosen: object|null, results: object[]}>} the winner, and
   *   every result that was consulted on the way to it.
   */
  async function choose(candidates, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchImpl = options.fetch ?? ((url, init) => window.fetch(url, init));
    const now = options.now ?? clock;

    const usable = (candidates ?? []).filter(
      (c) => c && typeof c.url === 'string' && /^https?:\/\/\S+$/.test(c.url),
    );

    // All at once — the ordering below is about which answer we accept first,
    // not about when the questions are asked.
    const inFlight = usable.map((c) => probe(c, timeoutMs, fetchImpl, now));

    const results = [];
    for (const pending of inFlight) {
      const result = await pending;
      results.push(result);
      if (result.ok) return { chosen: result, results };
    }
    return { chosen: null, results };
  }

  return { choose, PROBE_PATH, DEFAULT_TIMEOUT_MS };
})();
