import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

/**
 * End-to-end test of `npm run setup` over a real pseudo-terminal.
 *
 * A pty is essential: the hidden-input path only engages when stdin is a TTY,
 * so piping input would exercise the fallback and prove nothing about echo
 * suppression. `script` from util-linux provides one.
 *
 * The real .env is backed up and restored, and every secret used here is
 * synthetic.
 *
 * Usage: node tests/setup-prompts.e2e.mjs
 */

const execFileAsync = promisify(execFile);
const PROJECT = path.join(import.meta.dirname, '..');
const ENV_PATH = path.join(PROJECT, '.env');
const EXAMPLE_PATH = path.join(PROJECT, '.env.example');

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

/** Values that must never appear on screen. Synthetic, not real credentials. */
const SECRETS = {
  botToken: '123456789:AAFAKE_TOKEN_FOR_TESTING_ONLY_xyz',
  apiHash: '0123456789abcdef0123456789abcdef',
  tmdb: 'fake-tmdb-key-for-testing-0000',
};
const API_ID = '1234567';

/**
 * Run the setup script attached to a pty, feeding `answers` as keystrokes.
 *
 * A delay between lines lets the script consume each answer before the next
 * arrives, which matters because the secret prompts switch stdin into raw mode
 * between questions.
 */
async function runSetup(answers) {
  // The answers are fed into `script`'s own stdin, which relays them into the
  // pty. Piping them into the command *inside* `script -c` instead would give
  // node a pipe for stdin, isTTY would be false, and the masked-input path
  // would never run.
  const feeder = path.join(import.meta.dirname, 'helpers', 'answer-feeder.mjs');
  const command = `node ${JSON.stringify(feeder)} | script -qec ${JSON.stringify(
    'node dist/scripts/setup.js',
  )} /dev/null`;

  const { stdout } = await execFileAsync('bash', ['-c', command], {
    cwd: PROJECT,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      JELLYGRAM_ANSWERS: JSON.stringify(answers),
      /**
       * A Jellyfin that is definitely not there, so the questions asked are
       * the same on every machine.
       *
       * Section 2 calls the real server before it decides what to ask: when
       * one answers it offers "Create an API key now?", and when none does it
       * says so and moves on. The answers below are a fixed list fed as
       * keystrokes, so that extra question shifted every later answer by one —
       * the TMDB key was typed at the API ID prompt, and a secret went to a
       * prompt that does not mask. It passed on a developer's machine, where
       * Jellyfin is usually running on 8096, and failed on CI, where nothing
       * is. Pinning the address makes the branch deterministic instead of
       * dependent on what happens to be listening.
       *
       * Port 9 is discard, and 127.0.0.1 never leaves the machine — the same
       * dead address `tests/helpers/test-credentials.ts` uses, for the same
       * reason.
       */
      JELLYFIN_URL: 'http://127.0.0.1:9',
    },
  }).catch((err) => ({ stdout: (err.stdout ?? '') + (err.stderr ?? '') }));

  // A pty terminates lines with CRLF; normalise so assertions stay readable.
  return stdout.replace(/\r/g, '');
}

function readEnv() {
  const content = fs.readFileSync(ENV_PATH, 'utf8');
  const get = (key) => content.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
  return { content, get };
}

