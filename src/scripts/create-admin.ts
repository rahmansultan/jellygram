import readline from 'node:readline/promises';
import crypto from 'node:crypto';
import { stdin, stdout } from 'node:process';
import { createLogger } from '../lib/logger.js';
import { runMigrations } from '../db/migrate.js';
import { closePool } from '../db/pool.js';
import { adminsRepo } from '../db/repositories.js';
import { hashPassword } from '../api/auth.js';

/**
 * Create or reset the dashboard administrator.
 *
 * Usage:
 *   npm run admin:create                     interactive
 *   npm run admin:create -- --user admin     generate a password and print it
 */

const log = createLogger('cli');

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

/** Readable but high-entropy: 4 groups of 5 from an unambiguous alphabet. */
function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(20);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join('')).join('-');
}

async function main(): Promise<void> {
  await runMigrations();

  const nonInteractive = Boolean(arg('user'));
  let username = arg('user') ?? '';
  let password = arg('password') ?? '';

  if (!nonInteractive) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    username = (await rl.question('Admin username: ')).trim();
    password = (await rl.question('Password (blank to generate): ')).trim();
    rl.close();
  }

  if (!username) {
    stdout.write('A username is required.\n');
    process.exitCode = 2;
    return;
  }

  let generated = false;
  if (!password) {
    password = generatePassword();
    generated = true;
  }

  if (password.length < 12) {
    stdout.write('Password must be at least 12 characters.\n');
    process.exitCode = 2;
    return;
  }

  const hash = await hashPassword(password);
  const existing = await adminsRepo.byUsername(username);

  if (existing) {
    await adminsRepo.setPassword(existing.id, hash);
    log.info({ username }, 'Administrator password reset');
    stdout.write(`\nPassword reset for "${username}".\n`);
  } else {
    await adminsRepo.create(username, hash);
    log.info({ username }, 'Administrator created');
    stdout.write(`\nAdministrator "${username}" created.\n`);
  }

  if (generated) {
    // Printed once, to the operator's terminal only. Never logged.
    stdout.write(`Generated password: ${password}\n`);
    stdout.write('Store it now; it is not recoverable and is not written to any log.\n');
  }
}

main()
  .catch((err) => {
    log.error({ err }, 'Could not create the administrator');
    process.exitCode = 1;
  })
  .finally(() => closePool());
