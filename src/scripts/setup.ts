import { stdout } from 'node:process';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { closePool } from '../db/pool.js';
import { ENV_PATH, getEnvKey, maskSecret, setEnvKey } from '../lib/envfile.js';
import { ask, askSecret, askYesNo, PromptAbortedError } from '../lib/prompt.js';
import { serverInfo, createApiKeyWithPassword } from '../services/jellyfin.js';
import { checkTmdb } from '../services/tmdb.js';

/**
 * Interactive first-run setup.
 *
 * Walks through every credential this application cannot discover for itself
 * and writes them into `.env`. Secret values are typed without echo and are
 * never printed, logged, or passed on a command line where they would land in
 * shell history.
 *
 *   npm run setup
 */

const log = createLogger('cli');

const BOT_TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{20,}$/;
const API_ID_RE = /^\d{1,12}$/;
const API_HASH_RE = /^[0-9a-f]{32}$/i;

function say(text = ''): void {
  stdout.write(`${text}\n`);
}

/** Track whether anything actually changed, so the closing advice is accurate. */
let changed = false;

async function saveIfProvided(
  key: string,
  value: string,
  validate?: (v: string) => string | null,
): Promise<void> {
  if (!value) return; // Enter pressed: keep whatever is already there.

  const problem = validate?.(value) ?? null;
  if (problem) {
    say(`   ! ${problem}`);
    say('   ! Not saved. Re-run setup when you have the right value.');
    return;
  }

  await setEnvKey(key, value);
  say('   Saved.');
  changed = true;
}

async function main(): Promise<void> {
  say();
  say('JellyGram — setup');
  say('='.repeat(17));
  say();
  say(`Writing to ${ENV_PATH}`);
  say('Press Enter at any prompt to leave that value unchanged.');
  say('Secret values are not shown as you type; each character appears as *.');
  say();

  // --- 1. Telegram bot token ------------------------------------------------
  say('1. Telegram bot token');
  say('   Create a bot with @BotFather (/newbot) and paste its token.');
  say('   Use a bot dedicated to this application: two processes polling the');
  say('   same token steal each other’s updates.');
  say(`   Current: ${maskSecret(await getEnvKey('TELEGRAM_BOT_TOKEN'))}`);

  await saveIfProvided('TELEGRAM_BOT_TOKEN', (await askSecret('   Token: ')).trim(), (v) =>
    BOT_TOKEN_RE.test(v) ? null : 'That does not look like a bot token (expected 123456789:AA...).',
  );
  say();

  // --- 2. Jellyfin API key --------------------------------------------------
  say('2. Jellyfin API key');
  say(`   Current: ${maskSecret(await getEnvKey('JELLYFIN_API_KEY'))}`);

  try {
    const info = await serverInfo();
    say(`   Jellyfin "${info.serverName}" v${info.version} is reachable at ${config.jellyfin.url}.`);

    if (await askYesNo('   Create an API key now?')) {
      say('   Your Jellyfin administrator password is used once to create the key');
      say('   and is never stored or logged.');
      const username = (await ask('   Jellyfin admin username: ')).trim();
      const password = await askSecret('   Jellyfin admin password: ');
      try {
        const apiKey = await createApiKeyWithPassword(username, password, 'JellyGram');
        await setEnvKey('JELLYFIN_API_KEY', apiKey);
        say('   API key created and saved.');
        changed = true;
      } catch (err) {
        say(`   ! Failed: ${(err as Error).message}`);
        say('   ! You can also create one in Jellyfin (Dashboard -> API Keys)');
        say('   ! and paste it into .env as JELLYFIN_API_KEY.');
      }
    }
  } catch (err) {
    say(`   ! Cannot reach Jellyfin at ${config.jellyfin.url}: ${(err as Error).message}`);
  }
  say();

  // --- 3. TMDB --------------------------------------------------------------
  say('3. TMDB API key (optional)');
  say('   Improves identification accuracy. Without it, titles come from');
  say('   filenames alone. Get one at themoviedb.org -> Settings -> API.');
  say(`   Current: ${maskSecret(await getEnvKey('TMDB_API_KEY'))}`);

  const tmdb = (await askSecret('   Key or token: ')).trim();
  if (tmdb) {
    await setEnvKey('TMDB_API_KEY', tmdb);
    say('   Saved. The dashboard’s Settings page will show whether it works.');
    changed = true;
  } else if (config.tmdb.configured) {
    const status = await checkTmdb();
    say(`   Existing key status: ${status.message}`);
  }
  say();

  // --- 4 and 5. Local Bot API credentials -----------------------------------
  //
  // Needed only by the local Bot API server, which is what lifts Telegram's
  // 20 MB download ceiling to 2000 MB. They come from a phone-number login at
  // my.telegram.org and cannot be derived from the bot token.
  say('4. Telegram API ID (for the local Bot API server)');
  say('   From https://my.telegram.org -> API development tools.');
  say('   Needed only to send files larger than 20 MB. These are ACCOUNT');
  say('   credentials, not bot credentials.');

  const currentApiId = await getEnvKey('TELEGRAM_API_ID');
  // Numeric and not secret on its own, so it is shown in full.
  say(`   Current: ${currentApiId || '(not set)'}`);

  await saveIfProvided('TELEGRAM_API_ID', (await ask('   API ID: ')).trim(), (v) =>
    API_ID_RE.test(v) ? null : 'The API ID is a number, for example 1234567.',
  );
  say();

  say('5. Telegram API hash (for the local Bot API server)');
  say('   From the same page as the API ID. Treated as a secret.');
  say(`   Current: ${maskSecret(await getEnvKey('TELEGRAM_API_HASH'))}`);

  await saveIfProvided('TELEGRAM_API_HASH', (await askSecret('   API hash: ')).trim(), (v) =>
    API_HASH_RE.test(v)
      ? null
      : 'The API hash is 32 hexadecimal characters, for example 0123456789abcdef0123456789abcdef.',
  );
  say();

  // --- Closing advice -------------------------------------------------------
  say('='.repeat(17));

  if (!changed) {
    say('Nothing changed.');
    say();
    return;
  }

  say('Restart the services to apply. With the systemd units from deploy/:');
  say();
  say('  systemctl --user restart jellygram-api jellygram-bot jellygram-worker');
  say();
  say('Running them by hand instead? Stop and re-run npm run start:api /');
  say('start:bot / start:worker so each process re-reads .env.');

  const haveApiId = await getEnvKey('TELEGRAM_API_ID');
  const haveApiHash = await getEnvKey('TELEGRAM_API_HASH');

  if (haveApiId && haveApiHash && !config.telegram.localMode) {
    say();
    say('Both local Bot API credentials are now set, but the application is');
    say('still using the public Bot API with its 20 MB limit. To switch:');
    say();
    say('  npm run telegram:logout        # required once, before switching');
    say('  npm run botapi:up');
    say('  # then set in .env:');
    say('  #   TELEGRAM_API_ROOT=http://127.0.0.1:8081');
    say('  #   TELEGRAM_LOCAL_MODE=true');
    say('  systemctl --user restart jellygram-bot jellygram-worker');
    say('  npm run telegram:verify');
  } else if ((haveApiId && !haveApiHash) || (!haveApiId && haveApiHash)) {
    say();
    say('Only one of TELEGRAM_API_ID / TELEGRAM_API_HASH is set. The local Bot');
    say('API server needs both; re-run setup to supply the other.');
  }
  say();
}

main()
  .catch((err) => {
    if (err instanceof PromptAbortedError) {
      say('\nCancelled. Nothing further was written.');
      return;
    }
    log.error({ err }, 'Setup failed');
    say(`\nFailed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
