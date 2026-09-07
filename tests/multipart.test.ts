import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../src/config/index.js';
import {
  parsePartFilename,
  missingParts,
  isComplete,
  describeMissing,
  MAX_PART_NUMBER,
} from '../src/services/multipart.js';
import { assembleParts, AssemblyError } from '../src/services/assembly.js';
import type { UploadPartRow } from '../src/db/types.js';

/**
 * Multi-part upload logic: recognising a part from its name, deciding when a
 * set is complete, and concatenating the pieces back into the original bytes.
 */

// ---------------------------------------------------------------------------
// Recognising parts
// ---------------------------------------------------------------------------

test('the documented .partN form is recognised', () => {
  for (const [name, n] of [
    ['Movie.mkv.part1', 1],
    ['Movie.mkv.part2', 2],
    ['Movie.mkv.part3', 3],
  ] as const) {
    const parsed = parsePartFilename(name);
    assert.ok(parsed, `${name} should parse`);
    assert.equal(parsed.baseFilename, 'Movie.mkv');
    assert.equal(parsed.partNumber, n);
    assert.equal(parsed.totalParts, null);
  }
});

test('zero-padded part numbers work', () => {
  const parsed = parsePartFilename('Interstellar.2014.1080p.mkv.part07');
  assert.ok(parsed);
  assert.equal(parsed.baseFilename, 'Interstellar.2014.1080p.mkv');
  assert.equal(parsed.partNumber, 7);
});

test('a declared total is picked up from partNofM', () => {
  const parsed = parsePartFilename('Movie.mkv.part2of5');
  assert.ok(parsed);
  assert.equal(parsed.partNumber, 2);
  assert.equal(parsed.totalParts, 5);
  assert.equal(parsed.style, 'numeric-of');
});

test('a part number above its declared total is rejected', () => {
  assert.equal(parsePartFilename('Movie.mkv.part6of5'), null);
});

test("GNU split's alphabetic suffixes are ordered correctly", () => {
  assert.equal(parsePartFilename('Movie.mkv.partaa')?.partNumber, 1);
  assert.equal(parsePartFilename('Movie.mkv.partab')?.partNumber, 2);
  assert.equal(parsePartFilename('Movie.mkv.partaz')?.partNumber, 26);
  assert.equal(parsePartFilename('Movie.mkv.partba')?.partNumber, 27);
});

test('split -d numeric suffixes are recognised', () => {
  const parsed = parsePartFilename('Movie.mkv.001');
  assert.ok(parsed);
  assert.equal(parsed.baseFilename, 'Movie.mkv');
  assert.equal(parsed.partNumber, 1);
  assert.equal(parsed.style, 'bare-numeric');
});

test('an ordinary filename is not mistaken for a part', () => {
  for (const name of [
    'Interstellar.2014.1080p.BluRay.mkv',
    'Breaking.Bad.S02E03.mkv',
    'Movie.mp4',
    'The.Office.3x07.mkv',
    'Movie.2014',
    'Blade Runner 2049 (2017) 1080p.mp4',
  ]) {
    assert.equal(parsePartFilename(name), null, `${name} must stay on the single-file path`);
  }
});

test('a bare number without a leading zero is a year, not a part', () => {
  // `Movie.2014` would otherwise be read as part 2014 of something.
  assert.equal(parsePartFilename('Movie.2014'), null);
  assert.equal(parsePartFilename('Movie.mkv.2014'), null);
});

test('part numbers are bounded', () => {
  assert.equal(parsePartFilename('Movie.mkv.part0'), null);
  assert.equal(parsePartFilename(`Movie.mkv.part${MAX_PART_NUMBER + 1}`), null);
  assert.ok(parsePartFilename(`Movie.mkv.part${MAX_PART_NUMBER}`));
});

test('a directory component in the name is discarded', () => {
  const parsed = parsePartFilename('../../etc/Movie.mkv.part1');
  assert.ok(parsed);
  assert.equal(parsed.baseFilename, 'Movie.mkv');
});

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

test('a gap in the middle is detected', () => {
  assert.deepEqual(missingParts([1, 2, 4, 5], 5), [3]);
  assert.equal(isComplete([1, 2, 4, 5], 5), false);
});

test('a contiguous run with a known total is complete', () => {
  assert.deepEqual(missingParts([1, 2, 3], 3), []);
  assert.equal(isComplete([1, 2, 3], 3), true);
});

test('out-of-order arrival is still complete', () => {
  assert.equal(isComplete([3, 1, 2], 3), true);
});

test('without a declared total, completeness is judged from the highest seen', () => {
  assert.deepEqual(missingParts([1, 2, 3], null), []);
  assert.deepEqual(missingParts([1, 3], null), [2]);
  assert.equal(isComplete([1, 2, 3], null), true);
});

test('a set that starts at 2 is missing part 1', () => {
  assert.deepEqual(missingParts([2, 3], null), [1]);
  assert.equal(isComplete([2, 3], null), false);
});

test('no parts is never complete', () => {
  assert.equal(isComplete([], null), false);
  assert.equal(isComplete([], 3), false);
});

test('fewer parts than declared is incomplete even with no gaps', () => {
  assert.equal(isComplete([1, 2], 3), false);
});

