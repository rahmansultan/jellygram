#!/usr/bin/env node
/**
 * JellyGram uploader.
 *
 * Select a file once. The uploader checks its size and chooses for you:
 *
 *     size ≤ 2 GiB   →  sent whole, in one request
 *     2 GiB < size ≤ 5 GiB  →  streamed as parts, reassembled by the server
 *     size > 5 GiB   →  refused, with the reason
 *
 * Parts are read as byte ranges straight from the original file, so nothing is
 * ever split to disk, no temporary files are created, and the original is
 * opened read-only and never modified.
 *
 * It is deliberately dependency-free: copy this one file to any machine with
 * Node 22 and it runs.
 *
 *   node jellygram-upload.mjs --login             configure server and token
 *   node jellygram-upload.mjs                     pick a file from the current directory
 *   node jellygram-upload.mjs "Movie.mkv"         upload that file
 *   node jellygram-upload.mjs --dir ~/Videos      pick from another directory
 */

import fs from 'node:fs';
import { Transform } from 'node:stream';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const CONFIG_PATH =
  process.env.JELLYGRAM_CONFIG ?? path.join(os.homedir(), '.config', 'jellygram-upload.json');

const VIDEO_EXTENSIONS = new Set(['mp4', 'mkv', 'avi', 'mov']);

/** Per-part retry policy for transient network failures. */
const MAX_PART_ATTEMPTS = 5;
const RETRY_BASE_MS = 2000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const say = (text = '') => stdout.write(`${text}\n`);

function bytes(n) {
  if (!Number.isFinite(n)) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.abs(n);
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${(n < 0 ? '-' : '') + v.toFixed(v >= 100 || u === 0 ? 0 : 1)} ${units[u]}`;
}

function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? '') : undefined;
}

const has = (name) => process.argv.includes(`--${name}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wrap a readable so bytes can be counted as they pass through.
 *
 * Attaching a 'data' listener to the source instead would put it into flowing
 * mode and consume the chunks before fetch could read them, which silently
 * sends an empty body.
 */
function counted(source, onBytes) {
  let total = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      onBytes(total);
      cb(null, chunk);
    },
  });
  source.on('error', (err) => meter.destroy(err));
  return source.pipe(meter);
}

/** A single-line progress bar that rewrites itself in place. */
function renderProgress(label, done, total, startedAt) {
  if (!stdout.isTTY) return;
  const width = 28;
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  const filled = Math.round(ratio * width);
  const elapsed = (Date.now() - startedAt) / 1000;
  const rate = elapsed > 0 ? done / elapsed : 0;
  const eta = rate > 0 && total > done ? (total - done) / rate : 0;

  const line =
    `  ${label} [${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ` +
    `${(ratio * 100).toFixed(0).padStart(3)}%  ` +
    `${bytes(done)} / ${bytes(total)}  ` +
    `${bytes(rate)}/s  ETA ${duration(eta)}`;

  stdout.write(`\r${line.padEnd(process.stdout.columns ? process.stdout.columns - 1 : 110).slice(0, 200)}`);
}

