#!/usr/bin/env node
/**
 * Create `.env` from `.env.example` and fill in what a machine can decide.
 *
 * This runs BEFORE anything else, which is why it is plain JavaScript in its
 * own directory rather than a compiled script under `src/scripts/`: every one
 * of those imports the configuration module, and the configuration module
 * refuses to load until `DATABASE_URL` and `ADMIN_SESSION_SECRET` exist. A
 * first-run helper cannot depend on the thing it is helping you create.
 *
 *   npm run init
 *   npm run init -- --database-url postgresql://jellygram:pw@127.0.0.1:5432/jellygram
 *   npm run init -- --force            overwrite an existing .env
 *
 * It never overwrites an existing .env unless asked, and the file it writes is
 * mode 0600.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = path.join(ROOT, '.env.example');
const TARGET = path.join(ROOT, '.env');

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const force = argv.includes('--force');

const say = (line = '') => process.stdout.write(`${line}\n`);

if (!fs.existsSync(EXAMPLE)) {
  say(`Cannot find ${EXAMPLE}. Run this from a checkout of the repository.`);
  process.exit(1);
}

if (fs.existsSync(TARGET) && !force) {
  say(`${TARGET} already exists. Nothing was changed.`);
  say('Edit it by hand, run `npm run setup` for the guided credential prompts,');
  say('or pass --force to start over from .env.example.');
  process.exit(0);
}

let content = fs.readFileSync(EXAMPLE, 'utf8');

/** Replace `KEY=<anything>` on its own line, leaving every comment in place. */
function set(key, value) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (!pattern.test(content)) {
    content = `${content.replace(/\n*$/, '\n')}${key}=${value}\n`;
    return;
  }
  content = content.replace(pattern, () => `${key}=${value}`);
}

// A session key is the one required value nobody should choose by hand.
const secret = crypto.randomBytes(48).toString('base64');
set('ADMIN_SESSION_SECRET', secret);

const databaseUrl = flag('database-url');
if (databaseUrl) set('DATABASE_URL', databaseUrl);

// Media paths default to /srv/media in the example, which is a good production
// answer and a poor first-run one: it usually does not exist and is usually not
// writable.
//
// Default to a directory inside the checkout instead. It is writable by
// definition, it is already in .gitignore, and — the reason it is not
// ~/media — it cannot silently adopt a media library that is already there.
// A first run that quietly points at somebody's existing collection is a much
// worse failure than one that points somewhere empty.
//
// Move it before you have anything worth keeping; changing it later is one edit
// plus moving the files.
const mediaRoot = flag('media-root') ?? path.join(ROOT, 'media');
for (const [key, value] of [
  ['MEDIA_ROOT', mediaRoot],
  ['MOVIES_ROOT', path.join(mediaRoot, 'movies')],
  ['TV_ROOT', path.join(mediaRoot, 'tv')],
  ['DOWNLOAD_TMP_DIR', path.join(mediaRoot, '.incoming')],
  ['QUARANTINE_DIR', path.join(mediaRoot, '.quarantine')],
]) {
  set(key, value);
}

// `id -u` is right far more often than a guessed 1000, and getting it wrong
// leaves every file the local Bot API server downloads unremovable.
if (typeof process.getuid === 'function') set('BOTAPI_UID', String(process.getuid()));

fs.writeFileSync(TARGET, content, { mode: 0o600 });
fs.chmodSync(TARGET, 0o600);

say(`Wrote ${TARGET} (mode 0600).`);
say();
say('Generated for you:');
say('  ADMIN_SESSION_SECRET   a fresh 48-byte key');
say(`  MEDIA_ROOT             ${mediaRoot}`);
if (databaseUrl) say('  DATABASE_URL           as given');
say();
say('Still to do, in this order:');
// `build` comes before everything else because every command below it runs a
// file under dist/. Leaving it out of this list sent a first-time reader
// straight into "Cannot find module '.../dist/scripts/migrate.js'".
let step = 0;
const next = (line) => say(`  ${(step += 1)}. ${line}`);
if (!databaseUrl) next('Set DATABASE_URL to a PostgreSQL database you own  (docs/database.md)');
next('npm run build          compile src/ into dist/');
next('npm run migrate        create the schema');
next('npm run setup          bot token, Jellyfin key, TMDB key');
next('npm run admin:create   your dashboard login');
say();
say('.env is the only file holding secrets. It is already in .gitignore.');
