#!/usr/bin/env node
/**
 * Refuse to run a compiled entry point that has not been compiled yet.
 *
 * Every command under `dist/` — migrate, setup, admin:create, the three
 * services — fails on a fresh clone with a raw Node stack trace:
 *
 *   Error: Cannot find module '…/dist/scripts/migrate.js'
 *       at Function._resolveFilename (node:internal/modules/cjs/loader…)
 *
 * which says nothing about the one thing that would fix it. This is wired in
 * as a `pre` hook on those scripts so the answer arrives instead.
 *
 * Plain JavaScript in `scripts/`, not TypeScript in `src/`, for the obvious
 * reason: a check for "is it built?" cannot itself need building.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const entry = process.argv[2];

if (!entry) {
  process.stderr.write('require-build: expected a path under dist/\n');
  process.exit(2);
}

if (fs.existsSync(path.join(ROOT, entry))) process.exit(0);

process.stderr.write(
  `\nThis command runs ${entry}, which does not exist yet.\n\n` +
    '  npm run build\n\n' +
    'compiles src/ into dist/ and takes a few seconds. Run it once after a\n' +
    'clone and again after every change to the TypeScript sources.\n\n',
);
process.exit(1);