async function main() {
  process.stdout.write('\nSetup prompt test (real pty)\n============================\n\n');

  /**
   * On a clean checkout — and on CI — there is no .env yet, and this suite
   * used to die on `ENOENT: ... open '.env'` before its first check. That is a
   * fresh clone, which is exactly the case the suite is supposed to work in,
   * so make one from .env.example for the duration and take it away again
   * afterwards. Where an .env already exists it is left completely alone
   * beyond the byte-for-byte backup and restore below.
   */
  const preexisting = fs.existsSync(ENV_PATH);
  if (!preexisting) {
    await fsp.writeFile(ENV_PATH, await fsp.readFile(EXAMPLE_PATH, 'utf8'), { mode: 0o600 });
    process.stdout.write('No .env found; created a scratch one from .env.example.\n\n');
  }

  const backup = await fsp.readFile(ENV_PATH, 'utf8');
  const backupPath = path.join(os.tmpdir(), `jellygram-env-backup-${Date.now()}`);
  await fsp.writeFile(backupPath, backup, { mode: 0o600 });
  process.stdout.write(`.env backed up to ${backupPath}\n\n`);

  try {
    const before = readEnv();

    // -------------------------------------------------------------------
    // Pass 1: supply every value.
    // Answers in order: bot token, tmdb, api id, api hash. There is no
    // Jellyfin question: runSetup points the script at a dead address, so
    // section 2 reports the server as unreachable rather than offering to
    // create a key.
    // -------------------------------------------------------------------
    process.stdout.write('1. Supplying every value\n');
    const out1 = await runSetup([SECRETS.botToken, SECRETS.tmdb, API_ID, SECRETS.apiHash]);

    check('the script prompts for the API ID', () =>
      assert.match(out1, /4\. Telegram API ID/, 'section 4 missing'),
    );
    check('the script prompts for the API hash', () =>
      assert.match(out1, /5\. Telegram API hash/, 'section 5 missing'),
    );
    check('all five sections are present', () => {
      for (const n of ['1. Telegram bot token', '2. Jellyfin API key', '3. TMDB API key']) {
        assert.ok(out1.includes(n), `missing "${n}"`);
      }
    });
    check('an unreachable Jellyfin is reported, not fatal', () => {
      // The branch this suite actually runs, asserted rather than assumed:
      // setup says it cannot reach the server, does not offer to create a key,
      // and carries on to the remaining sections.
      assert.match(out1, /Cannot reach Jellyfin/, 'expected the unreachable-Jellyfin notice');
      assert.ok(!out1.includes('Create an API key now?'), 'no key offer without a server');
      assert.match(out1, /3\. TMDB API key/, 'setup must continue past section 2');
    });

    // -------------------------------------------------------------------
    process.stdout.write('\n2. Echo suppression\n');

    check('the bot token never appears on screen', () =>
      assert.ok(!out1.includes(SECRETS.botToken), 'the bot token was echoed'),
    );
    check('the API hash never appears on screen', () =>
      assert.ok(!out1.includes(SECRETS.apiHash), 'the API hash was echoed'),
    );
    check('the TMDB key never appears on screen', () =>
      assert.ok(!out1.includes(SECRETS.tmdb), 'the TMDB key was echoed'),
    );
    check('masking characters are shown instead', () =>
      assert.match(out1, /\*{10,}/, 'no run of * found; input may not be masked'),
    );
    check('the API ID is displayed normally', () =>
      assert.ok(out1.includes(API_ID), 'the API ID should be visible, it is not a secret'),
    );

    // -------------------------------------------------------------------
    process.stdout.write('\n3. Values written to .env\n');
    const after1 = readEnv();

    check('TELEGRAM_API_ID is stored', () => assert.equal(after1.get('TELEGRAM_API_ID'), API_ID));
    check('TELEGRAM_API_HASH is stored', () =>
      assert.equal(after1.get('TELEGRAM_API_HASH'), SECRETS.apiHash),
    );
    check('TELEGRAM_BOT_TOKEN is stored', () =>
      assert.equal(after1.get('TELEGRAM_BOT_TOKEN'), SECRETS.botToken),
    );
    check('TMDB_API_KEY is stored', () => assert.equal(after1.get('TMDB_API_KEY'), SECRETS.tmdb));
    check('.env stays owner-only', () =>
      assert.equal(fs.statSync(ENV_PATH).mode & 0o777, 0o600),
    );
    check('unrelated settings are preserved', () => {
      assert.equal(after1.get('MEDIA_ROOT'), before.get('MEDIA_ROOT'));
      assert.equal(after1.get('DATABASE_URL'), before.get('DATABASE_URL'));
      assert.equal(after1.get('ADMIN_PORT'), before.get('ADMIN_PORT'));
    });

    // -------------------------------------------------------------------
    // Pass 2: press Enter at everything; nothing may change.
    // -------------------------------------------------------------------
    process.stdout.write('\n4. Enter preserves existing values\n');
    const out2 = await runSetup(['', '', '', '']);

    const after2 = readEnv();
    check('the API ID is unchanged', () => assert.equal(after2.get('TELEGRAM_API_ID'), API_ID));
    check('the API hash is unchanged', () =>
      assert.equal(after2.get('TELEGRAM_API_HASH'), SECRETS.apiHash),
    );
    check('the bot token is unchanged', () =>
      assert.equal(after2.get('TELEGRAM_BOT_TOKEN'), SECRETS.botToken),
    );
    check('the whole file is byte-identical', () =>
      assert.equal(after2.content, after1.content, 'setup rewrote the file when it should not have'),
    );
    check('it reports that nothing changed', () => assert.match(out2, /Nothing changed/));
    check('current values are shown masked, not in full', () => {
      assert.ok(!out2.includes(SECRETS.apiHash), 'the stored API hash was displayed');
      assert.ok(!out2.includes(SECRETS.botToken), 'the stored bot token was displayed');
      assert.match(out2, /Current: .+…/, 'expected a masked "Current:" line');
    });
    check('the stored API ID is shown in full', () =>
      assert.ok(out2.includes(`Current: ${API_ID}`), 'the API ID should be readable'),
    );

    // -------------------------------------------------------------------
    // Pass 3: rejected input must not be written.
    // -------------------------------------------------------------------
    process.stdout.write('\n5. Invalid input is rejected, not stored\n');
    const out3 = await runSetup(['not-a-token', '', 'twelve', 'nothex']);
    const after3 = readEnv();

    check('a malformed bot token is refused', () => assert.match(out3, /does not look like a bot token/));
    check('a non-numeric API ID is refused', () => assert.match(out3, /API ID is a number/));
    check('a malformed API hash is refused', () => assert.match(out3, /32 hexadecimal characters/));
    check('nothing was overwritten', () => {
      assert.equal(after3.get('TELEGRAM_API_ID'), API_ID);
      assert.equal(after3.get('TELEGRAM_API_HASH'), SECRETS.apiHash);
      assert.equal(after3.get('TELEGRAM_BOT_TOKEN'), SECRETS.botToken);
    });

    // -------------------------------------------------------------------
    process.stdout.write('\n6. Guidance after configuring\n');
    check('it always says how to apply the change', () =>
      assert.match(out1, /systemctl --user restart/),
    );
    check('the switch-to-local advice matches the current mode', () => {
      const alreadyLocal = !/TELEGRAM_API_ROOT=https:\/\/api\.telegram\.org/.test(before.content);
      const mentionsSwitch = /telegram:logout/.test(out1) && /botapi:up/.test(out1);
      // The advice is only useful while still on the public Bot API; once the
      // local server is in use, printing it again would be noise.
      assert.equal(
        mentionsSwitch,
        !alreadyLocal,
        alreadyLocal
          ? 'already on the local Bot API, so the switch advice should be omitted'
          : 'still on the public Bot API, so the switch advice should be shown',
      );
    });
  } finally {
    await fsp.writeFile(ENV_PATH, backup, { mode: 0o600 });
    await fsp.chmod(ENV_PATH, 0o600);
    process.stdout.write(`\n.env restored from ${backupPath}\n`);

    const restored = fs.readFileSync(ENV_PATH, 'utf8');
    if (restored !== backup) {
      failures += 1;
      process.stdout.write('  FAIL  .env was not restored correctly\n');
    } else {
      process.stdout.write('  PASS  .env restored byte-for-byte\n');
      await fsp.unlink(backupPath).catch(() => {});
    }

    // A checkout that had no .env before this ran should have none after it.
    if (!preexisting) {
      await fsp.unlink(ENV_PATH).catch(() => {});
      process.stdout.write('  PASS  the scratch .env was removed again\n');
    }
  }

  process.stdout.write(
    `\n============================\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stdout.write(`\nFATAL: ${err.message}\n${err.stack}\n`);
  process.exitCode = 1;
});
