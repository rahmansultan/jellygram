import test from 'node:test';
import assert from 'node:assert/strict';
import { analyseIsolation, enabledFoldersFor, userMediaDir } from '../src/services/isolation.js';
import type { UserLibraryRow, UserRow } from '../src/db/types.js';
import type { JellyfinUser, VirtualFolder } from '../src/services/jellyfin.js';

/**
 * Isolation between two managed users.
 *
 * This installation has one user, so the case that actually matters — can
 * Alice see Bob's films — has never been exercised by anything but reasoning.
 * Jellyfin grants access per *library*, so isolation is one list of ids on one
 * account, and a single wrong entry silently shows one person another person's
 * media with nothing failing anywhere.
 *
 * Both halves of that decision are pure functions, so every two-user case is
 * tested here directly: no Jellyfin server, no database, and nothing written
 * to any media directory.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALICE_MOVIES = 'lib-alice-movies';
const ALICE_TV = 'lib-alice-tv';
const BOB_MOVIES = 'lib-bob-movies';
const BOB_TV = 'lib-bob-tv';
const SHARED = 'lib-family-shared';

function user(id: number, name: string, slug: string, jellyfinUserId: string): UserRow {
  return {
    id,
    name,
    telegram_chat_id: -999_222_000 - id,
    jellyfin_username: slug,
    jellyfin_user_id: jellyfinUserId,
    storage_slug: slug,
    active: true,
    upload_enabled: true,
    quota_bytes: null,
    notes: null,
    upload_token_hash: null,
    upload_token_created_at: null,
    upload_token_last_used_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function library(userId: number, type: 'movie' | 'tv', itemId: string, name: string): UserLibraryRow {
  return {
    id: Number(itemId.length) + userId,
    user_id: userId,
    media_type: type,
    library_name: name,
    library_path: type === 'movie' ? userMediaDir({ storage_slug: `u${userId}` }, 'movie') : userMediaDir({ storage_slug: `u${userId}` }, 'tv'),
    jellyfin_item_id: itemId,
    created_at: new Date(),
    updated_at: new Date(),
  } as UserLibraryRow;
}

function jfUser(overrides: Partial<JellyfinUser> & Pick<JellyfinUser, 'id' | 'name'>): JellyfinUser {
  return {
    isAdministrator: false,
    isDisabled: false,
    enableAllFolders: false,
    enabledFolders: [],
    ...overrides,
  };
}

function folder(itemId: string, name: string, ...locations: string[]): VirtualFolder {
  return { itemId, name, collectionType: 'movies', locations };
}

const alice = user(1, 'Alice', 'alice', 'jf-alice');
const bob = user(2, 'Bob', 'bob', 'jf-bob');

const dbLibraries = [
  library(1, 'movie', ALICE_MOVIES, 'Movies - Alice'),
  library(1, 'tv', ALICE_TV, 'TV Shows - Alice'),
  library(2, 'movie', BOB_MOVIES, 'Movies - Bob'),
  library(2, 'tv', BOB_TV, 'TV Shows - Bob'),
];

// Derived from the same helper the audit uses, so a fixture can never claim a
// path the application would not actually produce.
const aliceMoviesDir = userMediaDir(alice, 'movie');
const aliceTvDir = userMediaDir(alice, 'tv');
const bobMoviesDir = userMediaDir(bob, 'movie');
const bobTvDir = userMediaDir(bob, 'tv');

const folders = [
  folder(ALICE_MOVIES, 'Movies - Alice', aliceMoviesDir),
  folder(ALICE_TV, 'TV Shows - Alice', aliceTvDir),
  folder(BOB_MOVIES, 'Movies - Bob', bobMoviesDir),
  folder(BOB_TV, 'TV Shows - Bob', bobTvDir),
  folder(SHARED, 'Family Shared', '/srv/media/shared'),
];

/** An isolated pair: each account sees exactly its own two libraries. */
const isolated = [
  jfUser({ id: 'jf-alice', name: 'alice', enabledFolders: [ALICE_MOVIES, ALICE_TV] }),
  jfUser({ id: 'jf-bob', name: 'bob', enabledFolders: [BOB_MOVIES, BOB_TV] }),
];

const analyse = (jfUsers: JellyfinUser[], extra: Partial<Parameters<typeof analyseIsolation>[0]> = {}) =>
  analyseIsolation({ jfUsers, folders, dbUsers: [alice, bob], dbLibraries, ...extra });

