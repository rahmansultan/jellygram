import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { config } from '../config/index.js';
import { getLogger } from '../lib/logger.js';
import { assertInside, safeJoin } from '../lib/paths.js';
import { ensureDir, removeQuietly } from './storage.js';
import type { UploadPartRow } from '../db/types.js';

/**
 * Reassembling a file from the pieces a sender split it into.
 *
 * The concatenation is streamed: one part is read at a time through a fixed
 * buffer, so a 5 GB result costs the same memory as a 5 MB one. The SHA-256 of
 * the whole file is computed during the same pass rather than by re-reading it
 * afterwards.
 */

export class AssemblyError extends Error {
  constructor(
    message: string,
    readonly userMessage: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AssemblyError';
  }
}

/** Per-session scratch directory holding the downloaded parts. */
export function sessionPartsDir(sessionId: number): string {
  return safeJoin(config.multipart.partsDir, `session-${sessionId}`);
}

/** Where one part is stored while it waits for its siblings. */
export function partPath(sessionId: number, partNumber: number): string {
  return safeJoin(sessionPartsDir(sessionId), `part-${String(partNumber).padStart(4, '0')}`);
}

export async function ensureSessionDir(sessionId: number): Promise<string> {
  const dir = sessionPartsDir(sessionId);
  await ensureDir(config.multipart.partsDir, config.storage.mediaRoot);
  await ensureDir(dir, config.multipart.partsDir);
  return dir;
}

export interface AssemblyResult {
  path: string;
  bytes: number;
  sha256: string;
}

export interface AssemblyOptions {
  /** Reports total bytes written so far, for the Telegram progress message. */
  onProgress?: (bytesWritten: number, totalBytes: number) => void | Promise<void>;
  /** Polled between parts; aborts and removes the partial output when true. */
  shouldCancel?: () => boolean | Promise<boolean>;
}

export class AssemblyCancelledError extends Error {
  constructor() {
    super('Assembly cancelled');
    this.name = 'AssemblyCancelledError';
  }
}

/**
 * Concatenate `parts` (already in order) into a single file.
 *
 * Every part is verified to exist and to match its recorded size before a
 * single byte is written, because discovering a truncated part halfway through
 * would leave a corrupt file that still looks like a plausible video.
 */
export async function assembleParts(
  parts: readonly UploadPartRow[],
  destination: string,
  opts: AssemblyOptions = {},
): Promise<AssemblyResult> {
  const log = getLogger();

  if (parts.length === 0) {
    throw new AssemblyError('No parts to assemble', '❌ No parts were received.', false);
  }

  // --- Pre-flight: every part present, correctly sized, and in order --------
  let expectedTotal = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;

    if (part.part_number !== i + 1) {
      throw new AssemblyError(
        `Parts are not contiguous: expected ${i + 1}, found ${part.part_number}`,
        `❌ Part ${i + 1} is missing. Nothing was assembled.`,
        false,
      );
    }
    if (!part.stored_path) {
      throw new AssemblyError(
        `Part ${part.part_number} has no stored path`,
        `❌ Part ${part.part_number} was not downloaded. Nothing was assembled.`,
        true,
      );
    }

    let stat;
    try {
      stat = await fsp.stat(part.stored_path);
    } catch {
      throw new AssemblyError(
        `Part ${part.part_number} is missing from disk`,
        `❌ Part ${part.part_number} is no longer on the server. Please resend it.`,
        false,
      );
    }

    if (part.file_size > 0 && stat.size !== part.file_size) {
      throw new AssemblyError(
        `Part ${part.part_number} is ${stat.size} bytes, expected ${part.file_size}`,
        `❌ Part ${part.part_number} is incomplete. Please resend it.`,
        false,
      );
    }
    expectedTotal += stat.size;
  }

  if (expectedTotal > config.multipart.maxAssembledBytes) {
    throw new AssemblyError(
      `Assembled size ${expectedTotal} exceeds the configured ceiling`,
      `❌ The assembled file would be larger than the maximum allowed size.`,
      false,
    );
  }

  // --- Concatenate ----------------------------------------------------------
  assertInside(config.storage.downloadTmpDir, destination);
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: config.storage.dirMode });
  await removeQuietly(destination);

  const hash = crypto.createHash('sha256');
  let written = 0;

  const sink = fs.createWriteStream(destination, { mode: config.storage.fileMode, flags: 'w' });

  try {
    for (const part of parts) {
      if (await opts.shouldCancel?.()) throw new AssemblyCancelledError();

      const source = fs.createReadStream(part.stored_path!, { highWaterMark: 4 * 1024 * 1024 });

      await streamPipeline(
        source,
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            hash.update(chunk);
            written += chunk.length;
            yield chunk;
          }
        },
        // Keep the sink open across parts; `end: false` is what makes this a
        // concatenation rather than a sequence of truncations.
        sink,
        { end: false },
      );

      await opts.onProgress?.(written, expectedTotal);
      log.debug({ part: part.part_number, written }, 'Part appended');
    }
  } catch (err) {
    sink.destroy();
    await removeQuietly(destination);
    if (err instanceof AssemblyCancelledError) throw err;
    throw new AssemblyError(
      `Assembly failed: ${(err as Error).message}`,
      '❌ Could not reassemble the parts. Nothing was kept.',
      true,
    );
  }

  await new Promise<void>((resolve, reject) => {
    sink.end((err?: NodeJS.ErrnoException | null) => (err ? reject(err) : resolve()));
  });

  // --- Verify ---------------------------------------------------------------
  const stat = await fsp.stat(destination);
  if (stat.size !== expectedTotal) {
    await removeQuietly(destination);
    throw new AssemblyError(
      `Assembled file is ${stat.size} bytes, expected ${expectedTotal}`,
      '❌ The reassembled file was the wrong size, so it was discarded.',
      true,
    );
  }

  const sha256 = hash.digest('hex');
  log.info({ bytes: stat.size, parts: parts.length }, 'Assembled multi-part upload');

  return { path: destination, bytes: stat.size, sha256 };
}

/**
 * Remove a session's scratch directory.
 *
 * Called after a successful handoff, and after a cancellation. A failed
 * session keeps its parts so the sender can retry without re-uploading
 * everything.
 */
export async function cleanupSessionParts(sessionId: number): Promise<void> {
  const dir = sessionPartsDir(sessionId);
  assertInside(config.multipart.partsDir, dir);
  await fsp.rm(dir, { recursive: true, force: true }).catch((err) => {
    getLogger().warn({ err, sessionId }, 'Could not remove session parts directory');
  });
}

/** Bytes currently occupied by in-flight parts, for the storage view. */
export async function partsDirSize(): Promise<number> {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(config.multipart.partsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(config.multipart.partsDir, entry.name);
    if (!entry.isDirectory()) continue;
    try {
      for (const file of await fsp.readdir(full)) {
        total += (await fsp.stat(path.join(full, file))).size;
      }
    } catch {
      // Directory vanished mid-walk; skip it.
    }
  }
  return total;
}
