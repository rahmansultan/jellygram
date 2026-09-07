import path from 'node:path';
import { config } from '../config/index.js';
import { safeJoin, sanitizeSegment } from '../lib/paths.js';
import { episodeFileName, movieFolderName, seasonFolderName } from './parser.js';
import { userMediaDir } from './isolation.js';
import type { UserRow } from '../db/types.js';
import type { Identification } from './identify.js';

/**
 * Deciding where a file belongs, in the layout Jellyfin expects.
 *
 *   Movies/<user>/Interstellar (2014)/Interstellar (2014).mkv
 *   TV Shows/<user>/Breaking Bad/Season 02/Breaking Bad - S02E03.mkv
 *
 * Every segment goes through `safeJoin`, so no title — however hostile — can
 * place a file outside the user's own directory.
 */

export interface Placement {
  /** Absolute destination path for the media file. */
  targetPath: string;
  /** Directory that must exist before the move. */
  targetDir: string;
  /** Root that `targetPath` is asserted to live under. */
  root: string;
  /** Human-readable relative path, for messages and the dashboard. */
  relativePath: string;
  /** Whether renaming was skipped because the parse was ambiguous. */
  keptOriginalName: boolean;
}

/**
 * Renaming a file we are not confident about would destroy the only clue to
 * what it is. Below this threshold we keep the original filename and only
 * place it in the user's folder.
 */
const RENAME_CONFIDENCE = 0.6;

export function planPlacement(
  user: UserRow,
  identification: Identification,
  extension: string,
  safeOriginalFilename: string,
): Placement {
  const ext = sanitizeSegment(extension, 'bin').toLowerCase();

  if (identification.type === 'movie') {
    const root = config.storage.moviesRoot;
    const userDir = userMediaDir(user, 'movie');
    const folder = movieFolderName(identification.title, identification.year);

    const keptOriginalName = identification.confidence < RENAME_CONFIDENCE;
    const fileName = keptOriginalName ? safeOriginalFilename : `${folder}.${ext}`;

    const targetDir = safeJoin(userDir, folder);
    const targetPath = safeJoin(targetDir, fileName);

    return {
      targetPath,
      targetDir,
      root,
      relativePath: path.relative(config.storage.mediaRoot, targetPath),
      keptOriginalName,
    };
  }

  const root = config.storage.tvRoot;
  const userDir = userMediaDir(user, 'tv');
  const season = identification.season ?? 1;
  const episodes = identification.episodes.length ? identification.episodes : [identification.episode ?? 1];

  const showDir = safeJoin(userDir, identification.title);
  const targetDir = safeJoin(showDir, seasonFolderName(season));

  const keptOriginalName = identification.confidence < RENAME_CONFIDENCE;
  const stem = episodeFileName(identification.title, season, episodes);
  const fileName = keptOriginalName ? safeOriginalFilename : `${stem}.${ext}`;

  const targetPath = safeJoin(targetDir, fileName);

  return {
    targetPath,
    targetDir,
    root,
    relativePath: path.relative(config.storage.mediaRoot, targetPath),
    keptOriginalName,
  };
}

/**
 * Add a numeric suffix when the intended name is taken by a *different* file.
 * Used only after duplicate detection has already run, so this handles genuine
 * collisions (different cuts, different encodes) rather than re-uploads.
 */
export function withCollisionSuffix(targetPath: string, attempt: number): string {
  if (attempt <= 0) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const stem = path.basename(targetPath, ext);
  return path.join(dir, `${stem} (${attempt + 1})${ext}`);
}
