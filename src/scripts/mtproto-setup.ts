import { stdout } from 'node:process';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { closePool } from '../db/pool.js';
import { ask, askSecret, askYesNo, PromptAbortedError } from '../lib/prompt.js';
import { setEnvKey } from '../lib/envfile.js';
import {
  SESSION_FILE_MODE,
  deleteSession,
  disconnectClient,
  readSessionString,
  status,
  writeSessionString,
} from '../services/mtproto.js';

/**
 * One-time Telegram account authentication for MTProto ingestion.
 *
 *   npm run telegram:mtproto:setup
 *
 * Everything is entered here, at this terminal, on this server. The login code
 * and the 2FA password are used once to complete the login and are never
 * stored, logged, echoed, or transmitted anywhere but to Telegram.
 *
 * What *is* stored is the resulting session string, in a file readable only by
 * the service user. That session is equivalent to being logged in: anyone who
 * obtains it can act as this Telegram account until it is revoked from
 * Settings → Devices.
 */

const log = createLogger('cli');

function say(text = ''): void {
  stdout.write(`${text}\n`);
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  say();
  say('MTProto account setup');
  say('=====================');
  say();

  // --- Revoke path ----------------------------------------------------------
  if (process.argv.includes('--logout')) {
    const existing = await readSessionString();
    if (!existing) {
      say('No session is stored. Nothing to do.\n');
      return;
    }
    if (!(await askYesNo('Delete the stored MTProto session?'))) {
      say('\nLeft unchanged.\n');
      return;
    }
    await deleteSession();
    await setEnvKey('TELEGRAM_MTPROTO_ENABLED', 'false');
    log.info('MTProto session deleted');
    say('\nSession deleted and MTProto disabled.');
    say('Also revoke the session in Telegram: Settings → Devices → terminate it.\n');
    return;
  }

  // --- Preconditions --------------------------------------------------------
  if (!config.mtproto.credentialsPresent) {
    say('TELEGRAM_API_ID and TELEGRAM_API_HASH must be set first.');
    say('Run `npm run setup` (prompts 4 and 5), then try again.\n');
    process.exitCode = 2;
    return;
  }

  const current = await status({ probe: true });
  if (current.authorized) {
    say(
      `Already linked to Telegram account ${
        current.account?.username ? `@${current.account.username}` : (current.account?.firstName ?? '')
      }.`,
    );
    if (!(await askYesNo('Replace the existing session?'))) {
      say('\nLeft unchanged.\n');
      return;
    }
  }

  // --- What this grants -----------------------------------------------------
  say('This links your personal Telegram account so the server can fetch media');
  say('you forward to the bot that is too large for the Bot API (over 2000 MB).');
  say();
  say('Understand what is being stored:');
  say(`  • A session file at ${config.mtproto.sessionPath}, mode ${SESSION_FILE_MODE.toString(8)}.`);
  say('  • Anyone who obtains that file can act as your Telegram account.');
  say('  • Your password is never stored. The login code is used once.');
  say('  • Revoke at any time: Telegram → Settings → Devices, or --logout here.');
  say();
  say('The account is used only to read media you forward and download it.');
  say('It never sends messages, joins chats, or forwards anything.');
  say();

  if (!(await askYesNo('Continue?'))) {
    say('\nCancelled. Nothing was stored.\n');
    return;
  }

  // --- Login ----------------------------------------------------------------
  const phone = (arg('phone') ?? (await ask('\nPhone number (with country code, e.g. +2519…): '))).trim();
  if (!/^\+?\d{6,15}$/.test(phone.replace(/[\s-]/g, ''))) {
    say('\nThat does not look like a phone number.\n');
    process.exitCode = 2;
    return;
  }

  const { TelegramClient } = await import('teleproto');
  const { StringSession } = await import('teleproto/sessions/index.js');

  const client = new TelegramClient(new StringSession(''), config.mtproto.apiId, config.mtproto.apiHash, {
    connectionRetries: 3,
  });

  say('\nTelegram will send a login code to your account.\n');

  try {
    await client.start({
      phoneNumber: async () => phone,
      // Entered here, on this terminal, and used once.
      phoneCode: async () => (await ask('Login code: ')).trim(),
      password: async () => {
        say('  (this account has two-factor authentication enabled)');
        return askSecret('2FA password: ');
      },
      onError: async (err: Error) => {
        say(`  ! ${err.message}`);
        // Resolving false lets the library re-prompt rather than abort.
        return false;
      },
    });
  } catch (err) {
    if (err instanceof PromptAbortedError) {
      say('\nCancelled. Nothing was stored.\n');
      await client.disconnect().catch(() => {});
      return;
    }
    say(`\nLogin failed: ${(err as Error).message}\n`);
    await client.disconnect().catch(() => {});
    process.exitCode = 1;
    return;
  }

  const me = (await client.getMe()) as { id?: { toString(): string }; username?: string; firstName?: string };

  // The session string is written straight to the protected file. It is never
  // printed, and never passed through the logger.
  const session = String(client.session.save());
  await writeSessionString(session);
  await client.disconnect().catch(() => {});
  await disconnectClient();

  await setEnvKey('TELEGRAM_MTPROTO_ENABLED', 'true');

  log.info({ account: me?.username ?? me?.id?.toString() }, 'MTProto session established');

  say();
  say('=====================');
  say(`Linked to ${me?.username ? `@${me.username}` : (me?.firstName ?? 'your account')}.`);
  say(`Session stored at ${config.mtproto.sessionPath} (mode ${SESSION_FILE_MODE.toString(8)}).`);
  say('TELEGRAM_MTPROTO_ENABLED has been set to true in .env.');
  say();
  say('Restart the services to activate it:');
  say();
  say('  systemctl --user restart jellygram-bot jellygram-worker jellygram-api');
  say();
  say('Then forward any movie to the bot. Files over 2000 MB will come through');
  say('this account; smaller ones keep using the faster Bot API path.');
  say();
}

main()
  .catch((err) => {
    if (err instanceof PromptAbortedError) {
      say('\nCancelled. Nothing was stored.\n');
      return;
    }
    log.error({ err }, 'MTProto setup failed');
    say(`\nFailed: ${(err as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectClient().catch(() => {});
    await closePool();
  });
