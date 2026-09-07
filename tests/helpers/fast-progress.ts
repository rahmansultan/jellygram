/**
 * Shrink the progress rate-limiting window so the reporter tests run quickly.
 *
 * Imported before the config module so the values are in place when the schema
 * is evaluated; ESM evaluates imported modules in statement order, so this
 * import must come first in the test file.
 */
process.env['PROGRESS_EDIT_INTERVAL_MS'] = '50';
process.env['PROGRESS_EDIT_MIN_DELTA'] = '1';
process.env['TELEGRAM_LOCAL_MODE'] = 'true';
