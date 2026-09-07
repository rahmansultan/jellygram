/**
 * Turn a startup failure into a sentence.
 *
 * A process that cannot start almost always cannot start for one of three
 * boring reasons: the database is not there, a directory is not writable, or a
 * port is taken. Each of those arrives as an `Error` with a `code`, and each
 * used to be reported as a pino record with a full stack trace — around 900
 * characters of JSON whose useful content was `ECONNREFUSED 127.0.0.1:5432`.
 *
 * That is the right record to keep and the wrong thing to show somebody on
 * their first run. So both happen: the structured record still goes to the
 * log, and this writes the human sentence to stderr.
 *
 * A cause this does not recognise gets no invented advice — the caller logs
 * the error as before and this stays quiet.
 */

/** Node attaches `code` to system errors; nothing else here is trusted. */
function codeOf(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : '';
}

function pathOf(err: unknown): string {
  return typeof err === 'object' && err !== null && 'path' in err
    ? String((err as { path: unknown }).path)
    : '';
}

function addressOf(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const e = err as { address?: unknown; port?: unknown; hostname?: unknown };
  const host = e.address ?? e.hostname;
  if (host === undefined) return '';
  return e.port === undefined ? String(host) : `${String(host)}:${String(e.port)}`;
}

/**
 * The advice for a recognised startup failure, or `null`.
 *
 * Exported for the tests, which assert that each cause is recognised and that
 * an unrecognised one produces nothing rather than a guess.
 */
export function explainStartupFailure(err: unknown): string | null {
  const code = codeOf(err);
  const where = addressOf(err);

  switch (code) {
    case 'ECONNREFUSED':
      return (
        `Could not reach the database at ${where || 'the address in DATABASE_URL'}.\n\n` +
        '  • Is PostgreSQL running?  `npm run db:up` starts the bundled one.\n' +
        '  • Does DATABASE_URL in .env name the right host and port?\n\n' +
        'docs/database.md covers both.'
      );

    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return (
        `Could not resolve the database host "${where || 'in DATABASE_URL'}".\n\n` +
        'Check the hostname in DATABASE_URL. A connection string looks like\n' +
        '  postgresql://user:password@127.0.0.1:5432/dbname\n\n' +
        'docs/database.md has the details.'
      );

    case 'ETIMEDOUT':
      return (
        `Timed out reaching the database at ${where || 'the address in DATABASE_URL'}.\n\n` +
        'The host is reachable but nothing answered — usually a firewall, or a\n' +
        'PostgreSQL that is not listening on that interface. See docs/database.md.'
      );

    case '28P01':
      return (
        'The database rejected the username or password in DATABASE_URL.\n\n' +
        'If you are using the bundled PostgreSQL, note that POSTGRES_PASSWORD is\n' +
        'baked into the volume the first time it starts: changing it in .env\n' +
        'afterwards does not change the database. See docs/database.md.'
      );

    case '3D000':
      return (
        'That PostgreSQL server is running, but the database named in\n' +
        'DATABASE_URL does not exist on it. Create it, or point DATABASE_URL at\n' +
        'one that does — docs/database.md has the `createdb` line.'
      );

    case 'EACCES':
    case 'EPERM': {
      const target = pathOf(err);
      if (!target) return null;
      return (
        `No permission to create or write ${target}.\n\n` +
        'That path comes from MEDIA_ROOT (or one of MOVIES_ROOT, TV_ROOT,\n' +
        'DOWNLOAD_TMP_DIR, QUARANTINE_DIR, LOG_DIR) in .env. Point it somewhere\n' +
        'this user owns, or grant this user write access to it.\n\n' +
        'docs/configuration.md lists all of them.'
      );
    }

    case 'ENOENT': {
      const target = pathOf(err);
      if (!target) return null;
      return (
        `${target} could not be created because its parent does not exist.\n\n` +
        'If that path is on a separate drive, it is probably not mounted. Check\n' +
        'MEDIA_ROOT in .env — see docs/configuration.md.'
      );
    }

    case 'ENOTDIR': {
      const target = pathOf(err);
      if (!target) return null;
      return `${target} exists but is a file, not a directory. Check MEDIA_ROOT in .env.`;
    }

    case 'EADDRINUSE':
      return (
        `Something is already listening on ${where || 'that address'}.\n\n` +
        'Either it is already running, or another program has the port. Change\n' +
        'ADMIN_PORT in .env, or stop whatever holds it.'
      );

    case 'EADDRNOTAVAIL':
      return (
        `Cannot bind ${where || 'that address'} — no interface on this machine has it.\n\n` +
        'Check ADMIN_BIND_HOST in .env. 127.0.0.1 is loopback only; 0.0.0.0 is\n' +
        'every interface.'
      );

    default:
      return null;
  }
}

/**
 * Write the sentence, if there is one, to stderr.
 *
 * Callers log the structured error first and then call this, so the record is
 * complete whichever way the operator reads it.
 */
export function reportStartupFailure(err: unknown): void {
  const advice = explainStartupFailure(err);
  if (advice) process.stderr.write(`\n${advice}\n\n`);
}
