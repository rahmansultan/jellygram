import './helpers/test-credentials.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestScan } from '../src/services/jellyfin.js';

/**
 * Regression test for media that was filed correctly but never appeared in
 * Jellyfin.
 *
 * The pipeline used to trigger only `/Items/{libraryId}/Refresh` when it knew
 * the library's item id — which is the normal case. That endpoint refreshes
 * metadata for items Jellyfin has already indexed and never discovers new
 * files, so an upload sat on disk until an unrelated scheduled scan ran.
 */

interface Call {
  method: string;
  pathname: string;
}

/** Record the Jellyfin endpoints hit, without touching the network. */
async function recordCalls(run: () => Promise<void>): Promise<Call[]> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    calls.push({ method: 'POST', pathname: url.pathname });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
  return calls;
}

test('requestScan always runs the library scan that discovers new files', async () => {
  const calls = await recordCalls(() => requestScan('library-item-id'));
  const paths = calls.map((c) => c.pathname);

  assert.ok(
    paths.includes('/Library/Refresh'),
    `/Library/Refresh is the only endpoint that discovers new files; got ${paths.join(', ')}`,
  );
  assert.ok(
    paths.some((p) => p.startsWith('/Items/') && p.endsWith('/Refresh')),
    'the targeted library refresh should still run',
  );
  // The targeted refresh is the cheap nudge; the scan is what must follow it.
  assert.ok(
    paths.indexOf('/Library/Refresh') > paths.findIndex((p) => p.startsWith('/Items/')),
    'library scan should run after the targeted refresh',
  );
});

test('requestScan still scans when the library item id is unknown', async () => {
  const calls = await recordCalls(() => requestScan(null));
  assert.deepEqual(
    calls.map((c) => c.pathname),
    ['/Library/Refresh'],
  );
});
