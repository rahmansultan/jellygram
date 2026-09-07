import { extensionOf } from '../lib/paths.js';

/**
 * Recognising a multi-part upload from its filename.
 *
 * Telegram cannot deliver one file above its per-file ceiling, so a large
 * movie arrives as pieces the sender split locally. This module decides
 * whether a given filename is a piece, which piece it is, and what the
 * original file was called — nothing here touches the filesystem.
 *
 * The suffixes understood are the ones the common splitting tools actually
 * produce:
 *
 *   Movie.mkv.part1      .part2   .part3        explicit, 1-based
 *   Movie.mkv.part1of3   .part2of3              explicit, with a declared total
 *   Movie.mkv.part01     .part02                zero-padded
 *   Movie.mkv.partaa     .partab                `split -b … file.mkv.part`
 *   Movie.mkv.001        .002                   `split -d -a 3 -b …`
 *   Movie.mkv.7z.001                            archive splitters
 */

export interface ParsedPart {
  /** The original filename with the part suffix removed. */
  baseFilename: string;
  /** 1-based index; the order the pieces must be concatenated in. */
  partNumber: number;
  /** Total pieces, when the naming declares it. */
  totalParts: number | null;
  /** Which naming form matched, for diagnostics and messages. */
  style: 'numeric' | 'numeric-of' | 'alphabetic' | 'bare-numeric';
}

/** Highest part index we will accept, to bound a session's size and effort. */
export const MAX_PART_NUMBER = 512;

/**
 * `aa` -> 1, `ab` -> 2, … `az` -> 26, `ba` -> 27.
 *
 * GNU `split` names its first file `aa`, so the suffix is positional base-26
 * with `a` as zero, and the 1-based part number is that value plus one.
 */
function alphabeticToIndex(suffix: string): number | null {
  if (!/^[a-z]{1,3}$/.test(suffix)) return null;
  let value = 0;
  for (const char of suffix) {
    value = value * 26 + (char.charCodeAt(0) - 97); // 'a' -> 0
  }
  return value + 1;
}

/**
 * Decide whether `filename` is one piece of a larger file.
 *
 * Returns `null` for an ordinary single file, which is the overwhelmingly
 * common case and must stay on the existing single-file path.
 */
export function parsePartFilename(filename: string): ParsedPart | null {
  const name = String(filename ?? '')
    .split(/[/\\]/)
    .pop() ?? '';
  if (!name) return null;

  // `.part1of3` / `.part01of03`
  const ofMatch = name.match(/^(.+?)\.part(\d{1,4})of(\d{1,4})$/i);
  if (ofMatch?.[1] && ofMatch[2] && ofMatch[3]) {
    const partNumber = Number(ofMatch[2]);
    const totalParts = Number(ofMatch[3]);
    if (valid(partNumber) && valid(totalParts) && partNumber <= totalParts) {
      return { baseFilename: ofMatch[1], partNumber, totalParts, style: 'numeric-of' };
    }
    return null;
  }

  // `.part1` / `.part01`
  const numericMatch = name.match(/^(.+?)\.part(\d{1,4})$/i);
  if (numericMatch?.[1] && numericMatch[2]) {
    const partNumber = Number(numericMatch[2]);
    if (valid(partNumber)) {
      return { baseFilename: numericMatch[1], partNumber, totalParts: null, style: 'numeric' };
    }
    return null;
  }

  // `.partaa` / `.partab` — GNU split's default suffixes.
  const alphaMatch = name.match(/^(.+?)\.part([a-z]{1,3})$/i);
  if (alphaMatch?.[1] && alphaMatch[2]) {
    const partNumber = alphabeticToIndex(alphaMatch[2].toLowerCase());
    if (partNumber !== null && valid(partNumber)) {
      return { baseFilename: alphaMatch[1], partNumber, totalParts: null, style: 'alphabetic' };
    }
    return null;
  }

  // `.001` / `.002` — only when what remains still looks like a real filename
  // with an extension, so `Movie.2014` (a year) is never read as a part.
  const bareMatch = name.match(/^(.+?)\.(\d{2,3})$/);
  if (bareMatch?.[1] && bareMatch[2]) {
    const partNumber = Number(bareMatch[2]);
    const base = bareMatch[1];
    // A leading zero is what distinguishes a split suffix from a year or a
    // resolution: `split -d` writes 001, never 1.
    const looksLikeSplitSuffix = /^0\d+$/.test(bareMatch[2]);
    if (looksLikeSplitSuffix && valid(partNumber) && extensionOf(base).length > 0) {
      return { baseFilename: base, partNumber, totalParts: null, style: 'bare-numeric' };
    }
    return null;
  }

  return null;
}

function valid(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_PART_NUMBER;
}

/**
 * Which part numbers are missing from a contiguous 1..max run.
 *
 * A session is only assembled when this is empty: concatenating around a gap
 * would produce a corrupt file that still looks plausible on disk.
 */
export function missingParts(received: readonly number[], expected: number | null): number[] {
  const present = new Set(received);
  const highest = received.length > 0 ? Math.max(...received) : 0;
  const upTo = expected ?? highest;

  const missing: number[] = [];
  for (let i = 1; i <= upTo; i += 1) {
    if (!present.has(i)) missing.push(i);
  }
  return missing;
}

/** True when every part from 1 to the expected total is present. */
export function isComplete(received: readonly number[], expected: number | null): boolean {
  if (received.length === 0) return false;
  if (expected !== null && received.length !== expected) return false;
  return missingParts(received, expected).length === 0;
}

/** `1, 2, 4` -> `3` missing; renders a short human summary for Telegram. */
export function describeMissing(missing: readonly number[]): string {
  if (missing.length === 0) return '';
  if (missing.length <= 8) return missing.join(', ');
  return `${missing.slice(0, 8).join(', ')} and ${missing.length - 8} more`;
}

/**
 * A stable, human-readable label for the session, used in Telegram messages
 * and on the dashboard.
 */
export function sessionLabel(baseFilename: string, expected: number | null): string {
  return expected ? `${baseFilename} (${expected} parts)` : baseFilename;
}