function endProgress() {
  if (stdout.isTTY) stdout.write('\n');
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

async function loadConfig() {
  // Flags first, then the environment, then the saved file: the command line
  // is the most deliberate of the three. Both flags were already swallowed by
  // the argument parser; they simply never reached here.
  const fromEnv = {
    server: flag('server') ?? process.env.JELLYGRAM_SERVER,
    token: flag('token') ?? process.env.JELLYGRAM_TOKEN,
  };
  if (fromEnv.server && fromEnv.token) return fromEnv;

  try {
    const raw = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
    return { server: fromEnv.server ?? raw.server, token: fromEnv.token ?? raw.token };
  } catch {
    return fromEnv;
  }
}

async function saveConfig(cfg) {
  await fsp.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fsp.writeFile(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  await fsp.chmod(CONFIG_PATH, 0o600);
}

/**
 * Ask for the server address and token, without echoing the token.
 *
 * The token grants the ability to add media to one user's library, so it is
 * treated like any other secret: never displayed, stored owner-readable only.
 */
async function login() {
  const existing = await loadConfig();
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });

  say();
  say('JellyGram uploader — setup');
  say('='.repeat(26));
  say();
  say(`Config file: ${CONFIG_PATH}`);
  say('Press Enter to keep an existing value.');
  say();

  const serverAnswer = (
    await rl.question(`Server URL${existing.server ? ` [${existing.server}]` : ''}: `)
  ).trim();
  rl.close();
  stdin.pause();

  const server = (serverAnswer || existing.server || '').replace(/\/+$/, '');
  if (!server) {
    say('\nA server URL is required, for example http://media-server.local:8300\n');
    process.exitCode = 2;
    return;
  }

  const token = (await askSecret(`Upload token${existing.token ? ' [unchanged]' : ''}: `)).trim();
  const finalToken = token || existing.token;
  if (!finalToken) {
    say('\nAn upload token is required. Ask the administrator to run:');
    say('  npm run upload:token -- --user <your name>\n');
    process.exitCode = 2;
    return;
  }

  say('\nChecking…');
  const cfg = { server, token: finalToken };
  const hello = await api(cfg, 'GET', '/hello').catch((err) => {
    say(`\nCould not reach the server: ${err.message}\n`);
    process.exitCode = 1;
    return null;
  });
  if (!hello) return;

  await saveConfig(cfg);
  say(`\nConnected as ${hello.user.name}.`);
  say(`Saved to ${CONFIG_PATH} (owner-readable only).`);
  say();
  say(`Files up to ${bytes(hello.limits.singleMaxBytes)} are sent whole.`);
  say(
    `Larger files up to ${bytes(hello.limits.maxAssembledBytes)} are split automatically ` +
      `into ${bytes(hello.limits.partBytes)} parts.`,
  );
  say();
}

