import { stdout } from 'node:process';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { closePool } from '../db/pool.js';
import { auditRepo, uploadTokensRepo, usersRepo } from '../db/repositories.js';

/**
 * Issue or revoke an uploader token for a media user.
 *
 *   npm run upload:token -- --user alice
 *   npm run upload:token -- --user alice --revoke
 *
 * The token is printed once, to this terminal only, and never logged. Only its
 * SHA-256 is stored, so it cannot be recovered later — reissue instead.
 */

const log = createLogger('cli');

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function say(text = ''): void {
  stdout.write(`${text}\n`);
}

async function main(): Promise<void> {
  const wanted = arg('user');
  const revoke = process.argv.includes('--revoke');

  const users = await usersRepo.list();

  if (!wanted) {
    say('\nUsage: npm run upload:token -- --user <name|telegram id> [--revoke]\n');
    say('Registered users:');
    for (const u of users) {
      say(
        `  ${u.name}  (telegram ${u.telegram_chat_id}, jellyfin ${u.jellyfin_username})` +
          `${u.upload_token_hash ? '  [token issued]' : ''}`,
      );
    }
    say();
    process.exitCode = 2;
    return;
  }

  const needle = wanted.trim().toLowerCase();
  const user =
    users.find((u) => u.name.toLowerCase() === needle) ??
    users.find((u) => String(u.telegram_chat_id) === needle) ??
    users.find((u) => u.jellyfin_username.toLowerCase() === needle) ??
    users.find((u) => u.name.toLowerCase().includes(needle));

  if (!user) {
    say(`No user matches "${wanted}".`);
    process.exitCode = 1;
    return;
  }

  if (revoke) {
    await uploadTokensRepo.revoke(user.id);
    await auditRepo.log({
      actor_type: 'admin',
      action: 'upload_token.revoked',
      entity_type: 'user',
      entity_id: String(user.id),
    });
    log.info({ userId: user.id }, 'Upload token revoked');
    say(`\nUpload token for ${user.name} revoked. The uploader will stop working for them.\n`);
    return;
  }

  const replacing = Boolean(user.upload_token_hash);
  const token = await uploadTokensRepo.issue(user.id);

  await auditRepo.log({
    actor_type: 'admin',
    action: 'upload_token.issued',
    entity_type: 'user',
    entity_id: String(user.id),
    detail: { replaced: replacing },
  });
  log.info({ userId: user.id, replaced: replacing }, 'Upload token issued');

  say();
  say(`Upload token for ${user.name}`);
  say('='.repeat(30 + user.name.length));
  if (replacing) say('\nThe previous token has been replaced and no longer works.\n');
  say('Configure the uploader with:');
  say();
  say(`  node uploader/jellygram-upload.mjs --login`);
  say();
  say('and paste this when asked. It is shown once and cannot be recovered:');
  say();
  say(`  ${token}`);
  say();
  say(`Server URL for this machine: http://127.0.0.1:${config.admin.port}`);
  say(`From another machine, use the server's LAN or Tailscale address on port ${config.admin.port}.`);
  say();
}

main()
  .catch((err) => {
    log.error({ err }, 'Could not manage the upload token');
    say(`Failed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
