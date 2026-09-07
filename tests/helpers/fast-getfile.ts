/**
 * Shrink the `getFile` wait budget so the polling tests run in seconds.
 *
 * Imported *before* the config module so the values are in place when the
 * schema is evaluated; ESM evaluates imported modules in statement order, so
 * the import of this file must come first in the test.
 */
process.env['TELEGRAM_LOCAL_MODE'] = 'true';
process.env['TELEGRAM_GETFILE_TIMEOUT_SEC'] = '1';
process.env['TELEGRAM_GETFILE_POLL_SEC'] = '1';
process.env['TELEGRAM_GETFILE_MAX_WAIT_SEC'] = '3';
process.env['TELEGRAM_GETFILE_MIN_BYTES_PER_SEC'] = '1048576';
process.env['TELEGRAM_PROGRESS_TICK_MS'] = '100';
