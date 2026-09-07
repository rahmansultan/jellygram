import fs from 'node:fs';
import path from 'node:path';

/**
 * Point the media tree at a scratch root for the duration of a test file.
 *
 * The suite used to write into the real MEDIA_ROOT, which left 32 test users'
 * library directories among the owner's actual films and meant a careless
 * cleanup could have deleted real media. Every root the application uses —
 * movies, tv, .incoming, .parts, .quarantine — derives from MEDIA_ROOT, so
 * setting this one variable isolates all of them.
 *
 * Imported *before* the config module so the value is in place when the schema
 * is evaluated; ESM evaluates imported modules in statement order, so this
 * import must come first in the test file.
 *
 * The path is fixed rather than random so that a crashed run leaves something
 * findable and removable, and so concurrent test files share one tree instead
 * of scattering temporary roots.
 */
const root = path.join(process.cwd(), '.test-media');
fs.mkdirSync(root, { recursive: true, mode: 0o750 });

/**
 * Give the scratch root the media group and the setgid bit, before anything is
 * created inside it.
 *
 * The ownership tests are about inheritance: a file written under this tree
 * takes its group from the directory it lands in, not from whoever wrote it.
 * They used to get that property for free by building their scratch tree
 * inside the real media root — which is precisely why they were writing into
 * the owner's film library. A plain directory is not a stand-in for that root;
 * it is a different environment with the same shape. Reproducing the two
 * properties that make the real one work is what lets those tests move out.
 *
 * Read from .env directly because dotenv has not run yet — this module is
 * imported before the configuration it is overriding. A failure here is left
 * silent: the tests that care already skip when the group does not resolve, so
 * a host without the media group set up reports "skipped" rather than a
 * failure it cannot act on.
 */
try {
  const envFile = path.join(process.cwd(), '.env');
  const declared = fs.existsSync(envFile)
    ? /^MEDIA_GROUP=(.*)$/m.exec(fs.readFileSync(envFile, 'utf8'))?.[1]?.trim()
    : undefined;
  const groupName = process.env['MEDIA_GROUP'] ?? declared ?? 'jellyfin';
  const entry = fs
    .readFileSync('/etc/group', 'utf8')
    .split('\n')
    .find((line) => line.startsWith(`${groupName}:`));
  const gid = entry ? Number(entry.split(':')[2]) : Number.NaN;
  if (Number.isInteger(gid)) {
    fs.chownSync(root, -1, gid);
    // setgid: directories and files created below inherit the group.
    fs.chmodSync(root, 0o2750);
  }
} catch {
  /* not a member of the group, or no such group — leave the root as it is */
}

process.env['MEDIA_ROOT'] = root;

// Set explicitly rather than deleted. dotenv loads .env *after* this module
// runs and does not overwrite variables that already exist, so clearing them
// would simply let the real values back in; assigning them wins instead.
process.env['MOVIES_ROOT'] = path.join(root, 'movies');
process.env['TV_ROOT'] = path.join(root, 'tv');
process.env['DOWNLOAD_TMP_DIR'] = path.join(root, '.incoming');
process.env['QUARANTINE_DIR'] = path.join(root, '.quarantine');

// Created up front: the application creates these lazily as it runs, but a
// test that reaches for a scratch directory before the pipeline has started
// would otherwise fail on a missing parent.
for (const dir of ['movies', 'tv', '.incoming', '.parts', '.quarantine']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o750 });
}

// Drain mode. These tests drive the pipeline handlers directly; the live
// worker shares this database and would otherwise claim the same jobs and run
// them against the real media root, filing fixtures among real films and
// racing the test for the same session.
process.env['QUEUE_PAUSED'] = 'true';

export const TEST_MEDIA_ROOT = root;
