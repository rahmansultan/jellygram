import './helpers/test-media-root.js';
import './helpers/test-credentials.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The dashboard shell, the Mini App shell and the SPA fallback are all served
 * with `res.sendFile`, and `send` refuses any path containing a dot-prefixed
 * segment — applying that rule to the *whole absolute path*, not just to the
 * part a caller asked for.
 *
 * So a checkout under `~/.local/share/jellygram`, `/srv/.apps/jellygram`, or
 * any other hidden directory made every one of those routes fail. The failure was
 * particularly unhelpful: `express.static` checks the request path rather than
 * its own root, so the first page load worked and only a refresh on a
 * client-side route or an attempt to open the Mini App broke — and `send`'s
 * 404 arrived at the browser as a 500.
 *
 * `src/api/server.ts` passes `dotfiles: 'allow'` for exactly this reason.
 * These tests pin the behaviour it relies on, from a directory shaped like the
 * installation that exposed it.
 */

function shellApp(dir: string, options?: Parameters<express.Response['sendFile']>[1]) {
  const app = express();
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(dir, 'index.html'), options ?? {});
  });
  return app;
}

async function statusFrom(app: express.Express, urlPath: string): Promise<number> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}${urlPath}`);
    return res.status;
  } finally {
    server.close();
  }
}

/** A checkout under a hidden directory, which is what broke. */
function hiddenCheckout(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jellygram-shell-'));
  const dir = path.join(base, '.local', 'share', 'jellygram', 'public');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>shell</title>');
  return dir;
}

test('a shell served from a hidden directory is refused without dotfiles: allow', async () => {
  // Not the application's behaviour — `send`'s. Asserted so that the reason
  // the option is there does not become a mystery somebody deletes.
  const dir = hiddenCheckout();
  assert.equal(await statusFrom(shellApp(dir), '/'), 404);
});

test('and is served with it', async () => {
  const dir = hiddenCheckout();
  assert.equal(await statusFrom(shellApp(dir, { dotfiles: 'allow' }), '/'), 200);
});

test('a deep client-side route from a hidden directory still reaches the shell', async () => {
  const dir = hiddenCheckout();
  assert.equal(await statusFrom(shellApp(dir, { dotfiles: 'allow' }), '/media/42'), 200);
});

test('an ordinary path is unaffected either way', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jellygram-shell-plain-'));
  fs.writeFileSync(path.join(base, 'index.html'), '<!doctype html><title>shell</title>');
  assert.equal(await statusFrom(shellApp(base), '/'), 200);
  assert.equal(await statusFrom(shellApp(base, { dotfiles: 'allow' }), '/'), 200);
});

test('the server passes dotfiles: allow on every shell route it serves', async () => {
  // Three call sites: /app, the /app/* fallback, and the SPA catch-all. If one
  // is added without the option, the Mini App or a refreshed dashboard breaks
  // on a hidden-directory installation and nothing else notices.
  const source = await fs.promises.readFile(
    path.join(import.meta.dirname, '..', '..', 'src', 'api', 'server.ts'),
    'utf8',
  );
  // Non-greedy to the statement's `);` — the argument itself contains parens.
  const calls = source.match(/res\.sendFile\([\s\S]*?\);/g) ?? [];
  assert.ok(calls.length >= 3, `expected at least three sendFile calls, found ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /shellFile/, `sendFile without shellFile options: ${call}`);
  }
});
