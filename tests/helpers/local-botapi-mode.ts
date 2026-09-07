/**
 * Put this test file into local Bot API mode.
 *
 * Some behaviour exists only when the application talks to a self-hosted
 * `telegram-bot-api` server rather than to Telegram's public one: getFile
 * returns a path instead of a URL, downloads are moved rather than streamed,
 * and the reaper is responsible for the copies that server leaves behind.
 * That mode is off by default, so tests covering it used to skip themselves on
 * any machine whose `.env` had not enabled it — which on a fresh clone is
 * every machine.
 *
 * Setting it here makes that coverage unconditional. Nothing in the tests that
 * use this helper contacts a Bot API server; the flag only selects which
 * branch of our own code runs.
 *
 * Imported before the config module, like the other environment helpers.
 */
process.env['TELEGRAM_LOCAL_MODE'] = 'true';