// ---------------------------------------------------------------------------
// The policy applied when provisioning
// ---------------------------------------------------------------------------

test('provisioning a user never leaves them able to see another managed user', () => {
  // Bob's libraries are currently enabled on Alice's account — the exact state
  // an administrator produces by ticking "all libraries" once in Jellyfin.
  const { enabledFolders } = enabledFoldersFor({
    ownedLibraryIds: [ALICE_MOVIES, ALICE_TV],
    currentEnabled: [ALICE_MOVIES, BOB_MOVIES, BOB_TV],
    managedByOthers: new Set([BOB_MOVIES, BOB_TV]),
  });

  assert.deepEqual(enabledFolders.slice().sort(), [ALICE_MOVIES, ALICE_TV].sort());
  assert.ok(!enabledFolders.includes(BOB_MOVIES), "Bob's films must not be reachable");
  assert.ok(!enabledFolders.includes(BOB_TV), "Bob's episodes must not be reachable");
});

test('a user always keeps their own libraries, even if none were enabled before', () => {
  // Otherwise provisioning locks somebody out of their own media.
  const { enabledFolders } = enabledFoldersFor({
    ownedLibraryIds: [ALICE_MOVIES, ALICE_TV],
    currentEnabled: [],
    managedByOthers: new Set([BOB_MOVIES, BOB_TV]),
  });
  assert.deepEqual(enabledFolders, [ALICE_MOVIES, ALICE_TV]);
});

test('a library this system did not create survives provisioning', () => {
  // A shared family library is the administrator's business. Revoking it as a
  // side effect of provisioning would be this tool quietly taking something
  // away that it never granted.
  const { enabledFolders, preserved } = enabledFoldersFor({
    ownedLibraryIds: [ALICE_MOVIES, ALICE_TV],
    currentEnabled: [SHARED, BOB_TV],
    managedByOthers: new Set([BOB_MOVIES, BOB_TV]),
  });

  assert.deepEqual(preserved, [SHARED]);
  assert.ok(enabledFolders.includes(SHARED), 'the unmanaged library is kept');
  assert.ok(!enabledFolders.includes(BOB_TV), "the other user's library is not");
});

test('an id that is both owned and already enabled is not duplicated', () => {
  const { enabledFolders } = enabledFoldersFor({
    ownedLibraryIds: [ALICE_MOVIES, ALICE_MOVIES, ALICE_TV],
    currentEnabled: [ALICE_MOVIES, ALICE_MOVIES, SHARED, SHARED],
    managedByOthers: new Set(),
  });
  assert.deepEqual(enabledFolders, [ALICE_MOVIES, ALICE_TV, SHARED]);
});

test('with no other managed users nothing is stripped', () => {
  // The single-user case this installation actually runs.
  const { enabledFolders } = enabledFoldersFor({
    ownedLibraryIds: [ALICE_MOVIES, ALICE_TV],
    currentEnabled: [SHARED],
    managedByOthers: new Set(),
  });
  assert.deepEqual(enabledFolders, [ALICE_MOVIES, ALICE_TV, SHARED]);
});

// ---------------------------------------------------------------------------
// The audit that re-derives the state from Jellyfin
// ---------------------------------------------------------------------------

test('a correctly isolated pair of users produces no findings', () => {
  const report = analyse(isolated);
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.equal(report.findings.length, 0);
  assert.equal(report.managedLibraries, 4);
  assert.equal(report.checked, true);
});

test('one user able to see another user’s library is an error naming both', () => {
  const report = analyse([
    jfUser({ id: 'jf-alice', name: 'alice', enabledFolders: [ALICE_MOVIES, ALICE_TV, BOB_MOVIES] }),
    jfUser({ id: 'jf-bob', name: 'bob', enabledFolders: [BOB_MOVIES, BOB_TV] }),
  ]);

  assert.equal(report.ok, false);
  const finding = report.findings.find((f) => f.jellyfinUser === 'alice');
  assert.ok(finding, 'the offending account is named');
  assert.equal(finding.severity, 'error');
  // The library is named, not just its id: an operator has to be able to act.
  assert.match(finding.message, /Movies - Bob/);
  assert.ok(!report.findings.some((f) => f.jellyfinUser === 'bob'), 'Bob is not implicated');
});

