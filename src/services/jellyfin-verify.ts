import { config } from '../config/index.js';
import { getLogger } from '../lib/logger.js';
import { librariesRepo, mediaRepo, usersRepo } from '../db/repositories.js';
import * as jf from './jellyfin.js';
import { exists } from './storage.js';
import type { MediaRow } from '../db/types.js';

/**
 * Ask Jellyfin to index a filed item, then confirm it actually did.
 *
 * This existed three times — in the pipeline, in the reverify CLI, and about to
 * appear again behind an API route — with the retry semantics reimplemented
 * each time. One copy means the rule that matters cannot drift: verification is
 * a *fact*, established by finding the item at the exact path, never assumed
 * from a scan having been requested.
 */

export type VerifyOutcome =
  | 'verified'
  | 'pending'
  | 'missing-file'
  | 'no-account'
  | 'no-library'
  | 'unreachable';

export interface VerifyResult {
  outcome: VerifyOutcome;
  itemId?: string;
  /** Safe to show an administrator. */
  message: string;
}

export interface VerifyOptions {
  /** Overrides `JELLYFIN_VERIFY_TIMEOUT_SEC`; used to keep a request bounded. */
  timeoutMs?: number;
  /** Skip the scan request and only look. Used when a scan just ran. */
  skipScan?: boolean;
}

export async function verifyMedia(media: MediaRow, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const log = getLogger().child({ mediaId: media.id });

  if (!config.jellyfin.configured) {
    return { outcome: 'unreachable', message: 'Jellyfin is not configured (no API key).' };
  }
  // A missing file is not a Jellyfin problem, and scanning for it would only
  // produce a confusing "still pending".
  if (!(await exists(media.path))) {
    return { outcome: 'missing-file', message: 'The file is no longer on disk.' };
  }

  const user = await usersRepo.byId(media.user_id);
  if (!user?.jellyfin_user_id) {
    return { outcome: 'no-account', message: 'This user has no linked Jellyfin account to verify against.' };
  }

  const libraries = await librariesRepo.listForUser(media.user_id);
  const library = libraries.find((l) => l.media_type === media.type);
  if (!library) {
    return {
      outcome: 'no-library',
      message: `No ${media.type} library is provisioned for this user. Re-provision them.`,
    };
  }

  if (!opts.skipScan) {
    try {
      await jf.requestScan(library.jellyfin_item_id ?? null);
    } catch (err) {
      log.warn({ err }, 'Jellyfin scan request failed');
      return { outcome: 'unreachable', message: `Jellyfin could not be reached: ${(err as Error).message}` };
    }
  }

  const timeoutMs = opts.timeoutMs ?? config.jellyfin.verifyTimeoutSec * 1000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const item = await jf.findItemByPath(user.jellyfin_user_id, media.path, media.title);
      if (item) {
        await mediaRepo.setJellyfinItem(media.id, item.id, true);
        return { outcome: 'verified', itemId: item.id, message: 'Verified visible in Jellyfin.' };
      }
    } catch (err) {
      log.warn({ err }, 'Jellyfin lookup failed');
      return { outcome: 'unreachable', message: `Jellyfin could not be reached: ${(err as Error).message}` };
    }

    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, config.jellyfin.verifyIntervalSec * 1000));
  }

  // Deliberately not recorded as verified: indexing may simply be slow, and
  // claiming success here is exactly the lie this whole path exists to avoid.
  return {
    outcome: 'pending',
    message: 'Jellyfin has not indexed it yet. It may appear after the next scan.',
  };
}
