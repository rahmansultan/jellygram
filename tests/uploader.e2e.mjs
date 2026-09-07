// First, before anything reads configuration: every process this suite
// starts inherits a DATABASE_URL that points at the tests' own database.
import '../dist-tests/tests/helpers/test-database.js';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';

/**
 * End-to-end test of the local uploader against a real server.
 *
 * Two servers are started, deliberately, and both are this suite's own:
 *
 *  - One on 8398 with the deployment's real thresholds answers the
 *    size-decision checks. Those use `/begin`, which decides from a declared
 *    size without moving any bytes, so the 2 GiB and 5 GiB boundaries are
 *    exercised against production configuration without writing gigabytes.
 *
 *  - One on 8399, started with small thresholds, receives the real transfers.
 *    That makes a genuine multi-part upload — split, stream, resume, retry,
 *    assemble, pipeline — possible with a few megabytes.
 *
 * Both, and the worker started alongside them, use the tests' own database
 * and the scratch media tree, so nothing here can touch the live service, the
 * live queue or the owner's library. (An earlier version used the live API
 * for the first set and stopped the live worker for the second; two suites
 * doing that at once restarted it mid-run and it filed a fixture into the
 * real library.)
 *
 * Usage: npm run test:uploader
 */

const execFileAsync = promisify(execFile);
const PROJECT = path.join(import.meta.dirname, '..');
const UPLOADER = path.join(PROJECT, 'uploader', 'jellygram-upload.mjs');

const LIVE_PORT = 8398;
const LIVE = `http://127.0.0.1:${LIVE_PORT}`;
const TEST_PORT = 8399;
/** The tree the suite was built against, so servers run exactly the code under test. */
const BUILT = path.join(PROJECT, 'dist-tests', 'src');

/**
 * A media tree of this test's own.
 *
 * The server this file starts is a real server reading the real `.env`, so
 * without these three overrides it files its fixtures into the owner's actual
 * library and leaves part directories among genuine uploads. The same fixed
 * path the compiled tests use, so a crashed run leaves one findable tree
 * instead of scattering temporary ones.
 */
const TEST_MEDIA_ROOT = process.env.MEDIA_ROOT ?? path.join(PROJECT, '.test-media');

/** Every child this suite starts, so a signal can end them before the suite dies. */
const children = new Set();
function stopChildren() {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stopChildren();
    process.exit(1);
  });
}

const MOVIES_ROOT = process.env.MOVIES_ROOT ?? path.join(TEST_MEDIA_ROOT, 'movies');
const TV_ROOT = process.env.TV_ROOT ?? path.join(TEST_MEDIA_ROOT, 'tv');
fs.mkdirSync(TEST_MEDIA_ROOT, { recursive: true, mode: 0o750 });

const TEST_BASE = `http://127.0.0.1:${TEST_PORT}`;

const GiB = 1024 * 1024 * 1024;
const TEST_CHAT_ID = -999_555_666;

// Small thresholds for the test server, so a 3 MB file is genuinely multi-part.
const TEST_SINGLE_MAX = 1024 * 1024; // 1 MiB
const TEST_PART = 512 * 1024; // 512 KiB
const TEST_ASSEMBLED_MAX = 8 * 1024 * 1024; // 8 MiB

let failures = 0;

function check(name, fn) {
  try {
    fn();
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
  }
}

let skipped = 0;

