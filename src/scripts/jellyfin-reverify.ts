import { stdout } from 'node:process';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { closePool, query } from '../db/pool.js';
import { librariesRepo, mediaRepo, usersRepo } from '../db/repositories.js';
import { type VerifyOutcome, verifyMedia } from '../services/jellyfin-verify.js';
import { exists } from '../services/storage.js';
import type { MediaRow } from '../db/types.js';

/**
 * Re-check Jellyfin visibility for media that was filed but never verified.
 *
 *   npm run jellyfin:reverify
 *
 * The pipeline gives up after `JELLYFIN_VERIFY_TIMEOUT_SEC` so a slow or
 * unreadable library cannot strand an upload. When the cause is fixed — most
 * often group ownership, see `npm run media:repair` — this re-runs the check
 * without re-uploading anything.
 */

const log = createLogger('cli');

function say(text = ''): void {
  stdout.write(`${text}\n`);
}

async function verifyOne(media: MediaRow): Promise<VerifyOutcome> {
  const result = await verifyMedia(media);
  return result.outcome;
}

async function main(): Promise<void> {
  say();
  say('Jellyfin re-verification');
  say('========================');
  say();

  if (!config.jellyfin.configured) {
    say('Jellyfin is not configured (no API key). Nothing to do.');
    process.exitCode = 1;
    return;
  }

  const { rows } = await query<MediaRow>(
    `SELECT * FROM media WHERE jellyfin_verified = false ORDER BY id`,
  );
  if (rows.length === 0) {
    say('All media is already verified in Jellyfin.');
    return;
  }
  say(`${rows.length} unverified item(s).`);
  say();

  const tally: Record<VerifyOutcome, number> = {
    verified: 0,
    pending: 0,
    'missing-file': 0,
    'no-account': 0,
    'no-library': 0,
    unreachable: 0,
  };
  for (const media of rows) {
    const label = `#${media.id} ${media.title}${media.year ? ` (${media.year})` : ''}`;
    const outcome = await verifyOne(media).catch((err) => {
      log.warn({ err, mediaId: media.id }, 'Re-verification failed');
      return 'pending' as const;
    });
    tally[outcome] += 1;
    say(`  ${outcome.padEnd(13)} ${label}`);
  }

  say();
  say(
    `verified ${tally.verified}, still pending ${tally.pending}, ` +
      `file missing ${tally['missing-file']}, no linked account ${tally['no-account']}, ` +
      `no library ${tally['no-library']}, unreachable ${tally.unreachable}`,
  );
  if (tally.verified === 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    log.error({ err }, 'Re-verification run failed');
    say(`Failed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
