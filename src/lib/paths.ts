import path from 'node:path';

/**
 * Path and filename safety.
 *
 * Everything in here assumes its input is hostile: filenames arrive from
 * Telegram, titles arrive from filenames and from TMDB. Nothing derived from
 * those may escape the configured media root, and nothing is ever handed to a
 * shell.
 */

/** Control characters plus anything illegal or ambiguous in a path segment. */
const ILLEGAL_CHARS = /[\u0000-\u001f<>:"/\\|?*]/g;

/** Windows reserved device names: harmless on ext4, not on SMB shares or clients. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Combining marks, stripped when building an ASCII slug. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

const MAX_SEGMENT_BYTES = 200;

function truncateToBytes(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  let out = input;
  while (out.length > 0 && Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * Reduce arbitrary text to a single safe path segment.
 *
 * Guarantees about the result: it contains no separators, is never `.` or
 * `..`, never starts with `-` or `.`, is non-empty, and is length-bounded.
 * Therefore `path.join(root, sanitizeSegment(x))` can never leave `root`.
 */
export function sanitizeSegment(input: string, fallback = 'unnamed'): string {
  let s = String(input ?? '')
    .normalize('NFC')
    .replace(ILLEGAL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip leading dots and dashes so we cannot produce `..`, a hidden file, or
  // something a CLI would read as a flag.
  s = s.replace(/^[.\-\s]+/, '').replace(/[.\s]+$/, '');

  if (RESERVED_NAMES.test(s)) s = `_${s}`;
  s = truncateToBytes(s, MAX_SEGMENT_BYTES).trim().replace(/[.\s]+$/, '');

  return s.length > 0 ? s : fallback;
}

/** Lower-cased, dot-less extension of a filename, or `''`. */
export function extensionOf(filename: string): string {
  const base = String(filename ?? '')
    .split(/[/\\]/)
    .pop() ?? '';
  const idx = base.lastIndexOf('.');
  if (idx <= 0 || idx === base.length - 1) return '';
  return base
    .slice(idx + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Filename without its extension, with any directory component discarded. */
export function stemOf(filename: string): string {
  const base = String(filename ?? '')
    .split(/[/\\]/)
    .pop() ?? '';
  const ext = extensionOf(base);
  return ext ? base.slice(0, base.length - ext.length - 1) : base;
}

/**
 * Turn a Telegram-supplied filename into a safe `name.ext` pair.
 *
 * The extension is validated against the allow-list by the caller; here we
 * only guarantee the shape.
 */
export function sanitizeFilename(filename: string, fallbackStem = 'file'): string {
  const ext = extensionOf(filename);
  const stem = sanitizeSegment(stemOf(filename), fallbackStem);
  return ext ? `${stem}.${ext}` : stem;
}

export class PathEscapeError extends Error {
  constructor(attempted: string, root: string) {
    super(`Refusing path outside media root: ${attempted} (root ${root})`);
    this.name = 'PathEscapeError';
  }
}

/**
 * Join `segments` under `root` and prove the result stays inside `root`.
 *
 * This is the single choke point every media path goes through. It sanitises
 * each segment *and* re-checks the resolved result, so a bug in
 * `sanitizeSegment` alone still cannot produce a traversal.
 */
export function safeJoin(root: string, ...segments: string[]): string {
  const absRoot = path.resolve(root);
  const clean = segments
    .flatMap((s) => String(s ?? '').split(/[/\\]+/))
    .filter((s) => s.length > 0)
    .map((s) => sanitizeSegment(s));

  const candidate = path.resolve(absRoot, ...clean);
  if (!isInside(absRoot, candidate)) throw new PathEscapeError(candidate, absRoot);
  return candidate;
}

/** True when `child` is `parent` itself or lies beneath it. */
export function isInside(parent: string, child: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * Assert that an already-built absolute path is inside `root`.
 * Used before any write, unlink or rename.
 */
export function assertInside(root: string, target: string): string {
  if (!isInside(root, target)) throw new PathEscapeError(target, root);
  return path.resolve(target);
}

/** Directory-name-safe slug used for a user's private media folder. */
export function storageSlug(input: string): string {
  const s = String(input ?? '')
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s.length > 0 ? s : 'user';
}