test('a long missing list is summarised', () => {
  assert.equal(describeMissing([]), '');
  assert.equal(describeMissing([3]), '3');
  assert.match(describeMissing([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), /and 2 more$/);
});

// ---------------------------------------------------------------------------
// Reassembly
// ---------------------------------------------------------------------------

function fakePart(n: number, storedPath: string, size: number): UploadPartRow {
  return {
    id: n,
    session_id: 1,
    part_number: n,
    original_filename: `Movie.mkv.part${n}`,
    telegram_file_id: `file-${n}`,
    telegram_file_unique_id: `uniq-${n}`,
    telegram_message_id: null,
    file_size: size,
    bytes_downloaded: size,
    stored_path: storedPath,
    checksum_sha256: null,
    status: 'READY',
    error_message: null,
    created_at: new Date(),
    updated_at: new Date(),
    completed_at: new Date(),
  };
}

async function withParts<T>(
  chunks: readonly Buffer[],
  fn: (parts: UploadPartRow[], destination: string) => Promise<T>,
): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jellygram-assembly-'));
  // The assembler asserts its output lands in the configured temp directory.
  const destination = path.join(config.storage.downloadTmpDir, `assembly-test-${Date.now()}`);
  try {
    const parts: UploadPartRow[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const p = path.join(dir, `part-${i + 1}`);
      await fsp.writeFile(p, chunks[i]!);
      parts.push(fakePart(i + 1, p, chunks[i]!.length));
    }
    return await fn(parts, destination);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(destination, { force: true });
  }
}

test('parts are concatenated back into the original bytes', async () => {
  const original = crypto.randomBytes(3 * 1024 * 1024);
  const chunks = [original.subarray(0, 1_000_000), original.subarray(1_000_000, 2_500_000), original.subarray(2_500_000)];

  await withParts(chunks, async (parts, destination) => {
    const result = await assembleParts(parts, destination);

    assert.equal(result.bytes, original.length);
    assert.deepEqual(await fsp.readFile(destination), original, 'bytes must match exactly');

    const expected = crypto.createHash('sha256').update(original).digest('hex');
    assert.equal(result.sha256, expected, 'the streamed hash must match the whole file');
  });
});

test('the assembled checksum matches a fresh hash of the file', async () => {
  const chunks = [Buffer.from('alpha'), Buffer.from('beta'), Buffer.from('gamma')];
  await withParts(chunks, async (parts, destination) => {
    const result = await assembleParts(parts, destination);
    const onDisk = crypto.createHash('sha256').update(await fsp.readFile(destination)).digest('hex');
    assert.equal(result.sha256, onDisk);
  });
});

test('a gap in the part numbers is refused before anything is written', async () => {
  const chunks = [Buffer.from('one'), Buffer.from('three')];
  await withParts(chunks, async (parts, destination) => {
    parts[1]!.part_number = 3; // 1, 3 — part 2 never arrived

    await assert.rejects(
      () => assembleParts(parts, destination),
      (err: unknown) => {
        assert.ok(err instanceof AssemblyError);
        assert.match(err.userMessage, /missing/i);
        return true;
      },
    );
    assert.ok(!fs.existsSync(destination), 'no partial output may be left behind');
  });
});

test('a truncated part is refused', async () => {
  const chunks = [Buffer.alloc(1024, 1), Buffer.alloc(1024, 2)];
  await withParts(chunks, async (parts, destination) => {
    // Claim a larger size than the file actually has.
    parts[1]!.file_size = 4096;

    await assert.rejects(
      () => assembleParts(parts, destination),
      (err: unknown) => {
        assert.ok(err instanceof AssemblyError);
        assert.match(err.userMessage, /incomplete/i);
        return true;
      },
    );
    assert.ok(!fs.existsSync(destination));
  });
});

test('a part missing from disk is refused', async () => {
  const chunks = [Buffer.from('a'), Buffer.from('b')];
  await withParts(chunks, async (parts, destination) => {
    await fsp.rm(parts[1]!.stored_path!);
    await assert.rejects(() => assembleParts(parts, destination), AssemblyError);
    assert.ok(!fs.existsSync(destination));
  });
});

test('an empty part list is refused', async () => {
  const destination = path.join(config.storage.downloadTmpDir, 'assembly-empty-test');
  await assert.rejects(() => assembleParts([], destination), AssemblyError);
});

test('assembly never buffers the whole file in memory', async () => {
  // 32 MB across four parts, with a heap-growth assertion well below that.
  const chunks = [0, 1, 2, 3].map((i) => Buffer.alloc(8 * 1024 * 1024, i + 1));

  await withParts(chunks, async (parts, destination) => {
    const before = process.memoryUsage().heapUsed;
    const result = await assembleParts(parts, destination);
    const growth = process.memoryUsage().heapUsed - before;

    assert.equal(result.bytes, 32 * 1024 * 1024);
    assert.ok(
      growth < 12 * 1024 * 1024,
      `heap grew by ${Math.round(growth / 1024 / 1024)} MB assembling 32 MB`,
    );
  });
});

test('a cancelled assembly leaves no output', async () => {
  const chunks = [Buffer.alloc(1024, 1), Buffer.alloc(1024, 2), Buffer.alloc(1024, 3)];
  await withParts(chunks, async (parts, destination) => {
    let calls = 0;
    await assert.rejects(
      () =>
        assembleParts(parts, destination, {
          shouldCancel: () => {
            calls += 1;
            return calls > 1; // cancel after the first part
          },
        }),
      /cancelled/i,
    );
    assert.ok(!fs.existsSync(destination));
  });
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

test('the assembled ceiling is 5 GB', () => {
  assert.equal(config.multipart.maxAssembledBytes, 5 * 1024 * 1024 * 1024);
  assert.equal(config.multipart.maxAssembledBytes, 5_368_709_120);
});

test('the assembled ceiling is far above any single Telegram file', () => {
  assert.ok(config.multipart.maxAssembledBytes > config.storage.maxFileSizeBytes);
});

test('the parts directory sits inside the media root', () => {
  assert.ok(config.multipart.partsDir.startsWith(config.storage.mediaRoot + path.sep));
});
