import { Bot, GrammyError, HttpError, type Context } from 'grammy';
import { config, ensureDirectories } from '../config/index.js';
import { createLogger, getLogger } from '../lib/logger.js';
import { runMigrations } from '../db/migrate.js';
import { closePool } from '../db/pool.js';
import {
  auditRepo,
  jobsRepo,
  mediaRepo,
  partsRepo,
  sessionsRepo,
  uploadsRepo,
  usersRepo,
} from '../db/repositories.js';
import { parsePartFilename, describeMissing, missingParts } from '../services/multipart.js';
import { mtprotoJobsRepo } from '../db/repositories.js';
import { status as mtprotoStatus } from '../services/mtproto.js';
import type { ForwardOriginKind } from '../db/types.js';
import type { UserRow } from '../db/types.js';
import { extensionOf, sanitizeFilename } from '../lib/paths.js';
import { checkSpaceFor, formatBytes } from '../services/storage.js';
import { beginAssembly, retrySession } from '../worker/multipart.js';
import { esc, ProgressReporter } from '../services/notifier.js';
import { checkQuota } from '../services/quota.js';
import { effectiveMaxFileSize, botApiFileLimit, PUBLIC_BOT_API_FILE_LIMIT } from '../services/download.js';
import { reportStartupFailure } from '../lib/startup.js';

/**
 * The Telegram bot.
 *
 * Its only jobs are to authenticate the sender, validate the file, record the
 * upload and enqueue it. It never downloads anything: that is the worker's
 * work, and doing it here would block every other user behind one movie.
 */

const log = createLogger('bot');

if (!config.telegram.configured) {
  // Exiting cleanly rather than crash-looping: systemd would otherwise restart
  // this every few seconds until a token exists.
  log.error(
    'TELEGRAM_BOT_TOKEN is not set (or is not a valid token). ' +
      'Add it to .env and restart this service. The dashboard and worker are unaffected.',
  );
  process.exit(0);
}

const bot = new Bot(config.telegram.botToken, {
  client: { apiRoot: config.telegram.apiRoot },
});

/** Subtitle and other formats we explicitly refuse, for a clearer message. */
const SUBTITLE_EXTENSIONS = new Set(['srt', 'sub', 'ass', 'ssa', 'vtt', 'idx', 'sup', 'smi']);

interface IncomingFile {
  fileId: string;
  fileUniqueId: string;
  fileName: string;
  fileSize: number;
  mimeType: string | null;
}

/** Extract the file from whichever message shape Telegram used. */
function extractFile(ctx: Context): IncomingFile | null {
  const msg = ctx.message;
  if (!msg) return null;

  if (msg.document) {
    return {
      fileId: msg.document.file_id,
      fileUniqueId: msg.document.file_unique_id,
      fileName: msg.document.file_name ?? `document-${msg.document.file_unique_id}`,
      fileSize: msg.document.file_size ?? 0,
      mimeType: msg.document.mime_type ?? null,
    };
  }

  if (msg.video) {
    // A video sent as a video (rather than a file) often has no filename.
    const guessedExt = (msg.video.mime_type ?? '').split('/')[1] ?? 'mp4';
    return {
      fileId: msg.video.file_id,
      fileUniqueId: msg.video.file_unique_id,
      fileName: msg.video.file_name ?? `video-${msg.video.file_unique_id}.${guessedExt}`,
      fileSize: msg.video.file_size ?? 0,
      mimeType: msg.video.mime_type ?? null,
    };
  }

  return null;
}

/**
 * Resolve the sender to a registered user.
 * Returns `null` for anyone who is not registered; the caller refuses them.
 */
async function authenticate(ctx: Context): Promise<UserRow | null> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return null;
  return usersRepo.byTelegramChatId(chatId);
}

const UNREGISTERED_MESSAGE = '❌ You are not registered. Please contact the administrator.';

// ---------------------------------------------------------------------------
// Middleware: private chats only, and audit every interaction
// ---------------------------------------------------------------------------

