import { stdout } from 'node:process';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { closePool } from '../db/pool.js';
import { createApiKeyWithPassword, serverInfo } from '../services/jellyfin.js';
import { setEnvKey } from '../lib/envfile.js';
import { ask, askSecret } from '../lib/prompt.js';

/**
 * One-time Jellyfin setup.
 *
 * Asks for a Jellyfin *administrator* login, exchanges it for a long-lived API
 * key, and writes that key into .env. The password is used once and never
 * stored, logged, or echoed.
 */

const log = createLogger('cli');
const APP_NAME = 'JellyGram';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const info = await serverInfo();
  stdout.write(`Connected to Jellyfin "${info.serverName}" (version ${info.version}) at ${config.jellyfin.url}\n\n`);

  let username = arg('user') ?? '';
  /**
   * `JELLYFIN_ADMIN_PASSWORD` is read from the environment rather than from
   * `.env`, and is the one variable in this codebase outside
   * `src/config/index.ts` that is. That is deliberate: this is a live Jellyfin
   * administrator password, wanted for exactly one call, by somebody scripting
   * an unattended first run. Putting it in the configuration schema would mean
   * putting it in `.env.example`, and inviting people to leave an
   * administrator password on disk for a value that is used once and then
   * never again. Passing it for the length of one command is the safer shape:
   *
   *   JELLYFIN_ADMIN_PASSWORD=… npm run jellyfin:bootstrap -- --user admin
   *
   * Interactively, leave it unset and the prompt below asks without echoing.
   */
  let password = arg('password') ?? process.env['JELLYFIN_ADMIN_PASSWORD'] ?? '';

  if (!username || !password) {
    if (!username) username = (await ask('Jellyfin administrator username: ')).trim();
    // Never echoed: this is a live administrator password.
    if (!password) password = await askSecret('Jellyfin administrator password: ');
    stdout.write('\n');
  }

  const apiKey = await createApiKeyWithPassword(username, password, APP_NAME);
  const envPath = await setEnvKey('JELLYFIN_API_KEY', apiKey);

  log.info({ envPath }, 'Jellyfin API key created and stored');
  stdout.write(`API key created and written to ${envPath}\n`);
  stdout.write('Restart the services to pick it up:\n');
  stdout.write('  systemctl --user restart jellygram-api jellygram-bot jellygram-worker\n');
}

main()
  .catch((err) => {
    log.error({ err }, 'Jellyfin bootstrap failed');
    stdout.write(`\nFailed: ${(err as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
