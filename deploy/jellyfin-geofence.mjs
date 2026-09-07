#!/usr/bin/env node
/**
 * Confine Jellyfin's remote access to one country.
 *
 * OPTIONAL, and only relevant if you have deliberately exposed Jellyfin to the
 * internet. Jellyfin can hold a list of addresses allowed to reach it from
 * outside the local network. This fills that list with every block the
 * regional registry has assigned to one country, plus your own private
 * networks, so a scanner anywhere else is refused by Jellyfin itself before it
 * reaches the login page.
 *
 * It is a filter, not a security boundary — addresses are spoofable and users
 * travel. Treat it as noise reduction on a public port, nothing more.
 *
 * The registry data is authoritative but not static: blocks are added a few
 * times a year. Run it again now and then — report-only by default, so it can
 * be run without consequence to see what would change.
 *
 *   node deploy/jellyfin-geofence.mjs --country DE
 *   node deploy/jellyfin-geofence.mjs --country DE --apply
 *   node deploy/jellyfin-geofence.mjs --clear --apply    # remove the fence
 *
 * Options (each also readable from the environment, which is how the systemd
 * unit passes them):
 *
 *   --country XX          ISO 3166-1 alpha-2 code.        GEOFENCE_COUNTRY
 *   --registry URL        Override the registry file.     GEOFENCE_REGISTRY
 *   --allow CIDR          Extra always-allowed block,     GEOFENCE_ALWAYS_ALLOW
 *                         repeatable.                     (comma-separated)
 *   --must-include IP     Refuse to apply a list that
 *                         would not contain this address.
 *   --apply / --clear
 *
 * The registry is picked from the country's own RIR when --registry is not
 * given. A safety check refuses to apply a list that would not contain the
 * address given with --must-include, which should be one you have actually
 * connected from: the failure mode of a country fence is locking out its
 * owner, and that is the one thing this script must never do quietly.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argvList = process.argv.slice(2);
const args = new Set(argvList);
const apply = args.has('--apply');
const clear = args.has('--clear');
const opt = (name) => {
  const i = argvList.indexOf(`--${name}`);
  return i === -1 ? undefined : argvList[i + 1];
};
const optAll = (name) => argvList.flatMap((a, i, all) => (a === `--${name}` ? [all[i + 1]] : []));

const mustInclude = optAll('must-include').filter(Boolean);

const COUNTRY = (opt('country') ?? process.env.GEOFENCE_COUNTRY ?? '').toUpperCase();
if (!clear && !/^[A-Z]{2}$/.test(COUNTRY)) {
  console.error(
    'A country is required: --country XX (ISO 3166-1 alpha-2), or GEOFENCE_COUNTRY in the environment.',
  );
  process.exit(2);
}

/**
 * The five regional registries publish the same "delegated-extended" format,
 * so any of them can be parsed by the code below — but each lists only its own
 * region's countries. Rather than ask you which registry serves your country,
 * try them in turn and use the first that actually mentions it.
 */
const REGISTRIES = [
  'https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-extended-latest',
  'https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest',
  'https://ftp.apnic.net/stats/apnic/delegated-apnic-extended-latest',
  'https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-extended-latest',
  'https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-extended-latest',
];
const registryOverride = opt('registry') ?? process.env.GEOFENCE_REGISTRY;

/**
 * Always allowed, whatever the registry says.
 *
 * The defaults are the private and carrier-grade ranges — your LAN, and the
 * 100.64/10 space that Tailscale and similar overlays live in — because the
 * one thing this list must never do is fence out the machines you administer
 * it from. Narrow or extend it with --allow.
 */