bot.use(async (ctx, next) => {
  if (ctx.chat && ctx.chat.type !== 'private') {
    // The bot handles personal libraries; group chats have no owner.
    return;
  }
  await next();
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

bot.command('start', async (ctx) => {
  const user = await authenticate(ctx);
  if (!user) {
    log.warn({ telegramChatId: ctx.chat?.id }, 'Unregistered user sent /start');
    await ctx.reply(
      `${UNREGISTERED_MESSAGE}\n\nYour Telegram ID is <code>${ctx.chat?.id}</code> — send it to the administrator.`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  await ctx.reply(
    `\u{1F44B} Hello <b>${esc(user.name)}</b>!\n\n` +
      `Send me a movie or TV episode and I will add it to your private Jellyfin library.\n\n` +
      `<b>Accepted formats:</b> ${config.storage.allowedExtensions.map((e) => e.toUpperCase()).join(', ')}\n` +
      `<b>Maximum size:</b> ${formatBytes(effectiveMaxFileSize())}\n\n` +
      `Name files clearly for best results:\n` +
      `<code>Interstellar.2014.1080p.mkv</code>\n` +
      `<code>Breaking.Bad.S02E03.1080p.mkv</code>\n\n` +
      `<b>Larger than ${formatBytes(effectiveMaxFileSize())}?</b> Split it and send the pieces as\n` +
      `<code>Movie.mkv.part1</code>, <code>Movie.mkv.part2</code>, … up to ` +
      `${formatBytes(config.multipart.maxAssembledBytes)} in total.\n\n` +
      `Commands: /status /library /parts /finish /help\n\n` +
      // The unregistered branch has always shown this; a registered user had
      // no way to find their own id, which is exactly the value an
      // administrator needs for TELEGRAM_ADMIN_CHAT_ID.
      `<i>Your Telegram ID is</i> <code>${ctx.chat?.id}</code>`,
    { parse_mode: 'HTML', ...miniAppKeyboard() },
  );
});

/**
 * A button that opens the Mini App, when there is one to open.
 *
 * Telegram refuses any Mini App URL that is not https, so an unconfigured or
 * plain-http deployment gets no button rather than one that fails when it is
 * pressed. Spread into an existing reply's options, so it adds a keyboard
 * without changing anything else about the message.
 */
function miniAppKeyboard(): { reply_markup?: { inline_keyboard: Array<Array<{ text: string; web_app: { url: string } }>> } } {
  if (!config.miniapp.configured) return {};
  return {
    reply_markup: {
      inline_keyboard: [[{ text: '🎬 Open Media App', web_app: { url: config.miniapp.url } }]],
    },
  };
}

bot.command('help', async (ctx) => {
  const user = await authenticate(ctx);
  if (!user) return void ctx.reply(UNREGISTERED_MESSAGE);

  await ctx.reply(
    `<b>How to use this bot</b>\n\n` +
      `1. Send a video file to this chat (as a file, for best quality).\n` +
      `2. I identify it, file it, and add it to your Jellyfin library.\n` +
      `3. Watch it in Jellyfin under your own account.\n\n` +
      `<b>Files larger than ${formatBytes(effectiveMaxFileSize())}</b>\n` +
      `Telegram cannot carry them in one piece. Split the file and send the\n` +
      `pieces named after the original:\n` +
      `<code>Movie.mkv.part1</code>, <code>Movie.mkv.part2</code>, …\n` +
      `I collect them, reassemble the original, and carry on as normal.\n` +
      `Send <code>/finish</code> after the last part.\n\n` +
      `<b>Commands</b>\n` +
      `/status — your recent uploads\n` +
      `/library — what you have stored\n` +
      `/parts — multi-part uploads in progress\n` +
      `/finish — assemble a completed multi-part upload\n` +
      `/cancelupload — cancel a multi-part upload\n` +
      `/help — this message\n\n` +
      `Subtitle files are not accepted. Only ${config.storage.allowedExtensions
        .map((e) => e.toUpperCase())
        .join(', ')} video files.`,
    { parse_mode: 'HTML' },
  );
});

bot.command('status', async (ctx) => {
  const user = await authenticate(ctx);
  if (!user) return void ctx.reply(UNREGISTERED_MESSAGE);

  const { rows } = await uploadsRepo.search({ userId: user.id, limit: 8, offset: 0 });
  if (rows.length === 0) return void ctx.reply('You have not uploaded anything yet.');

  const icon: Record<string, string> = {
    RECEIVED: '\u{1F4E5}', QUEUED: '\u{23F3}', DOWNLOADING: '\u{2B07}\u{FE0F}',
    PROCESSING: '\u{1F50D}', ORGANIZING: '\u{1F4C1}', JELLYFIN_SCAN: '\u{1F4FA}',
    COMPLETED: '\u{2705}', FAILED: '\u{274C}', CANCELLED: '\u{1F6D1}', DUPLICATE: '\u{26A0}\u{FE0F}',
  };

  const lines = rows.map(
    (u) =>
      `${icon[u.status] ?? '•'} <b>${esc(u.detected_title ?? u.original_filename)}</b>\n` +
      `   ${u.status.toLowerCase()} • ${formatBytes(u.file_size)}` +
      (u.status === 'FAILED' && u.error_message ? `\n   <i>${esc(u.error_message.slice(0, 120))}</i>` : ''),
  );

  await ctx.reply(`<b>Your recent uploads</b>\n\n${lines.join('\n\n')}`, { parse_mode: 'HTML' });
});

bot.command('library', async (ctx) => {
  const user = await authenticate(ctx);
  if (!user) return void ctx.reply(UNREGISTERED_MESSAGE);

  const [movies, episodes] = await Promise.all([
    mediaRepo.search({ userId: user.id, type: 'movie', limit: 1, offset: 0 }),
    mediaRepo.search({ userId: user.id, type: 'tv', limit: 1, offset: 0 }),
  ]);
  const usage = (await usersRepo.storageUsage()).find((u) => u.user_id === user.id);

  await ctx.reply(
    `\u{1F4DA} <b>${esc(user.name)}'s library</b>\n\n` +
      `\u{1F3AC} Movies: <b>${movies.total}</b>\n` +
      `\u{1F4FA} Episodes: <b>${episodes.total}</b>\n` +
      `\u{1F4BE} Storage used: <b>${formatBytes(usage?.bytes ?? 0)}</b>\n\n` +
      `Jellyfin account: <code>${esc(user.jellyfin_username)}</code>`,
    { parse_mode: 'HTML' },
  );
});

// ---------------------------------------------------------------------------
// File intake
// ---------------------------------------------------------------------------

async function handleIncomingFile(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const file = extractFile(ctx);
  if (!file || chatId === undefined) return;

  // --- Authorisation: no download for anyone we do not know ----------------
  const user = await authenticate(ctx);
  if (!user) {
    log.warn(
      { telegramChatId: chatId, filename: file.fileName },
      'Rejected file from unregistered user',
    );
    await auditRepo.log({
      actor_type: 'telegram',
      actor_id: String(chatId),
      action: 'upload.rejected.unregistered',
      detail: { filename: file.fileName, size: file.fileSize },
    });
    await ctx.reply(UNREGISTERED_MESSAGE);
    return;
  }

  if (!user.active) {
    await ctx.reply('❌ Your account is deactivated. Please contact the administrator.');
    return;
  }
  if (!user.upload_enabled) {
    await ctx.reply('❌ Uploading is currently disabled for your account.');
    return;
  }

  // --- Multi-part upload? --------------------------------------------------
  //
  // A `.partN` suffix means this is one piece of a file too large for
  // Telegram to carry whole. Everything below this point is the single-file
  // path, which is left exactly as it was.
  const parsedPart = parsePartFilename(file.fileName);
  if (parsedPart) {
    await handleIncomingPart(ctx, user, file, parsedPart);
    return;
  }

  const extension = extensionOf(file.fileName);

  // --- Validation ----------------------------------------------------------
  if (SUBTITLE_EXTENSIONS.has(extension)) {
    await ctx.reply('❌ Subtitle files are not accepted. Please send a video file.');
    return;
  }

  if (!extension || !config.storage.allowedExtensions.includes(extension)) {
    await ctx.reply(
      `❌ Unsupported file type${extension ? ` (.${esc(extension)})` : ''}.\n\n` +
        `Accepted formats: ${config.storage.allowedExtensions.map((e) => e.toUpperCase()).join(', ')}`,
    );
    return;
  }

  // --- Too large for the Bot API? ------------------------------------------
  //
  // A forwarded file above the Bot API ceiling cannot be fetched with a
  // file_id at all. When MTProto ingestion is configured, the owner's own
  // Telegram account can retrieve it instead; the Bot API path below is left
  // exactly as it was for everything that fits.
  if (file.fileSize > botApiFileLimit() && file.fileSize <= config.mtproto.maxFileBytes) {
    if (await tryMtprotoIngestion(ctx, user, file)) return;
  }

  // One ceiling: the smaller of the configured limit and what the configured
  // transport can actually fetch. Checked before anything is queued, so a file
  // that cannot be downloaded is refused immediately rather than late.
  if (file.fileSize > effectiveMaxFileSize()) {
    const transportBound = file.fileSize > botApiFileLimit();

    log.warn(
      { size: file.fileSize, limit: effectiveMaxFileSize(), localMode: config.telegram.localMode },
      'Rejected: file exceeds the maximum size',
    );

    if (transportBound && !config.telegram.localMode) {
      await ctx.reply(
        `❌ Telegram will not let this bot download files larger than ` +
          `${formatBytes(PUBLIC_BOT_API_FILE_LIMIT)} through the public Bot API.\n\n` +
          `This file is ${formatBytes(file.fileSize)}. Ask the administrator to enable the ` +
          `local Bot API server, which raises the limit to ${formatBytes(botApiFileLimit())}.`,
      );
    } else {
      await ctx.reply(
        `❌ That file is ${formatBytes(file.fileSize)}, above the ` +
          `${formatBytes(effectiveMaxFileSize())} limit.`,
      );
    }
    return;
  }

  // --- Disk space, before anything is queued -------------------------------
  const quota = await checkQuota(user, file.fileSize);
  if (!quota.ok) {
    await ctx.reply(`\u{274C} <b>Upload rejected</b>\n\n${esc(quota.reason ?? 'Quota exceeded.')}`, {
      parse_mode: 'HTML',
    });
    return;
  }

  const space = await checkSpaceFor(file.fileSize);
  if (!space.ok) {
    log.warn({ required: space.requiredBytes, available: space.availableBytes }, 'Refused: low disk');
    await ctx.reply(`❌ Not enough server storage for this file.\n${space.reason ?? ''}`);
    return;
  }

  // --- Record and enqueue --------------------------------------------------
  const safeFilename = sanitizeFilename(file.fileName, `upload-${file.fileUniqueId}`);

  const upload = await uploadsRepo.create({
    user_id: user.id,
    telegram_chat_id: chatId,
    telegram_message_id: ctx.message?.message_id ?? null,
    telegram_file_id: file.fileId,
    telegram_file_unique_id: file.fileUniqueId,
    original_filename: file.fileName,
    safe_filename: safeFilename,
    extension,
    mime_type: file.mimeType,
    file_size: file.fileSize,
  });

  // Queued before the receipt is sent: the reply can fail — flood control on
  // a burst of forwards, a blocked chat, the Bot API server restarting — and
  // a failure after the row existed but before the job did left an upload
  // stuck at RECEIVED that nothing would ever pick up. The worker creates the
  // progress message itself when none was recorded.
  await uploadsRepo.setStatus(upload.id, 'QUEUED');
  const job = await jobsRepo.enqueue({
    type: 'process-upload',
    upload_id: upload.id,
    max_attempts: config.worker.maxAttempts,
  });

  // Deliberately does NOT claim a stage that has not started. The upload is
  // queued at this point; identification happens much later, after the file has
  // been fetched. Announcing "Identifying media…" here meant the first thing a
  // user saw was untrue, and it stayed on screen for as long as the upload
  // waited for a worker — which is what made a busy queue look like a hang.
  let sent: { message_id: number } | null = null;
  try {
    sent = await ctx.reply(
      `\u{1F4E5} <b>File received</b>\n` +
        `<code>${esc(file.fileName)}</code>\n` +
        `${formatBytes(file.fileSize)}\n\n` +
        `\u{23F3} Queued…`,
      { parse_mode: 'HTML', reply_parameters: { message_id: ctx.message!.message_id, allow_sending_without_reply: true } },
    );
    await uploadsRepo.patch(upload.id, { progress_message_id: sent.message_id });
  } catch (err) {
    log.warn({ err, uploadId: upload.id }, 'Could not send the receipt; the worker will start the progress message');
  }

  // Show the real position straight away rather than waiting for the first
  // sweep, so a queued upload is never a bare "Queued…" with no context.
  const position = sent ? await jobsRepo.queuePosition(job.id).catch(() => null) : null;
  if (position && sent) {
    const reporter = new ProgressReporter(
      upload.telegram_chat_id,
      sent.message_id,
      file.fileName,
      undefined,
      config.telegram.localMode ? 'telegram-local' : 'telegram-cloud',
    );
    await reporter.reportQueued(position.ahead, position.active);
  }

  await auditRepo.log({
    actor_type: 'telegram',
    actor_id: String(chatId),
    action: 'upload.received',
    entity_type: 'upload',
    entity_id: String(upload.id),
    detail: { filename: file.fileName, size: file.fileSize, userId: user.id },
  });

  log.info(
    {
      uploadId: upload.id,
      userId: user.id,
      telegramChatId: chatId,
      filename: file.fileName,
      size: file.fileSize,
    },
    'Upload queued',
  );
}

// ---------------------------------------------------------------------------
// MTProto ingestion for forwarded media the Bot API cannot carry
// ---------------------------------------------------------------------------

/**
 * Describe where a forwarded message came from.
 *
 * A channel forward carries an exact chat and message id. A forward from a
 * user, a group, or a sender who hides their account carries no usable id, so
 * the worker falls back to searching the owner's own dialog with the bot.
 */
function readForwardOrigin(ctx: Context): {
  kind: ForwardOriginKind;
  chat: string | null;
  messageId: number | null;
  title: string | null;
  isForward: boolean;
} {
  const msg = ctx.message as
    | {
        forward_origin?: {
          type?: string;
          chat?: { id?: number; username?: string; title?: string };
          message_id?: number;
          sender_user?: { id?: number; first_name?: string };
          sender_user_name?: string;
          sender_chat?: { id?: number; username?: string; title?: string };
        };
      }
    | undefined;

  const origin = msg?.forward_origin;
  if (!origin?.type) {
    return { kind: 'unknown', chat: null, messageId: null, title: null, isForward: false };
  }

  switch (origin.type) {
    case 'channel':
      return {
        kind: 'channel',
        // A username resolves without the account being a member; an id works
        // only where the account already has the dialog.
        chat: origin.chat?.username ? `@${origin.chat.username}` : (origin.chat?.id?.toString() ?? null),
        messageId: origin.message_id ?? null,
        title: origin.chat?.title ?? null,
        isForward: true,
      };
    case 'chat':
      return {
        kind: 'chat',
        chat: origin.sender_chat?.username ? `@${origin.sender_chat.username}` : null,
        messageId: null,
        title: origin.sender_chat?.title ?? null,
        isForward: true,
      };
    case 'user':
      return {
        kind: 'user',
        chat: null,
        messageId: null,
        title: origin.sender_user?.first_name ?? null,
        isForward: true,
      };
    case 'hidden_user':
      return {
        kind: 'hidden',
        chat: null,
        messageId: null,
        title: origin.sender_user_name ?? null,
        isForward: true,
      };
    default:
      return { kind: 'unknown', chat: null, messageId: null, title: null, isForward: true };
  }
}

/**
 * Queue an MTProto ingestion for media the Bot API is too small to fetch.
 *
 * Returns true when the job was accepted, so the caller stops. Returns false
 * when MTProto is unavailable, letting the normal size rejection explain why.
 */
async function tryMtprotoIngestion(
  ctx: Context,
  user: UserRow,
  file: IncomingFile,
): Promise<boolean> {
  const chatId = ctx.chat!.id;

  if (!config.mtproto.enabled) return false;

  const state = await mtprotoStatus().catch(() => null);
  if (!state?.authorized) {
    log.warn({ size: file.fileSize }, 'Large forward arrived but MTProto is not authorised');
    await ctx.reply(
      `\u{26A0}\u{FE0F} That file is ${formatBytes(file.fileSize)}, which Telegram will not let ` +
        `a bot download.\n\nThe administrator can enable large-file ingestion by linking a ` +
        `Telegram account on the server.`,
    );
    return true;
  }

  // MTProto fetches run as the server owner's *personal* Telegram account, so
  // ingestion is limited to the user that account belongs to. This fails
  // closed: an unset owner id used to disable the check entirely, which would
  // have let any registered user drive the owner's account once a second user
  // existed.
  const ownerId = config.mtproto.ownerTelegramId.trim();
  if (!ownerId) {
    getLogger().error(
      'MTPROTO_OWNER_TELEGRAM_ID is not set; refusing MTProto ingestion rather than ' +
        'letting any registered user drive the owner Telegram account',
    );
    await ctx.reply(
      `\u{26A0}\u{FE0F} Large-file ingestion is not configured on this server.\n\n` +
        `The administrator needs to set <code>MTPROTO_OWNER_TELEGRAM_ID</code>.`,
      { parse_mode: 'HTML' },
    );
    return true;
  }
  if (String(chatId) !== ownerId) {
    await ctx.reply(
      `\u{26A0}\u{FE0F} Files above ${formatBytes(botApiFileLimit())} can only be ingested for ` +
        `the account linked on the server. Please ask the administrator.`,
    );
    return true;
  }

  const extension = extensionOf(file.fileName);
  if (SUBTITLE_EXTENSIONS.has(extension)) {
    await ctx.reply('❌ Subtitle files are not accepted. Please send a video file.');
    return true;
  }
  if (!extension || !config.storage.allowedExtensions.includes(extension)) {
    await ctx.reply(
      `❌ Unsupported file type${extension ? ` (.${esc(extension)})` : ''}.\n\n` +
        `Accepted formats: ${config.storage.allowedExtensions.map((e) => e.toUpperCase()).join(', ')}`,
    );
    return true;
  }

  const quota = await checkQuota(user, file.fileSize);
  if (!quota.ok) {
    await ctx.reply(`\u{274C} <b>Upload rejected</b>\n\n${esc(quota.reason ?? 'Quota exceeded.')}`, {
      parse_mode: 'HTML',
    });
    return true;
  }

  const space = await checkSpaceFor(file.fileSize);
  if (!space.ok) {
    await ctx.reply(`❌ Not enough server storage for this file.\n${space.reason ?? ''}`);
    return true;
  }

  const messageId = ctx.message?.message_id ?? null;

  // A double-forward of the same message must not start two 5 GB downloads.
  if (messageId !== null) {
    const existing = await mtprotoJobsRepo.activeForMessage(user.id, messageId);
    if (existing) {
      await ctx.reply('\u{2139}\u{FE0F} That file is already being fetched.');
      return true;
    }
  }

  const origin = readForwardOrigin(ctx);
  const caption = (ctx.message as { caption?: string } | undefined)?.caption ?? null;

  const sent = await ctx.reply(
    `\u{1F4E5} <b>${origin.isForward ? 'Forwarded media detected' : 'Large file detected'}</b>\n` +
      `\u{1F3AC} <code>${esc(file.fileName)}</code>\n` +
      `\u{1F4E6} Size: ${formatBytes(file.fileSize)}\n\n` +
      `\u{1F504} Too large for the Bot API — fetching it through your own ` +
      `Telegram connection…`,
    {
      parse_mode: 'HTML',
      reply_parameters: { message_id: ctx.message!.message_id, allow_sending_without_reply: true },
    },
  );

  const job = await mtprotoJobsRepo.create({
    user_id: user.id,
    telegram_chat_id: chatId,
    bot_message_id: messageId,
    progress_message_id: sent.message_id,
    origin_kind: origin.kind,
    origin_chat: origin.chat,
    origin_message_id: origin.messageId,
    origin_title: origin.title,
    file_name: file.fileName,
    file_size: file.fileSize,
    mime_type: file.mimeType,
    telegram_file_unique_id: file.fileUniqueId,
    caption,
  });

  await jobsRepo.enqueue({
    type: 'mtproto-download',
    upload_id: null,
    mtproto_job_id: job.id,
    payload: { mtprotoJobId: job.id },
    // Ahead of ordinary uploads: these are the slowest transfers.
    priority: 60,
    max_attempts: config.mtproto.maxAttempts,
  });

  await auditRepo.log({
    actor_type: 'telegram',
    actor_id: String(chatId),
    action: 'mtproto.queued',
    entity_type: 'mtproto_job',
    entity_id: String(job.id),
    detail: {
      filename: file.fileName,
      size: file.fileSize,
      userId: user.id,
      originKind: origin.kind,
      isForward: origin.isForward,
    },
  });

  log.info(
    {
      mtprotoJobId: job.id,
      userId: user.id,
      size: file.fileSize,
      originKind: origin.kind,
      isForward: origin.isForward,
    },
    'MTProto ingestion queued',
  );

  return true;
}

// ---------------------------------------------------------------------------
// Multi-part intake
// ---------------------------------------------------------------------------

/**
 * Accept one piece of a split upload.
 *
 * The sender never has to declare anything: the session is created from the
 * first part's base name, later parts join it, and the file is assembled once
 * the set is complete (or on /finish, or after the idle timeout).
 */
async function handleIncomingPart(
  ctx: Context,
  user: UserRow,
  file: IncomingFile,
  parsed: ReturnType<typeof parsePartFilename> & object,
): Promise<void> {
  const chatId = ctx.chat!.id;
  const extension = extensionOf(parsed.baseFilename);

  // The *base* name decides what the finished media is, so it is validated the
  // same way a whole file would be.
  if (SUBTITLE_EXTENSIONS.has(extension)) {
    await ctx.reply('❌ Subtitle files are not accepted. Please send a video file.');
    return;
  }
  if (!extension || !config.storage.allowedExtensions.includes(extension)) {
    await ctx.reply(
      `❌ Unsupported file type${extension ? ` (.${esc(extension)})` : ''}.\n\n` +
        `The name before the part suffix must end in one of: ` +
        `${config.storage.allowedExtensions.map((e) => e.toUpperCase()).join(', ')}\n\n` +
        `For example <code>Movie.mkv.part1</code>.`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  // Each *piece* must be within what Telegram can actually deliver.
  if (file.fileSize > effectiveMaxFileSize()) {
    await ctx.reply(
      `❌ Part ${parsed.partNumber} is ${formatBytes(file.fileSize)}, above the ` +
        `${formatBytes(effectiveMaxFileSize())} per-part limit.\n\n` +
        `Split the file into smaller pieces.`,
    );
    return;
  }

  if (parsed.partNumber > config.multipart.maxParts) {
    await ctx.reply(
      `❌ Part numbers above ${config.multipart.maxParts} are not accepted. ` +
        `Use larger pieces.`,
    );
    return;
  }

  const quota = await checkQuota(user, file.fileSize);
  if (!quota.ok) {
    await ctx.reply(`\u{274C} <b>Upload rejected</b>\n\n${esc(quota.reason ?? 'Quota exceeded.')}`, {
      parse_mode: 'HTML',
    });
    return;
  }

  const space = await checkSpaceFor(file.fileSize);
  if (!space.ok) {
    await ctx.reply(`❌ Not enough server storage for this part.\n${space.reason ?? ''}`);
    return;
  }

  const safeBase = sanitizeFilename(parsed.baseFilename, `upload-${file.fileUniqueId}`);

  const session = await sessionsRepo.findOrCreate({
    user_id: user.id,
    telegram_chat_id: chatId,
    base_filename: parsed.baseFilename,
    safe_base_filename: safeBase,
    extension,
    expected_parts: parsed.totalParts,
  });

  // Refuse before accepting bytes that could never be assembled.
  const projected = session.received_bytes + file.fileSize;
  if (projected > config.multipart.maxAssembledBytes) {
    await ctx.reply(
      `❌ This upload would exceed the ${formatBytes(config.multipart.maxAssembledBytes)} ` +
        `maximum for an assembled file.`,
    );
    return;
  }

  const { part, outcome } = await partsRepo.upsert({
    session_id: session.id,
    part_number: parsed.partNumber,
    original_filename: file.fileName,
    telegram_file_id: file.fileId,
    telegram_file_unique_id: file.fileUniqueId,
    telegram_message_id: ctx.message?.message_id ?? null,
    file_size: file.fileSize,
  });

  if (outcome === 'duplicate') {
    await ctx.reply(
      `\u{2139}\u{FE0F} Part ${parsed.partNumber} was already received. Ignoring the duplicate.`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  await jobsRepo.enqueue({
    type: 'download-part',
    upload_id: null,
    session_id: session.id,
    payload: { partId: part.id, sessionId: session.id },
    max_attempts: config.worker.maxAttempts,
  });

  await auditRepo.log({
    actor_type: 'telegram',
    actor_id: String(chatId),
    action: outcome === 'replaced' ? 'multipart.part_replaced' : 'multipart.part_received',
    entity_type: 'session',
    entity_id: String(session.id),
    detail: { partNumber: parsed.partNumber, size: file.fileSize, userId: user.id },
  });

  log.info(
    {
      sessionId: session.id,
      partNumber: parsed.partNumber,
      size: file.fileSize,
      userId: user.id,
      outcome,
    },
    'Part queued',
  );

  // The first part creates the session's progress message; later parts edit it.
  if (session.progress_message_id === null) {
    const sent = await ctx.reply(
      `\u{1F9E9} <b>Multi-part upload started</b>\n<code>${esc(parsed.baseFilename)}</code>\n\n` +
        `Part ${parsed.partNumber} received (${formatBytes(file.fileSize)}).\n` +
        (parsed.totalParts
          ? `Expecting ${parsed.totalParts} parts.`
          : `Send the remaining parts, then /finish.`),
      { parse_mode: 'HTML' },
    );
    await sessionsRepo.patch(session.id, { progress_message_id: sent.message_id });
  } else if (outcome === 'replaced') {
    await ctx.reply(`\u{1F501} Part ${parsed.partNumber} replaced; downloading it again.`);
  }
}

// ---------------------------------------------------------------------------
// Multi-part commands
// ---------------------------------------------------------------------------

bot.command('parts', async (ctx) => {
  const user = await authenticate(ctx);
  if (!user) return void ctx.reply(UNREGISTERED_MESSAGE);

  const sessions = await sessionsRepo.openForUser(user.id);
  if (sessions.length === 0) {
    return void ctx.reply('You have no multi-part uploads in progress.');
  }

  const blocks: string[] = [];
  for (const session of sessions) {
    const ready = await partsRepo.readyNumbers(session.id);
    const missing = missingParts(ready, session.expected_parts);
    blocks.push(
      `<b>${esc(session.base_filename)}</b>\n` +
        `   ${session.status.toLowerCase()} • ${ready.length}` +
        `${session.expected_parts ? `/${session.expected_parts}` : ''} parts • ` +
        `${formatBytes(session.received_bytes)}` +
        (missing.length ? `\n   waiting for: ${describeMissing(missing)}` : ''),
    );
  }

  await ctx.reply(`\u{1F9E9} <b>Multi-part uploads</b>\n\n${blocks.join('\n\n')}`, {
    parse_mode: 'HTML',
  });
});

/**
 * Which of several sessions a command means.
 *
 * With one session there is nothing to choose. With several, only a non-empty
 * argument chooses: an empty string is contained in every filename, so a bare
 * command used to act on whichever session happened to be first — and for
 * /cancelupload that meant deleting the wrong upload's parts.
 */
function pickSession<T extends { base_filename: string }>(sessions: T[], argument: string): T | undefined {
  if (sessions.length === 1) return sessions[0];
  const wanted = argument.trim().toLowerCase();
  if (!wanted) return undefined;
  return sessions.find((s) => s.base_filename.toLowerCase().includes(wanted));
}

bot.command('finish', async (ctx) => {
  const user = await authenticate(ctx);
  if (!user) return void ctx.reply(UNREGISTERED_MESSAGE);
  // The same gate as a new file: finishing an assembly files media into the
  // library, and a disabled account must not be able to do that either.
  if (!user.active) return void ctx.reply('❌ Your account is deactivated. Please contact the administrator.');
  if (!user.upload_enabled) return void ctx.reply('❌ Uploading is currently disabled for your account.');

  const sessions = await sessionsRepo.openForUser(user.id);
  const collecting = sessions.filter((s) => s.status === 'COLLECTING');

  if (collecting.length === 0) {
    return void ctx.reply('You have no multi-part upload waiting to be finished.');
  }

  // With several in flight, the argument disambiguates; otherwise the only one.
  const target = pickSession(collecting, ctx.match?.toString() ?? '');

  if (!target) {
    const names = collecting.map((s) => `• <code>${esc(s.base_filename)}</code>`).join('\n');
    return void ctx.reply(
      `You have several uploads in progress. Say which one, for example ` +
        `<code>/finish Movie.mkv</code>\n\n${names}`,
      { parse_mode: 'HTML' },
    );
  }

  const ready = await partsRepo.readyNumbers(target.id);
  const missing = missingParts(ready, target.expected_parts);

  if (ready.length === 0) {
    return void ctx.reply('No parts have finished downloading yet. Try again shortly.');
  }
  if (missing.length > 0) {
    return void ctx.reply(
      `❌ Cannot finish yet — still missing part${missing.length > 1 ? 's' : ''}: ` +
        `${describeMissing(missing)}`,
    );
  }

  try {
    await beginAssembly(target);
    log.info({ sessionId: target.id, parts: ready.length }, 'Assembly requested by user');
  } catch (err) {
    await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' });
  }
});

bot.command('cancelupload', async (ctx) => {
  const user = await authenticate(ctx);
  if (!user) return void ctx.reply(UNREGISTERED_MESSAGE);

  const sessions = await sessionsRepo.openForUser(user.id);
  if (sessions.length === 0) {
    return void ctx.reply('You have no multi-part uploads to cancel.');
  }

  const target = pickSession(sessions, ctx.match?.toString() ?? '');

  if (!target) {
    const names = sessions.map((s) => `• <code>${esc(s.base_filename)}</code>`).join('\n');
    return void ctx.reply(
      `Say which upload to cancel, for example <code>/cancelupload Movie.mkv</code>\n\n${names}`,
      { parse_mode: 'HTML' },
    );
  }

  await sessionsRepo.requestCancel(target.id);
  await auditRepo.log({
    actor_type: 'telegram',
    actor_id: String(ctx.chat?.id ?? ''),
    action: 'multipart.cancelled',
    entity_type: 'session',
    entity_id: String(target.id),
  });
  await ctx.reply(
    `\u{1F6D1} Cancelling <code>${esc(target.base_filename)}</code>. Its parts will be removed.`,
    { parse_mode: 'HTML' },
  );
});

/**
 * Retry a multi-part upload whose parts failed to download or whose assembly
 * failed. The worker's messages have pointed at this command since the
 * multi-part flow was written; it simply did not exist.
 */
bot.command('retry', async (ctx) => {
  const user = await authenticate(ctx);
  if (!user) return void ctx.reply(UNREGISTERED_MESSAGE);
  if (!user.active) return void ctx.reply('❌ Your account is deactivated. Please contact the administrator.');
  if (!user.upload_enabled) return void ctx.reply('❌ Uploading is currently disabled for your account.');

  const recent = await sessionsRepo.search({ userId: user.id, limit: 20, offset: 0 });
  const candidates: typeof recent.rows = [];
  for (const s of recent.rows) {
    // READY is where a retryable assembly failure parks; FAILED is the
    // permanent kind, whose parts are kept for exactly this; COLLECTING only
    // counts when some of its parts have failed.
    if (s.status === 'FAILED' || s.status === 'READY') candidates.push(s);
    else if (s.status === 'COLLECTING' && (await partsRepo.failedCount(s.id)) > 0) candidates.push(s);
  }

  if (candidates.length === 0) {
    return void ctx.reply('Nothing of yours needs a retry right now. /parts shows what is in progress.');
  }

  const target = pickSession(candidates, ctx.match?.toString() ?? '');
  if (!target) {
    const names = candidates.map((s) => `• <code>${esc(s.base_filename)}</code>`).join('\n');
    return void ctx.reply(
      `Say which upload to retry, for example <code>/retry Movie.mkv</code>\n\n${names}`,
      { parse_mode: 'HTML' },
    );
  }

  try {
    const { requeued } = await retrySession(target.id);
    await auditRepo.log({
      actor_type: 'telegram',
      actor_id: String(ctx.chat?.id ?? ''),
      action: 'multipart.retried',
      entity_type: 'session',
      entity_id: String(target.id),
      detail: { requeued },
    });
    await ctx.reply(
      requeued > 0
        ? `\u{1F504} Retrying <code>${esc(target.base_filename)}</code>: ${requeued} part${requeued === 1 ? '' : 's'} queued again.`
        : `\u{1F504} Reassembling <code>${esc(target.base_filename)}</code>.`,
      { parse_mode: 'HTML' },
    );
  } catch (err) {
    await ctx.reply(`❌ ${esc((err as Error).message)}`, { parse_mode: 'HTML' });
  }
});

bot.on('message:document', handleIncomingFile);
bot.on('message:video', handleIncomingFile);

// Explicitly refuse the media types people commonly try.
bot.on(['message:audio', 'message:voice', 'message:photo', 'message:animation', 'message:sticker'], async (ctx) => {
  const user = await authenticate(ctx);
  if (!user) return void ctx.reply(UNREGISTERED_MESSAGE);
  await ctx.reply(
    `❌ Unsupported file type.\n\nAccepted formats: ${config.storage.allowedExtensions
      .map((e) => e.toUpperCase())
      .join(', ')}`,
  );
});

bot.on('message:text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  const user = await authenticate(ctx);
  if (!user) return void ctx.reply(UNREGISTERED_MESSAGE);
  await ctx.reply('Send me a video file and I will add it to your library. /help for details.');
});

// ---------------------------------------------------------------------------
// Errors and lifecycle
// ---------------------------------------------------------------------------

bot.catch((err) => {
  const e = err.error;
  if (e instanceof GrammyError) log.error({ description: e.description }, 'Telegram API error');
  else if (e instanceof HttpError) log.error({ err: e }, 'Could not reach Telegram');
  else log.error({ err: e }, 'Bot handler error');
});

async function main(): Promise<void> {
  ensureDirectories();
  await runMigrations();

  await bot.api.setMyCommands([
    { command: 'start', description: 'Register check and welcome' },
    { command: 'status', description: 'Your recent uploads' },
    { command: 'library', description: 'What you have stored' },
    { command: 'parts', description: 'Multi-part uploads in progress' },
    { command: 'finish', description: 'Assemble a finished multi-part upload' },
    { command: 'retry', description: 'Retry a failed multi-part upload' },
    { command: 'cancelupload', description: 'Cancel a multi-part upload' },
    { command: 'help', description: 'How to use this bot' },
  ]);

  // The persistent button beside the message box. Registered once at startup
  // and only when a usable https URL exists; setting it to `commands`
  // otherwise restores Telegram's default rather than leaving a stale button
  // pointing at an app that is no longer served.
  if (config.miniapp.configured) {
    await bot.api
      .setChatMenuButton({
        menu_button: { type: 'web_app', text: 'Media', web_app: { url: config.miniapp.url } },
      })
      .then(() => log.info({ url: config.miniapp.url }, 'Mini App menu button registered'))
      .catch((err) => log.warn({ err }, 'Could not register the Mini App menu button'));
  } else {
    await bot.api
      .setChatMenuButton({ menu_button: { type: 'commands' } })
      .catch((err) => log.debug({ err }, 'Could not reset the chat menu button'));
    if (config.miniapp.enabled && config.miniapp.url) {
      log.warn(
        { url: config.miniapp.url },
        'MINIAPP_URL is set but is not https, so Telegram will not accept it; no button registered',
      );
    }
  }

  const me = await bot.api.getMe();
  log.info(
    {
      botUsername: me.username,
      botId: me.id,
      apiRoot: config.telegram.apiRoot,
      localMode: config.telegram.localMode,
    },
    'Bot starting',
  );

  // Pending updates are kept: a file sent while the bot was down for a deploy
  // is a real upload, and dropping it lost it silently. A message the bot had
  // already begun handling when it was stopped is confirmed and not redelivered
  // (see `shutdown`), so the one duplicate that could arrive — a crash mid-
  // handler — is caught by the pipeline's checksum dedupe.
  polling = bot.start({
    allowed_updates: ['message'],
    onStart: () => log.info('Bot is polling for updates'),
  });
  await polling;
}

let polling: Promise<void> | null = null;

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'Stopping bot');
  // `bot.stop()` ends polling but does not wait for the handler that is
  // running right now; the promise from `bot.start()` does. Closing the pool
  // underneath a handler mid-way between creating an upload and queueing its
  // job is how orphaned RECEIVED rows were made.
  await bot.stop();
  await Promise.race([polling ?? Promise.resolve(), new Promise((r) => setTimeout(r, 30_000))]);
  await closePool();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => log.error({ err: reason }, 'Unhandled rejection'));

main().catch((err) => {
  log.fatal({ err }, 'Bot failed to start');
  reportStartupFailure(err);
  process.exit(1);
});