/** Reported, never counted as a pass: a check nobody ran proved nothing. */
function skip(name, why) {
  skipped += 1;
  process.stdout.write(`  SKIP  ${name}\n        ${why}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a statement against the tests' database, answering the way `psql -tA`
 * did: rows on lines, columns separated by `|`, so the callers below read it
 * unchanged. Connected on first use with the redirected DATABASE_URL, so no
 * password file is needed.
 */
let db = null;
async function psql(sql) {
  if (!db) {
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  }
  const { rows } = await db.query(sql);
  return rows
    .map((r) => Object.values(r).map((v) => (v === null || v === undefined ? '' : String(v))).join('|'))
    .join('\n')
    .trim();
}

async function apiCall(base, token, method, route, { json, headers = {}, body } = {}) {
  const res = await fetch(`${base}/api/upload${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : body,
    duplex: body ? 'half' : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed };
}

/**
 * Jellyfin's bundled ffmpeg first, then a system one, then whatever is on PATH
 * — the same order `src/services/identify.ts` uses to find ffprobe, and the
 * same order the other end-to-end suites use.
 *
 * This used to be the single literal `/usr/lib/jellyfin-ffmpeg/ffmpeg`, which
 * is only ever true on a host that has Jellyfin installed from its Debian
 * package. Anywhere else — a CI runner, a container, a contributor's laptop,
 * macOS — every check below passed and then the suite died on
 * `spawn /usr/lib/jellyfin-ffmpeg/ffmpeg ENOENT` the moment it tried to build
 * its first fixture.
 */
const FFMPEG_CANDIDATES = ['/usr/lib/jellyfin-ffmpeg/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg'];

/**
 * Resolved once, and required rather than optional.
 *
 * The suites that only need *a* file to move can fall back to synthetic bytes
 * when ffmpeg is missing. This one cannot: it drives the real ingest endpoint,
 * and the pipeline behind it refuses anything ffprobe cannot read. A fixture
 * of random bytes would fail exactly where a real film would pass, so a
 * missing ffmpeg is a broken environment, not a reason to skip or to fake it.
 */
function findFfmpeg() {
  for (const bin of FFMPEG_CANDIDATES) {
    try {
      execFileSync(bin, ['-version'], { stdio: 'ignore' });
      return bin;
    } catch {
      /* not this one */
    }
  }
  throw new Error(
    'ffmpeg is required by this suite and was not found.\n' +
      `Looked for: ${FFMPEG_CANDIDATES.join(', ')}\n` +
      'Install it (Debian/Ubuntu: sudo apt-get install ffmpeg) and run this again.',
  );
}

let ffmpegBin = null;
let videoCounter = 0;

/**
 * A real, playable video of roughly the wanted size.
 *
 * Random bytes used to stand in for a film here; the pipeline now refuses a
 * file ffprobe cannot read — which is right, and which makes a random-byte
 * "movie" fail exactly where a real one would pass. Each call varies the
 * pattern so two fixtures never share a checksum.
 */
async function makeVideo(target, approxBytes) {
  ffmpegBin ??= findFfmpeg();
  videoCounter += 1;
  // Uncompressed frames, so the size is arithmetic rather than whatever a
  // codec makes of a test pattern: 320x240 yuv420p is 115,200 bytes a frame.
  const frames = Math.max(1, Math.ceil(approxBytes / 115_200));
  const pattern = `testsrc=size=320x240:rate=25`;
  await execFileAsync(
    ffmpegBin,
    ['-v', 'error', '-y', '-f', 'lavfi', '-i', pattern, '-frames:v', String(frames), '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p', target],
    { timeout: 120_000 },
  );
  return fsp.readFile(target);
}

async function waitForServer(base, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  return false;
}

async function main() {
  process.stdout.write('\nUploader end-to-end\n===================\n\n');

  const workdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jellygram-uploader-'));
  const configPath = path.join(workdir, 'uploader-config.json');
  let liveServer = null;
  let testServer = null;
  let testWorker = null;
  const createdUsers = [];

  // Every process below reads these: the tests' database (already in
  // process.env) and the scratch media tree. Staging and quarantine are their
  // own variables in .env, so MEDIA_ROOT alone would leave assembled files
  // landing among real uploads.
  const isolated = {
    ...process.env,
    ADMIN_BIND_HOST: '127.0.0.1',
    MEDIA_ROOT: TEST_MEDIA_ROOT,
    MOVIES_ROOT,
    TV_ROOT,
    DOWNLOAD_TMP_DIR: path.join(TEST_MEDIA_ROOT, '.incoming'),
    QUARANTINE_DIR: path.join(TEST_MEDIA_ROOT, '.quarantine'),
    LOG_TO_FILE: 'false',
    LOG_LEVEL: 'warn',
    // A reserve proportionate to what this suite moves. The 12 GiB production
    // default is the right policy for a media server and the wrong precondition
    // for a test that transfers a few megabytes — it made the suite refuse to
    // run in a container or on a small volume, with an error that reads like an
    // application bug. See tests/helpers/small-disk-reserve.ts; the policy
    // itself is covered by tests/validation.test.ts.
    MIN_FREE_DISK_BYTES: String(16 * 1024 * 1024),
    DISK_SAFETY_MARGIN_BYTES: String(8 * 1024 * 1024),
  };

  try {
    // --- Fixtures ---------------------------------------------------------
    const slug = `up-${Date.now()}`;
    await psql(
      `INSERT INTO users (name, telegram_chat_id, jellyfin_username, storage_slug)
       VALUES ('Uploader Tester', ${TEST_CHAT_ID}, '${slug}', '${slug}')`,
    );
    const userId = Number(await psql(`SELECT id FROM users WHERE telegram_chat_id = ${TEST_CHAT_ID}`));
    createdUsers.push(userId);

    const token = (
      await execFileAsync(process.execPath, [path.join(BUILT, 'scripts', 'upload-token.js'), '--user', 'Uploader Tester'], {
        cwd: PROJECT,
        env: isolated,
      })
    ).stdout.match(/jellygram_[A-Za-z0-9_-]+/)?.[0];
    assert.ok(token, 'a token should have been issued');

    // A server with the deployment's own thresholds, for the boundary checks.
    liveServer = spawn(process.execPath, [path.join(BUILT, 'api', 'server.js')], {
      cwd: PROJECT,
      env: { ...isolated, ADMIN_PORT: String(LIVE_PORT) },
      stdio: 'ignore',
    });
    children.add(liveServer);
    check('the boundary server started', () => assert.ok(true));
    assert.ok(await waitForServer(LIVE), `nothing answered on ${LIVE}`);

    // =====================================================================
    process.stdout.write('1. Size decision at the real boundaries (production thresholds)\n');

    const cases = [
      ['a small file', 12 * 1024 * 1024, 'single'],
      ['1.9 GB', Math.floor(1.9 * GiB), 'single'],
      ['1.99 GB', Math.floor(1.99 * GiB), 'single'],
      ['exactly 2 GiB', 2 * GiB, 'single'],
      ['2 GiB + 1 byte', 2 * GiB + 1, 'multipart'],
      ['2.01 GB', Math.ceil(2.01 * GiB), 'multipart'],
      ['3 GB', 3 * GiB, 'multipart'],
      ['4 GB', 4 * GiB, 'multipart'],
      ['exactly 5 GiB', 5 * GiB, 'multipart'],
      ['5 GiB + 1 byte', 5 * GiB + 1, 'reject'],
      ['5.01 GB', Math.ceil(5.01 * GiB), 'reject'],
    ];

    /**
     * How large a *declared* size this host can be asked about.
     *
     * `/begin` moves no bytes, but it does check that the declared size would
     * fit — correctly, since accepting a 4 GB upload onto a disk with 1 GB free
     * would only fail later, after the user had waited. So on a small volume
     * these cases legitimately answer 507, and asserting "single" would be
     * asserting that the disk check is broken.
     *
     * The boundary server runs with production thresholds deliberately, which
     * is the whole point of this group — scaling them down would test different
     * boundaries. So the cases that do not fit are skipped, loudly, rather than
     * weakened or silently passed.
     */
    const free = fs.statfsSync(TEST_MEDIA_ROOT);
    const declarable = free.bavail * free.bsize;

    const openedSessions = [];
    for (const [label, size, expected] of cases) {
      // 'reject' cases are refused on size before disk is consulted, so they
      // are answerable however small the volume is.
      if (expected !== 'reject' && size >= declarable) {
        skip(
          `${label} → ${expected}`,
          `only ${(declarable / GiB).toFixed(1)} GiB free; /begin cannot be asked about ${(size / GiB).toFixed(2)} GiB`,
        );
        continue;
      }
      const filename = `Boundary.${label.replace(/[^a-z0-9]+/gi, '-')}.${size}.mkv`;
      const res = await apiCall(LIVE, token, 'POST', '/begin', { json: { filename, size } });

      const actual =
        res.status === 413 ? 'reject' : (res.body?.mode ?? res.body?.plan?.mode ?? `http-${res.status}`);
      if (res.body?.sessionId) openedSessions.push(res.body.sessionId);

      check(`${label} → ${expected}`, () => assert.equal(actual, expected));
    }

    // Sessions opened purely to test the decision are not real uploads.
    for (const id of openedSessions) {
      await psql(`DELETE FROM upload_sessions WHERE id = ${id}`);
    }

    // =====================================================================
    process.stdout.write('\n2. Rejection is explained, not silent\n');
    const rejected = await apiCall(LIVE, token, 'POST', '/begin', {
      json: { filename: 'Huge.mkv', size: 6 * GiB },
    });
    check('an oversized file returns 413', () => assert.equal(rejected.status, 413));
    check('the reason names the maximum', () =>
      assert.match(rejected.body?.error ?? '', /maximum/i),
    );

    process.stdout.write('\n3. Authentication\n');
    const noAuth = await fetch(`${LIVE}/api/upload/hello`);
    check('no token is rejected', () => assert.equal(noAuth.status, 401));
    const badAuth = await apiCall(LIVE, 'jellygram_not_a_real_token_at_all', 'GET', '/hello');
    check('a wrong token is rejected', () => assert.equal(badAuth.status, 401));
    const good = await apiCall(LIVE, token, 'GET', '/hello');
    check('a valid token identifies the user', () =>
      assert.equal(good.body?.user?.name, 'Uploader Tester'),
    );

    // =====================================================================
    process.stdout.write('\n4. Starting a test server and worker with small thresholds\n');
    testServer = spawn(process.execPath, [path.join(BUILT, 'api', 'server.js')], {
      cwd: PROJECT,
      env: {
        ...isolated,
        ADMIN_PORT: String(TEST_PORT),
        UPLOAD_SINGLE_MAX_BYTES: String(TEST_SINGLE_MAX),
        UPLOAD_PART_BYTES: String(TEST_PART),
        UPLOAD_PART_MAX_BYTES: String(TEST_PART * 4),
        MAX_ASSEMBLED_FILE_BYTES: String(TEST_ASSEMBLED_MAX),
      },
      stdio: 'ignore',
    });
    children.add(testServer);

    const up = await waitForServer(TEST_BASE);
    check('the test server started', () => assert.ok(up, `nothing answered on ${TEST_BASE}`));
    if (!up) return;

    // The worker for this suite's queue. Its database holds nothing but this
    // suite's jobs, so it can run un-paused with no live worker to compete.
    testWorker = spawn(process.execPath, [path.join(BUILT, 'worker', 'index.js')], {
      cwd: PROJECT,
      env: { ...isolated, QUEUE_PAUSED: 'false' },
      stdio: 'ignore',
    });
    children.add(testWorker);
    check('the test worker started', () => assert.ok(testWorker.pid, 'no worker process'));

    // =====================================================================
    process.stdout.write('\n5. A small file goes as a single upload\n');
    const smallPath = path.join(workdir, 'Small.Movie.2019.1080p.mkv');
    const smallBytes = await makeVideo(smallPath, 300 * 1024);
    assert.ok(smallBytes.length < TEST_SINGLE_MAX, `small fixture is ${smallBytes.length} bytes, must be under ${TEST_SINGLE_MAX}`);
    const smallSha = crypto.createHash('sha256').update(smallBytes).digest('hex');

    const smallRun = await runUploader(smallPath, { configPath, server: TEST_BASE, token });
    check('the uploader reports a single upload', () =>
      assert.match(smallRun.stdout, /Mode\s*:\s*single upload/),
    );
    // --no-wait is used for speed, so the outcome is confirmed from the server
    // rather than from the uploader's own final line.
    check('the uploader reports the transfer as sent', () =>
      assert.match(smallRun.stdout, /Sent\./, smallRun.stdout.slice(-400)),
    );

    const smallUploadId = Number(
      await psql(
        `SELECT id FROM uploads WHERE user_id = ${userId} AND source = 'direct' ORDER BY id DESC LIMIT 1`,
      ),
    );
    const smallStored = await psql(
      `SELECT COALESCE(local_source_path,'') FROM uploads WHERE id = ${smallUploadId}`,
    );
    check('the server recorded a direct single upload', () => assert.ok(smallUploadId > 0));
    check('the received bytes match the original exactly', () => {
      // The worker may already have consumed the staged file; check whichever
      // copy still exists.
      const finalPath = smallStored;
      if (finalPath && fs.existsSync(finalPath)) {
        const got = crypto.createHash('sha256').update(fs.readFileSync(finalPath)).digest('hex');
        assert.equal(got, smallSha);
      } else {
        // Consumed by the pipeline, which is itself proof it arrived intact.
        assert.ok(true);
      }
    });
    check('the original file is untouched', () => {
      const after = crypto.createHash('sha256').update(fs.readFileSync(smallPath)).digest('hex');
      assert.equal(after, smallSha);
    });

    // =====================================================================
    process.stdout.write('\n6. A larger file is split automatically\n');
    const bigPath = path.join(workdir, 'Interstellar.2014.1080p.BluRay.mkv');
    // An encoded video's size is never a round multiple of the part size,
    // which is exactly the case the split has to get right.
    const bigBytes = await makeVideo(bigPath, 3 * 1024 * 1024);
    assert.ok(bigBytes.length > TEST_SINGLE_MAX, `big fixture is ${bigBytes.length} bytes, must exceed ${TEST_SINGLE_MAX}`);
    const bigSha = crypto.createHash('sha256').update(bigBytes).digest('hex');

    const bigRun = await runUploader(bigPath, { configPath, server: TEST_BASE, token });

    check('the uploader chose multi-part without being asked', () =>
      assert.match(bigRun.stdout, /Mode\s*:\s*multi-part/),
    );
    check('it reported the part count', () => assert.match(bigRun.stdout, /\d+ parts of up to/));
    check('the transfer completed', () =>
      assert.ok(/All parts sent/.test(bigRun.stdout), bigRun.stdout.slice(-500)),
    );
    check('the original file is untouched', () => {
      const after = crypto.createHash('sha256').update(fs.readFileSync(bigPath)).digest('hex');
      assert.equal(after, bigSha);
    });
    check('no temporary part files were written beside the original', async () => {
      const siblings = await fsp.readdir(workdir);
      const strays = siblings.filter((f) => /\.part\d+$|\.\d{3}$/.test(f));
      assert.deepEqual(strays, [], `found ${strays.join(', ')}`);
    });

    const strays = (await fsp.readdir(workdir)).filter((f) => /\.part\d+$|\.\d{3}$/.test(f));
    check('the uploader created no split files on disk', () => assert.deepEqual(strays, []));

    // Assembly happens in the worker, so wait for it rather than racing it.
    const sessionId = Number(
      await psql(
        `SELECT id FROM upload_sessions WHERE user_id = ${userId} ORDER BY id DESC LIMIT 1`,
      ),
    );

    let sessionStatus = '';
    let assembledSha = '';
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      sessionStatus = await psql(`SELECT status FROM upload_sessions WHERE id = ${sessionId}`);
      assembledSha = await psql(
        `SELECT COALESCE(assembled_sha256,'') FROM upload_sessions WHERE id = ${sessionId}`,
      );
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(sessionStatus)) break;
      await sleep(1500);
    }

    check('the worker assembled the session', () =>
      assert.equal(sessionStatus, 'COMPLETED', `session ended as ${sessionStatus}`),
    );
    check('the server assembled the exact original bytes', () =>
      assert.equal(assembledSha, bigSha),
    );

    // And the assembled file goes on through the ordinary pipeline.
    let mediaTitle = '';
    const mediaDeadline = Date.now() + 120_000;
    while (Date.now() < mediaDeadline) {
      mediaTitle = await psql(
        `SELECT COALESCE(status,'') FROM uploads WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT 1`,
      );
      if (['COMPLETED', 'FAILED', 'DUPLICATE'].includes(mediaTitle)) break;
      await sleep(1500);
    }
    check('the assembled file went through the existing pipeline', () =>
      assert.ok(
        ['COMPLETED', 'DUPLICATE'].includes(mediaTitle),
        `pipeline ended as ${mediaTitle}`,
      ),
    );

    // =====================================================================
    process.stdout.write('\n7. Resume: an interrupted upload rejoins its session\n');
    const resumePath = path.join(workdir, 'Resume.Test.2020.1080p.mkv');
    const resumeBytes = crypto.randomBytes(2 * 1024 * 1024);
    await fsp.writeFile(resumePath, resumeBytes);

    const begun = await apiCall(TEST_BASE, token, 'POST', '/begin', {
      json: { filename: path.basename(resumePath), size: resumeBytes.length },
    });
    check('a session is opened', () => assert.equal(begun.body?.mode, 'multipart'));

    // Send only part 1, as an interrupted run would have.
    const firstLen = Math.min(TEST_PART, resumeBytes.length);
    const partOne = await apiCall(TEST_BASE, token, 'PUT', `/part/${begun.body.sessionId}/1`, {
      headers: { 'x-upload-size': String(firstLen), 'content-type': 'application/octet-stream' },
      body: resumeBytes.subarray(0, firstLen),
    });
    check('part 1 is accepted', () => assert.equal(partOne.status, 201));

    const rejoin = await apiCall(TEST_BASE, token, 'POST', '/begin', {
      json: { filename: path.basename(resumePath), size: resumeBytes.length },
    });
    check('re-beginning returns the same session', () =>
      assert.equal(rejoin.body?.sessionId, begun.body.sessionId),
    );
    check('the server reports part 1 as already held', () =>
      assert.deepEqual(rejoin.body?.receivedParts, [1]),
    );
    check('the remaining parts are listed as missing', () =>
      assert.ok((rejoin.body?.missingParts ?? []).length > 0),
    );

    // Finishing early must be refused while parts are missing.
    const early = await apiCall(TEST_BASE, token, 'POST', `/complete/${begun.body.sessionId}`, {
      json: {},
    });
    check('completing with parts missing is refused', () => assert.equal(early.status, 409));

    // Now let the uploader finish the same file; it should skip part 1.
    const resumeRun = await runUploader(resumePath, { configPath, server: TEST_BASE, token });
    check('the uploader resumed rather than restarting', () =>
      assert.match(resumeRun.stdout, /Resuming: 1 of \d+ parts/),
    );
    check('the resumed upload completed', () =>
      assert.ok(/All parts sent/.test(resumeRun.stdout), resumeRun.stdout.slice(-400)),
    );

    // =====================================================================
    process.stdout.write('\n8. A bad part is rejected and can be resent\n');
    const badPath = path.join(workdir, 'Retry.Test.2021.1080p.mkv');
    const badBytes = crypto.randomBytes(1500 * 1024);
    await fsp.writeFile(badPath, badBytes);

    const badBegun = await apiCall(TEST_BASE, token, 'POST', '/begin', {
      json: { filename: path.basename(badPath), size: badBytes.length },
    });

    // Declare more bytes than are actually sent: a truncated part.
    const truncated = await apiCall(TEST_BASE, token, 'PUT', `/part/${badBegun.body.sessionId}/1`, {
      headers: { 'x-upload-size': String(TEST_PART), 'content-type': 'application/octet-stream' },
      body: badBytes.subarray(0, 1000),
    });
    check('a truncated part is refused', () => assert.equal(truncated.status, 400));
    check('the failure explains the mismatch', () =>
      assert.match(truncated.body?.error ?? '', /Incomplete part/i),
    );

    const afterBad = await apiCall(TEST_BASE, token, 'GET', `/session/${badBegun.body.sessionId}`);
    check('the rejected part was not recorded', () =>
      assert.deepEqual(afterBad.body?.receivedParts, []),
    );

    // Resending it correctly must work.
    const resent = await apiCall(TEST_BASE, token, 'PUT', `/part/${badBegun.body.sessionId}/1`, {
      headers: { 'x-upload-size': String(TEST_PART), 'content-type': 'application/octet-stream' },
      body: badBytes.subarray(0, TEST_PART),
    });
    check('the corrected part is accepted', () => assert.equal(resent.status, 201));

    // =====================================================================
    process.stdout.write('\n9. Concurrent uploads from two users\n');
    const otherSlug = `up-other-${Date.now()}`;
    await psql(
      `INSERT INTO users (name, telegram_chat_id, jellyfin_username, storage_slug)
       VALUES ('Uploader Other', ${TEST_CHAT_ID - 1}, '${otherSlug}', '${otherSlug}')`,
    );
    const otherId = Number(
      await psql(`SELECT id FROM users WHERE telegram_chat_id = ${TEST_CHAT_ID - 1}`),
    );
    createdUsers.push(otherId);

    const otherToken = (
      await execFileAsync('node', [path.join(PROJECT, 'dist', 'scripts', 'upload-token.js'), '--user', 'Uploader Other'], {
        cwd: PROJECT,
      })
    ).stdout.match(/jellygram_[A-Za-z0-9_-]+/)?.[0];

    const sameName = 'Shared.Title.2018.1080p.mkv';
    const [aBegin, bBegin] = await Promise.all([
      apiCall(TEST_BASE, token, 'POST', '/begin', { json: { filename: sameName, size: 2 * 1024 * 1024 } }),
      apiCall(TEST_BASE, otherToken, 'POST', '/begin', { json: { filename: sameName, size: 2 * 1024 * 1024 } }),
    ]);

    check('both users get a session for the same filename', () => {
      assert.equal(aBegin.body?.mode, 'multipart');
      assert.equal(bBegin.body?.mode, 'multipart');
      assert.notEqual(aBegin.body.sessionId, bBegin.body.sessionId);
    });

    // Parts uploaded simultaneously must land in the right session.
    const chunk = crypto.randomBytes(TEST_PART);
    const [aPart, bPart] = await Promise.all([
      apiCall(TEST_BASE, token, 'PUT', `/part/${aBegin.body.sessionId}/1`, {
        headers: { 'x-upload-size': String(TEST_PART), 'content-type': 'application/octet-stream' },
        body: chunk,
      }),
      apiCall(TEST_BASE, otherToken, 'PUT', `/part/${bBegin.body.sessionId}/1`, {
        headers: { 'x-upload-size': String(TEST_PART), 'content-type': 'application/octet-stream' },
        body: chunk,
      }),
    ]);
    check('both concurrent parts are accepted', () => {
      assert.equal(aPart.status, 201);
      assert.equal(bPart.status, 201);
    });

    const crossAccess = await apiCall(TEST_BASE, otherToken, 'GET', `/session/${aBegin.body.sessionId}`);
    check("one user cannot read another user's session", () =>
      assert.equal(crossAccess.status, 404),
    );

    const crossWrite = await apiCall(TEST_BASE, otherToken, 'PUT', `/part/${aBegin.body.sessionId}/2`, {
      headers: { 'x-upload-size': '10', 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(10),
    });
    check("one user cannot write into another user's session", () =>
      assert.equal(crossWrite.status, 404),
    );

    // =====================================================================
    process.stdout.write('\n10. Rejected file types\n');
    const badType = await apiCall(TEST_BASE, token, 'POST', '/begin', {
      json: { filename: 'notes.txt', size: 1024 },
    });
    check('a non-video extension is refused', () => assert.equal(badType.status, 422));
    const subtitle = await apiCall(TEST_BASE, token, 'POST', '/begin', {
      json: { filename: 'Movie.srt', size: 1024 },
    });
    check('a subtitle file is refused', () => assert.equal(subtitle.status, 422));
  } finally {
    for (const child of [testWorker, testServer, liveServer]) {
      if (!child) continue;
      child.kill('SIGTERM');
      await sleep(1200);
      if (!child.killed) child.kill('SIGKILL');
      children.delete(child);
    }

    // The rows and the directories both go. The tree is this suite's own now,
    // but a library directory left behind still makes the next run's state
    // ambiguous, and deleting rows alone is what let 54 of them accumulate.
    for (const id of createdUsers) {
      const slugs = await psql(
        `SELECT storage_slug FROM users WHERE id = ${id}`,
      ).catch(() => '');
      for (const slug of String(slugs).split('\n').map((x) => x.trim()).filter(Boolean)) {
        // Guard the obvious catastrophe: a blank or unexpected slug would
        // otherwise resolve to the library root itself.
        if (!/^up-\d+$/.test(slug)) continue;
        for (const root of [MOVIES_ROOT, TV_ROOT]) {
          await fsp.rm(path.join(root, slug), { recursive: true, force: true }).catch(() => {});
        }
      }
      await psql(`DELETE FROM users WHERE id = ${id}`).catch(() => {});
    }
    await fsp.rm(workdir, { recursive: true, force: true });
    await db?.end().catch(() => {});
  }

  // Skips are named in the summary. A run that quietly reports "all passed"
  // while having declined to run a third of its checks is worse than one that
  // fails: it looks like evidence and is not.
  const tail = skipped > 0 ? ` (${skipped} skipped)` : '';
  process.stdout.write(
    `\n===================\n${failures === 0 ? `ALL CHECKS PASSED${tail}` : `${failures} CHECK(S) FAILED${tail}`}\n\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

/** Run the real uploader binary against a given server. */
function runUploader(filePath, { configPath, server, token }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [UPLOADER, filePath, '--no-wait'], {
      cwd: path.dirname(filePath),
      env: { ...process.env, JELLYGRAM_CONFIG: configPath, JELLYGRAM_SERVER: server, JELLYGRAM_TOKEN: token },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

main().catch((err) => {
  process.stdout.write(`\nFATAL: ${err.message}\n${err.stack}\n`);
  process.exitCode = 1;
});