const ALWAYS = (
  optAll('allow').filter(Boolean).length
    ? optAll('allow').filter(Boolean)
    : (process.env.GEOFENCE_ALWAYS_ALLOW ?? '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
);

/**
 * Configuration comes from the environment, as it does for every service: the
 * systemd unit loads `.env` through EnvironmentFile, and a shell run can
 * export the two values or rely on the fallback below, which reads the file
 * the way dotenv does — unquoting, ignoring comments — rather than by hand.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fromDotenv(key) {
  try {
    const line = readFileSync(path.join(root, '.env'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${key}=`));
    if (!line) return undefined;
    let value = line.slice(key.length + 1).trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '');
    return value;
  } catch {
    return undefined;
  }
}
const base = (process.env.JELLYFIN_URL || fromDotenv('JELLYFIN_URL') || 'http://127.0.0.1:8096').replace(/\/+$/, '');
const apiKey = process.env.JELLYFIN_API_KEY || fromDotenv('JELLYFIN_API_KEY') || '';
if (!apiKey) {
  console.error('JELLYFIN_API_KEY is not set; nothing can be read or written.');
  process.exit(2);
}
const headers = { 'X-Emby-Token': apiKey, 'Content-Type': 'application/json' };

// ---------------------------------------------------------------------------
// Address arithmetic
// ---------------------------------------------------------------------------

const v4ToInt = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const intToV4 = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

/** A start address and a count, as the registry gives them, into CIDR blocks. */
function v4Blocks(start, count) {
  const out = [];
  let addr = v4ToInt(start);
  let left = count;
  while (left > 0) {
    // The largest aligned block that fits at this address and within the count.
    let size = 1;
    while (size * 2 <= left && addr % (size * 2) === 0) size *= 2;
    out.push(`${intToV4(addr)}/${32 - Math.log2(size)}`);
    addr += size;
    left -= size;
  }
  return out;
}

function v4Contains(cidr, ip) {
  const [net, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return ((v4ToInt(net) & mask) >>> 0) === ((v4ToInt(ip) & mask) >>> 0);
}

// ---------------------------------------------------------------------------

/**
 * Fetch one registry file, trying a few times.
 *
 * These are mirrors on the far side of the internet and they drop connections
 * now and then; one such drop should not leave the fence a week stale. Each
 * attempt is bounded, so a registry that trickles bytes for an hour cannot
 * hold the weekly unit open either — a timer does not fire while its service
 * is still running.
 */
async function fetchRegistry(url) {
  let lastError;
  // Three attempts of four minutes each: the files are a few megabytes, and a
  // slow link can genuinely take over a minute for one. Comfortably inside the
  // unit's fifteen-minute start timeout.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(240_000) });
      if (!res.ok) throw new Error(`registry answered ${res.status}`);
      return await res.text();
    } catch (err) {
      lastError = err;
      console.error(`registry attempt ${attempt} failed: ${err?.cause?.code ?? err?.message ?? err}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 20_000));
    }
  }
  throw lastError;
}

function parseRegistry(text) {
  const v4 = [];
  const v6 = [];
  for (const line of text.split('\n')) {
    const f = line.split('|');
    if (f[1] !== COUNTRY) continue;
    if (f[2] === 'ipv4') v4.push(...v4Blocks(f[3], Number(f[4])));
    if (f[2] === 'ipv6') v6.push(`${f[3]}/${f[4]}`);
  }
  return { v4, v6 };
}

/**
 * Find the registry that actually lists this country.
 *
 * Each RIR publishes only its own region, so the wrong one parses cleanly and
 * yields nothing — which would silently produce a fence containing only the
 * always-allowed blocks and lock out every real user. An empty result is
 * therefore treated as "wrong registry", not as "no blocks".
 */
async function registryBlocks() {
  const candidates = registryOverride ? [registryOverride] : REGISTRIES;
  let lastError;
  for (const url of candidates) {
    let text;
    try {
      text = await fetchRegistry(url);
    } catch (err) {
      lastError = err;
      continue;
    }
    const parsed = parseRegistry(text);
    if (parsed.v4.length || parsed.v6.length) {
      console.log(`Registry: ${url}`);
      return parsed;
    }
    console.error(`  ${url} does not list ${COUNTRY}; trying the next registry.`);
  }
  if (lastError) throw lastError;
  throw new Error(
    `No registry lists country "${COUNTRY}". Check the code, or name the file with --registry.`,
  );
}

async function readNetwork() {
  const res = await fetch(`${base}/System/Configuration/network`, { headers });
  if (!res.ok) throw new Error(`Jellyfin answered ${res.status} reading network config`);
  return res.json();
}

async function writeNetwork(cfg) {
  const res = await fetch(`${base}/System/Configuration/network`, {
    method: 'POST',
    headers,
    body: JSON.stringify(cfg),
  });
  if (res.status !== 204) throw new Error(`Jellyfin answered ${res.status} writing network config`);
}

const current = await readNetwork();
const before = current.RemoteIPFilter ?? [];

if (clear) {
  if (!apply) {
    console.log(`Would remove the fence (${before.length} entries). Add --apply to do it.`);
    process.exit(0);
  }
  current.RemoteIPFilter = [];
  current.IsRemoteIPFilterBlacklist = false;
  await writeNetwork(current);
  console.log('Fence removed. Jellyfin accepts remote connections from anywhere again.');
  process.exit(0);
}

const { v4, v6 } = await registryBlocks();
const list = [...ALWAYS, ...v4, ...v6];

console.log(`${COUNTRY}: ${v4.length} IPv4 blocks and ${v6.length} IPv6 blocks from the registry, plus ${ALWAYS.length} always-allowed.`);
for (const ip of mustInclude) {
  const ok = [...ALWAYS, ...v4].some((c) => v4Contains(c, ip));
  console.log(`  ${ip}: ${ok ? 'inside the fence' : 'NOT INSIDE — refusing to apply'}`);
  if (!ok) process.exit(2);
}

const added = list.filter((c) => !before.includes(c));
const removed = before.filter((c) => !list.includes(c));
console.log(`Jellyfin currently holds ${before.length} entries; this would add ${added.length} and remove ${removed.length}.`);

if (!apply) {
  console.log('\nReport only. Add --apply to write the list.');
  process.exit(0);
}

current.RemoteIPFilter = list;
current.IsRemoteIPFilterBlacklist = false; // an allow-list, not a block-list
await writeNetwork(current);
const after = await readNetwork();
console.log(`\nApplied: ${after.RemoteIPFilter.length} entries, allow-list mode = ${after.IsRemoteIPFilterBlacklist === false}.`);
