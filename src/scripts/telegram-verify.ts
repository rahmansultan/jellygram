import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { stdout } from 'node:process';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { closePool } from '../db/pool.js';
import {
  LOCAL_BOT_API_FILE_LIMIT,
  PUBLIC_BOT_API_FILE_LIMIT,
  botApiFileLimit,
  effectiveMaxFileSize,
} from '../services/download.js';
import { formatBytes, diskUsage } from '../services/storage.js';

/**
 * Prove which Bot API the application is actually talking to.
 *
 * The decisive evidence is a pair: getMe succeeds against the configured local
 * endpoint, *and* the cloud API rejects the same token. Only a bot that has
 * been logged out of the cloud and picked up locally produces both.
 *
 *   npm run telegram:verify
 *
 * The token is never printed.
 */

const log = createLogger('cli');
const CLOUD_API = 'https://api.telegram.org';

let failures = 0;
let warnings = 0;

function say(text = ''): void {
  stdout.write(`${text}\n`);
}

function pass(name: string, detail = ''): void {
  say(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name: string, detail = ''): void {
  failures += 1;
  say(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

function warn(name: string, detail = ''): void {
  warnings += 1;
  say(`  WARN  ${name}${detail ? ` — ${detail}` : ''}`);
}

interface TelegramResponse {
  ok?: boolean;
  result?: unknown;
  description?: string;
}

async function callApi(root: string, method: string): Promise<{ status: number; body: TelegramResponse }> {
  try {
    const res = await fetch(`${root}/bot${config.telegram.botToken}/${method}`, {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as TelegramResponse;
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: { description: (err as Error).message } };
  }
}

function tcpReachable(host: string, port: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function main(): Promise<void> {
  say();
  say('Telegram Bot API verification');
  say('=============================');
  say();

  if (!config.telegram.configured) {
    say('TELEGRAM_BOT_TOKEN is not set in .env.');
    process.exitCode = 2;
    return;
  }

  const apiRoot = config.telegram.apiRoot;
  const isLocalRoot = !/api\.telegram\.org/i.test(apiRoot);

  // -----------------------------------------------------------------------
  say('1. Configuration');
  say(`  API endpoint : ${apiRoot}`);
  say(`  Local mode   : ${config.telegram.localMode}`);
  say(`  Max file size: ${formatBytes(effectiveMaxFileSize())}`);
  say();

  if (config.telegram.localMode && !isLocalRoot) {
    fail(
      'local mode is consistent',
      'TELEGRAM_LOCAL_MODE=true but TELEGRAM_API_ROOT still points at api.telegram.org',
    );
  } else if (!config.telegram.localMode && isLocalRoot) {
    fail(
      'local mode is consistent',
      'TELEGRAM_API_ROOT points at a local server but TELEGRAM_LOCAL_MODE=false',
    );
  } else {
    pass('local mode and endpoint agree');
  }

  // -----------------------------------------------------------------------
  say();
  say('2. Local Bot API server');

  if (!config.telegram.localMode) {
    warn('not enabled', `still on the public Bot API, so the ceiling is ${formatBytes(PUBLIC_BOT_API_FILE_LIMIT)}`);
  } else {
    const url = new URL(apiRoot);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const reachable = await tcpReachable(url.hostname, port);

    if (reachable) pass('server is listening', `${url.hostname}:${port}`);
    else fail('server is listening', `nothing accepts connections on ${url.hostname}:${port}`);

    const local = await callApi(apiRoot, 'getMe');
    if (local.body.ok) {
      const user = local.body.result as { username?: string; id?: number };
      pass('getMe succeeds through the local server', `@${user.username ?? '?'} (id ${user.id ?? '?'})`);
    } else {
      fail(
        'getMe succeeds through the local server',
        local.body.description ?? `HTTP ${local.status}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  say();
  say('3. Cloud Bot API');

  // Any authenticated call to the cloud API logs the bot back IN, undoing the
  // logOut that local mode depends on. So this check is skipped by default:
  // probing it would break the very property it claims to verify.
  if (!config.telegram.localMode) {
    const cloud = await callApi(CLOUD_API, 'getMe');
    if (cloud.body.ok) {
      pass('cloud API accepts the token', 'expected while still on the public Bot API');
    } else {
      warn('cloud API status unclear', cloud.body.description ?? `HTTP ${cloud.status}`);
    }
  } else if (process.argv.includes('--check-cloud')) {
    say('  Probing the cloud API as requested. This RE-LOGS the bot in;');
    say('  run `npm run telegram:logout` afterwards.');
    const cloud = await callApi(CLOUD_API, 'getMe');
    const loggedOut = cloud.status === 401 || /logged out/i.test(cloud.body.description ?? '');
    if (loggedOut) {
      pass('cloud API no longer serves this bot', cloud.body.description ?? 'token rejected');
    } else {
      warn(
        'cloud API still accepts the token',
        'run `npm run telegram:logout` so updates go to the local server',
      );
    }
  } else {
    pass(
      'skipped by design',
      'probing the cloud would re-login the bot; pass --check-cloud to force it',
    );
  }

  // -----------------------------------------------------------------------
  say();
  say('4. Local data directory');

  if (config.telegram.localMode) {
    const hostRoot = path.resolve(config.telegram.localHostRoot);
    say(`  Container path: ${config.telegram.localFileRoot}`);
    say(`  Host path     : ${hostRoot}`);

    try {
      const stat = await fsp.stat(hostRoot);
      if (!stat.isDirectory()) throw new Error('not a directory');
      pass('host data directory exists');
    } catch {
      fail('host data directory exists', `${hostRoot} is missing`);
    }

    // The worker must be able to remove the server's copy after moving it,
    // or the directory grows by one movie per upload.
    try {
      const probe = path.join(hostRoot, `.write-probe-${process.pid}`);
      await fsp.writeFile(probe, 'x');
      await fsp.unlink(probe);
      pass('host data directory is writable by this user');
    } catch (err) {
      fail('host data directory is writable by this user', (err as Error).message);
    }

    // A rename across filesystems silently degrades to a full copy of a
    // multi-gigabyte file, so check the two directories match.
    try {
      const [a, b] = await Promise.all([fsp.stat(hostRoot), fsp.stat(config.storage.downloadTmpDir)]);
      if (a.dev === b.dev) {
        pass('data directory and download directory share a filesystem', 'moves are instant');
      } else {
        warn(
          'data directory and download directory are on different filesystems',
          'each file will be copied rather than moved',
        );
      }
    } catch {
      warn('could not compare filesystems');
    }
  } else {
    say('  (not applicable while on the public Bot API)');
  }

  // -----------------------------------------------------------------------
  say();
  say('5. Capacity');

  say(`  Transport ceiling : ${formatBytes(botApiFileLimit())}`);
  say(`  Configured ceiling: ${formatBytes(config.storage.maxFileSizeBytes)}`);
  say(`  Enforced ceiling  : ${formatBytes(effectiveMaxFileSize())}`);

  if (config.telegram.localMode && effectiveMaxFileSize() < LOCAL_BOT_API_FILE_LIMIT) {
    warn(
      'configured ceiling is below the transport ceiling',
      `raise MAX_FILE_SIZE_BYTES to ${LOCAL_BOT_API_FILE_LIMIT} for the full ${formatBytes(LOCAL_BOT_API_FILE_LIMIT)}`,
    );
  } else if (config.telegram.localMode) {
    pass('the full 2000 MB is accepted');
  }

  const disk = await diskUsage(config.storage.mediaRoot);
  const headroom =
    effectiveMaxFileSize() + config.storage.diskSafetyMarginBytes + config.storage.minFreeDiskBytes;

  if (disk.availableBytes >= headroom) {
    pass(
      'enough free disk for a maximum-size upload',
      `${formatBytes(disk.availableBytes)} free, ${formatBytes(headroom)} needed`,
    );
  } else {
    fail(
      'enough free disk for a maximum-size upload',
      `${formatBytes(disk.availableBytes)} free, ${formatBytes(headroom)} needed`,
    );
  }

  // -----------------------------------------------------------------------
  say();
  say('=============================');
  say(failures === 0 ? `OK${warnings ? ` (${warnings} warning(s))` : ''}` : `${failures} check(s) failed`);
  say();
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    log.error({ err }, 'Verification failed');
    say(`Failed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
