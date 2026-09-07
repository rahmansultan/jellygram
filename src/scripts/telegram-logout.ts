import { stdout } from 'node:process';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { closePool } from '../db/pool.js';

/**
 * Log the bot out of Telegram's cloud Bot API.
 *
 * Telegram requires this before a bot can be used with a self-hosted Bot API
 * server: without it there is no guarantee the local server receives updates,
 * because the cloud server still holds the bot's session.
 *
 * After a successful call the bot can be used locally immediately, but cannot
 * return to the cloud API for 10 minutes.
 *
 *   npm run telegram:logout
 *
 * The token is read from .env and never printed.
 */

const log = createLogger('cli');
const CLOUD_API = 'https://api.telegram.org';

function say(text = ''): void {
  stdout.write(`${text}\n`);
}

interface TelegramResponse {
  ok?: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

async function callCloud(method: string): Promise<{ status: number; body: TelegramResponse }> {
  const res = await fetch(`${CLOUD_API}/bot${config.telegram.botToken}/${method}`, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as TelegramResponse;
  return { status: res.status, body };
}

async function main(): Promise<void> {
  if (!config.telegram.configured) {
    say('TELEGRAM_BOT_TOKEN is not set in .env. Run `npm run setup` first.');
    process.exitCode = 2;
    return;
  }

  say();
  say('Logging out of the cloud Bot API');
  say('================================');
  say();

  // Identify the bot first, so the operator can see which bot is affected
  // without the token ever being displayed.
  const me = await callCloud('getMe');
  if (me.body.ok) {
    const user = me.body.result as { username?: string; id?: number };
    say(`Bot: @${user.username ?? 'unknown'} (id ${user.id ?? '?'})`);
  } else if (me.status === 401 || /logged out/i.test(me.body.description ?? '')) {
    // 400 "Logged out" is what a previous logOut leaves behind; 401 is an
    // outright invalid token. Either way there is nothing left to do here.
    say('The cloud Bot API no longer serves this bot, which is what a previous');
    say('logOut looks like. The bot is ready for the local server.');
    say();
    say('Nothing to do.');
    return;
  } else {
    say(`Could not reach the cloud Bot API: ${me.body.description ?? `HTTP ${me.status}`}`);
    process.exitCode = 1;
    return;
  }

  say();
  const result = await callCloud('logOut');

  if (result.body.ok) {
    log.info('Bot logged out of the cloud Bot API');
    say('Logged out of the cloud Bot API.');
    say();
    say('The bot can now be used with the local Bot API server. It cannot return');
    say('to the cloud API for 10 minutes.');
    return;
  }

  if (result.status === 429) {
    const wait = result.body.parameters?.retry_after ?? 60;
    say(`Rate limited by Telegram. Try again in ${wait} seconds.`);
    process.exitCode = 1;
    return;
  }

  if (result.status === 401 || /logged out/i.test(result.body.description ?? '')) {
    say('The token is already logged out of the cloud Bot API. Nothing to do.');
    return;
  }

  log.error({ status: result.status, description: result.body.description }, 'logOut failed');
  say(`logOut failed: ${result.body.description ?? `HTTP ${result.status}`}`);
  process.exitCode = 1;
}

main()
  .catch((err) => {
    log.error({ err }, 'logOut failed');
    say(`Failed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