/** Read a value without echoing it, when attached to a terminal. */
async function askSecret(question) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  }

  return new Promise((resolve) => {
    stdout.write(question);
    const wasRaw = stdin.isRaw === true;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const done = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done();
        if (ch === '\u0003') {
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (ch >= ' ' && ch !== '\u001b') {
          value += ch;
          stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

// ---------------------------------------------------------------------------
// Server calls
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function api(cfg, method, route, { json, headers = {}, body, signal } = {}) {
  const res = await fetch(`${cfg.server}/api/upload${route}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : body,
    duplex: body ? 'half' : undefined,
    signal,
  });

  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: text.slice(0, 300) };
    }
  }

  if (!res.ok) {
    throw new ApiError(parsed?.error ?? `HTTP ${res.status}`, res.status, parsed);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// File selection
// ---------------------------------------------------------------------------

async function pickFile(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
    if (!VIDEO_EXTENSIONS.has(ext)) continue;
    const stat = await fsp.stat(path.join(dir, entry.name));
    candidates.push({ name: entry.name, size: stat.size });
  }

  candidates.sort((a, b) => a.name.localeCompare(b.name));

  if (candidates.length === 0) {
    say(`\nNo video files found in ${dir}`);
    say(`Accepted types: ${[...VIDEO_EXTENSIONS].join(', ')}`);
    say('Pass a path directly, or use --dir to look elsewhere.\n');
    return null;
  }

  say();
  say(`Videos in ${dir}`);
  say('─'.repeat(Math.min(60, (process.stdout.columns ?? 60) - 1)));
  candidates.forEach((c, i) => {
    say(`  ${String(i + 1).padStart(2)}. ${c.name}  (${bytes(c.size)})`);
  });
  say();

  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
  const answer = (await rl.question('Which file? (number, or blank to cancel): ')).trim();
  rl.close();

  if (!answer) return null;
  const index = Number(answer);
  if (!Number.isInteger(index) || index < 1 || index > candidates.length) {
    say('That is not one of the listed numbers.');
    return null;
  }
  return path.join(dir, candidates[index - 1].name);
}

// ---------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------

/** Send a file that fits under the single-upload ceiling, in one request. */
async function uploadSingle(cfg, filePath, size) {
  const filename = path.basename(filePath);
  const startedAt = Date.now();
  let sent = 0;

  // Read-only stream: the original is never opened for writing.
  const body = counted(
    fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 }),
    (total) => {
      sent = total;
      renderProgress('upload', sent, size, startedAt);
    },
  );

  const result = await api(cfg, 'PUT', '/single', {
    headers: {
      'x-upload-filename': encodeHeader(filename),
      'x-upload-size': String(size),
      'content-type': 'application/octet-stream',
    },
    body,
  });

  renderProgress('upload', size, size, startedAt);
  endProgress();
  return result;
}

/**
 * Send a large file as parts.
 *
 * Each part is a byte range of the original, streamed directly — no temporary
 * files are written anywhere on this machine.
 */
async function uploadMultipart(cfg, filePath, size, begun) {
  const { sessionId, plan } = begun;
  const already = new Set(begun.receivedParts ?? []);

  if (already.size > 0) {
    say(`  Resuming: ${already.size} of ${plan.partCount} parts are already on the server.`);
  }

  const startedAt = Date.now();
  let sentTotal = [...already].reduce(
    (sum, n) => sum + partLength(n, plan.partCount, plan.partSize, size),
    0,
  );

  for (let partNumber = 1; partNumber <= plan.partCount; partNumber += 1) {
    if (already.has(partNumber)) continue;

    const start = (partNumber - 1) * plan.partSize;
    const length = partLength(partNumber, plan.partCount, plan.partSize, size);
    const end = start + length - 1;

    let attempt = 0;
    for (;;) {
      attempt += 1;
      let sentThisPart = 0;
      try {
        const body = counted(
          fs.createReadStream(filePath, { start, end, highWaterMark: 4 * 1024 * 1024 }),
          (total) => {
            sentThisPart = total;
            renderProgress(
              `part ${partNumber}/${plan.partCount}`,
              sentTotal + sentThisPart,
              size,
              startedAt,
            );
          },
        );

        const res = await api(cfg, 'PUT', `/part/${sessionId}/${partNumber}`, {
          headers: {
            'x-upload-size': String(length),
            'content-type': 'application/octet-stream',
          },
          body,
        });

        sentTotal += length;
        renderProgress(`part ${partNumber}/${plan.partCount}`, sentTotal, size, startedAt);
        if (res.alreadyPresent) {
          // The server already had it; nothing was resent.
        }
        break;
      } catch (err) {
        // A rejected part (bad request, session closed) will not improve with
        // another attempt; only transport failures are worth retrying.
        const retryable = !(err instanceof ApiError) || err.status >= 500 || err.status === 0;

        if (!retryable || attempt >= MAX_PART_ATTEMPTS) {
          endProgress();
          throw new Error(
            `Part ${partNumber} failed after ${attempt} attempt(s): ${err.message}`,
          );
        }

        const wait = RETRY_BASE_MS * attempt;
        endProgress();
        say(`  Part ${partNumber} failed (${err.message}); retrying in ${Math.round(wait / 1000)}s…`);
        await sleep(wait);
      }
    }
  }

  endProgress();
  say('  All parts sent. Asking the server to reassemble…');
  await api(cfg, 'POST', `/complete/${sessionId}`, { json: {} });
  return { sessionId };
}

/** Length of one part, accounting for a short final part. */
function partLength(partNumber, partCount, partSize, totalSize) {
  return partNumber === partCount ? totalSize - (partCount - 1) * partSize : partSize;
}

/** Header values must be latin-1; percent-encode anything else. */
function encodeHeader(value) {
  // eslint-disable-next-line no-control-regex
  return /^[ -~]*$/.test(value) ? value : encodeURIComponent(value);
}

/** Poll until the server finishes processing, so the exit status is meaningful. */
async function waitForOutcome(cfg, { sessionId, uploadId }, timeoutMs = 30 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';

  while (Date.now() < deadline) {
    let state;
    try {
      state = sessionId
        ? await api(cfg, 'GET', `/session/${sessionId}`)
        : await api(cfg, 'GET', `/upload/${uploadId}`);
    } catch {
      await sleep(3000);
      continue;
    }

    const status = sessionId ? (state.upload?.status ?? state.status) : state.status;
    if (status !== lastStatus) {
      say(`  ${status.toLowerCase().replace(/_/g, ' ')}…`);
      lastStatus = status;
    }

    if (['COMPLETED', 'FAILED', 'DUPLICATE', 'CANCELLED'].includes(status)) {
      const title = sessionId ? state.upload?.detectedTitle : state.detectedTitle;
      const error = sessionId ? (state.upload?.error ?? state.errorMessage) : state.error;
      return { status, title, error };
    }
    if (['FAILED', 'EXPIRED'].includes(state.status)) {
      return { status: state.status, error: state.errorMessage };
    }

    await sleep(3000);
  }
  return { status: 'TIMEOUT' };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (has('help') || has('h')) {
    say(
      [
        '',
        'JellyGram uploader',
        '',
        '  node jellygram-upload.mjs --login          configure server and token',
        '  node jellygram-upload.mjs                  choose a file in this directory',
        '  node jellygram-upload.mjs <file>           upload that file',
        '  node jellygram-upload.mjs --dir <path>     choose a file elsewhere',
        '  node jellygram-upload.mjs <file> --no-wait send it and exit immediately',
        '',
      ].join('\n'),
    );
    return;
  }

  if (has('login')) return login();

  const cfg = await loadConfig();
  if (!cfg.server || !cfg.token) {
    say('\nNot configured yet. Run:\n\n  node jellygram-upload.mjs --login\n');
    process.exitCode = 2;
    return;
  }

  // A positional argument is the file; everything else is a flag.
  const positional = process.argv.slice(2).filter((a, i, all) => {
    if (a.startsWith('--')) return false;
    const previous = all[i - 1];
    return !(previous && previous.startsWith('--') && ['dir', 'server', 'token'].includes(previous.slice(2)));
  });

  let filePath = positional[0];
  if (!filePath) {
    filePath = await pickFile(path.resolve(flag('dir') ?? process.cwd()));
    if (!filePath) return;
  }
  filePath = path.resolve(filePath);

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    say(`\nNo such file: ${filePath}\n`);
    process.exitCode = 1;
    return;
  }
  if (!stat.isFile()) {
    say(`\nNot a file: ${filePath}\n`);
    process.exitCode = 1;
    return;
  }

  const filename = path.basename(filePath);
  const size = stat.size;

  say();
  say(`File : ${filename}`);
  say(`Size : ${bytes(size)}`);

  // --- The server decides the mode from the size, before any bytes move ----
  let begun;
  try {
    begun = await api(cfg, 'POST', '/begin', { json: { filename, size } });
  } catch (err) {
    if (err.status === 413) {
      say(`\n✗ Refused: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    say(`\n✗ ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  const { plan } = begun;
  say(
    `Mode : ${
      plan.mode === 'single'
        ? 'single upload'
        : `multi-part — ${plan.partCount} parts of up to ${bytes(plan.partSize)}`
    }`,
  );
  say();

  let handle;
  try {
    if (begun.mode === 'single') {
      const result = await uploadSingle(cfg, filePath, size);
      handle = { uploadId: result.uploadId };
    } else {
      const result = await uploadMultipart(cfg, filePath, size, begun);
      handle = { sessionId: result.sessionId };
    }
  } catch (err) {
    say(`\n✗ Upload failed: ${err.message}`);
    if (begun.sessionId) {
      say(`  The parts already sent are kept. Run the same command again to resume.\n`);
    } else {
      say('');
    }
    process.exitCode = 1;
    return;
  }

  say('  Sent.');

  if (has('no-wait')) {
    say('\nThe server is processing it. Check Telegram or the dashboard for the result.\n');
    return;
  }

  say('\nWaiting for the server to finish…');
  const outcome = await waitForOutcome(cfg, handle);

  say();
  if (outcome.status === 'COMPLETED') {
    say(`✓ Done${outcome.title ? `: ${outcome.title}` : ''}`);
    say('  It is in your Jellyfin library.');
  } else if (outcome.status === 'DUPLICATE') {
    say('⚠ Already in your library; nothing was changed.');
  } else if (outcome.status === 'TIMEOUT') {
    say('… Still processing. Check the dashboard for the result.');
  } else {
    say(`✗ ${outcome.status}${outcome.error ? `: ${outcome.error}` : ''}`);
    process.exitCode = 1;
  }
  say();
}

main().catch((err) => {
  endProgress();
  say(`\n✗ ${err.message}\n`);
  process.exitCode = 1;
});