test('the breach is reported in both directions independently', () => {
  const report = analyse([
    jfUser({ id: 'jf-alice', name: 'alice', enabledFolders: [ALICE_MOVIES, ALICE_TV, BOB_TV] }),
    jfUser({ id: 'jf-bob', name: 'bob', enabledFolders: [BOB_MOVIES, BOB_TV, ALICE_MOVIES] }),
  ]);

  assert.equal(report.ok, false);
  assert.equal(report.findings.filter((f) => f.severity === 'error').length, 2);
  assert.ok(report.findings.some((f) => f.jellyfinUser === 'alice' && /TV Shows - Bob/.test(f.message)));
  assert.ok(report.findings.some((f) => f.jellyfinUser === 'bob' && /Movies - Alice/.test(f.message)));
});

test('"access to all libraries" is an error on its own', () => {
  // enabledFolders is then meaningless — Jellyfin ignores it — so a report
  // that only inspected the list would call this account perfectly isolated.
  const report = analyse([
    jfUser({ id: 'jf-alice', name: 'alice', enableAllFolders: true, enabledFolders: [ALICE_MOVIES] }),
    isolated[1]!,
  ]);

  assert.equal(report.ok, false);
  const finding = report.findings.find((f) => f.jellyfinUser === 'alice');
  assert.equal(finding?.severity, 'error');
  assert.match(finding!.message, /all libraries/i);
});

test('a managed user who is a Jellyfin administrator is an error, an unmanaged one is not', () => {
  const report = analyse([
    jfUser({ id: 'jf-alice', name: 'alice', isAdministrator: true }),
    isolated[1]!,
    jfUser({ id: 'jf-root', name: 'admin', isAdministrator: true }),
  ]);

  const managed = report.findings.find((f) => f.jellyfinUser === 'alice');
  assert.equal(managed?.severity, 'error', 'a managed account with admin rights sees everything');
  assert.match(managed!.message, /administrator/i);

  const unmanaged = report.findings.find((f) => f.jellyfinUser === 'admin');
  assert.equal(unmanaged?.severity, 'info', 'the real administrator is expected to see everything');
  assert.equal(report.ok, false, 'the managed one still fails the audit');
});

test('a user who cannot see their own libraries is a warning, not a breach', () => {
  const report = analyse([
    jfUser({ id: 'jf-alice', name: 'alice', enabledFolders: [ALICE_MOVIES] }),
    isolated[1]!,
  ]);

  const finding = report.findings.find((f) => f.jellyfinUser === 'alice');
  assert.equal(finding?.severity, 'warning', 'losing access to your own media is not a privacy breach');
  assert.match(finding!.message, /TV Shows - Alice/);
  assert.equal(report.ok, true, 'warnings do not fail the audit');
});

test('an unmanaged library pointing at a private folder is an error', () => {
  // A second library over the same directory is an independent way in that the
  // per-user policy above cannot close.
  const rogue = folder('lib-rogue', 'Everything', bobMoviesDir);
  const report = analyseIsolation({
    jfUsers: isolated,
    folders: [...folders, rogue],
    dbUsers: [alice, bob],
    dbLibraries,
  });

  assert.equal(report.ok, false);
  const finding = report.findings.find((f) => /Everything/.test(f.message));
  assert.equal(finding?.severity, 'error');
  assert.match(finding!.message, /Bob/);
});

test('a disabled account is still audited', () => {
  // Disabled today, re-enabled next week, still holding another user's media.
  const report = analyse([
    jfUser({
      id: 'jf-alice',
      name: 'alice',
      isDisabled: true,
      enabledFolders: [ALICE_MOVIES, ALICE_TV, BOB_MOVIES],
    }),
    isolated[1]!,
  ]);
  assert.equal(report.ok, false);
});

test('an account with no linked user is judged only on managed libraries', () => {
  const report = analyse([
    ...isolated,
    jfUser({ id: 'jf-guest', name: 'guest', enabledFolders: [SHARED] }),
  ]);
  assert.equal(report.ok, true, 'an unmanaged account holding an unmanaged library is fine');

  const breach = analyse([
    ...isolated,
    jfUser({ id: 'jf-guest', name: 'guest', enabledFolders: [SHARED, ALICE_TV] }),
  ]);
  assert.equal(breach.ok, false, "but not one holding a managed user's library");
  assert.match(breach.findings.find((f) => f.jellyfinUser === 'guest')!.message, /TV Shows - Alice/);
});

test('an empty installation audits clean rather than throwing', () => {
  const report = analyseIsolation({ jfUsers: [], folders: [], dbUsers: [], dbLibraries: [] });
  assert.equal(report.ok, true);
  assert.equal(report.managedLibraries, 0);
});
