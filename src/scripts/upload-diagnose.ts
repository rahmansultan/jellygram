import { stdout } from 'node:process';
import fsp from 'node:fs/promises';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { scrubString } from '../lib/logger.js';
import { closePool, query } from '../db/pool.js';
import { uploadsRepo, usersRepo } from '../db/repositories.js';
import * as jf from '../services/jellyfin.js';
import { formatBytes, hashFile, mediaGid } from '../services/storage.js';
import type { JobRow, MediaRow, UploadRow } from '../db/types.js';

/**
 * Everything known about one upload, in one place.
 *
 *   npm run upload:diagnose -- --upload-id 539
 *   npm run upload:diagnose -- --failed          most recent failures
 *   npm run upload:diagnose -- --upload-id 539 --checksum
 *
 * Read-only. Secrets are scrubbed on the way out: the local Bot API server
 * stores files under a directory named after the bot token, so any path from
 * that side is passed through the log scrubber before printing.
 */

const log = createLogger('cli');

function say(text = ''): void {
  stdout.write(`${scrubString(text)}\n`);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const has = (name: string): boolean => process.argv.includes(`--${name}`);

function row(label: string, value: unknown): void {
  say(`  ${label.padEnd(22)} ${value === null || value === undefined || value === '' ? '—' : String(value)}`);
}

async function fileFacts(path: string | null, wantChecksum: boolean): Promise<void> {
  if (!path) return row('file', '— (no path recorded)');
  row('path', path);
  try {
    const st = await fsp.stat(path);
    const gid = await mediaGid();
    row('file size', `${formatBytes(st.size)} (${st.size} bytes)`);
    row('owner', `uid=${st.uid} gid=${st.gid}${gid !== null && st.gid !== gid ? `  ** expected gid ${gid} **` : ''}`);
    row('mode', (st.mode & 0o7777).toString(8).padStart(4, '0'));
    row('modified', st.mtime.toISOString());
    if (wantChecksum) row('sha256', await hashFile(path));
  } catch (err) {
    row('file', `NOT PRESENT (${(err as NodeJS.ErrnoException).code})`);
  }
}

async function describe(upload: UploadRow, wantChecksum: boolean): Promise<void> {
  say();
  say(`Upload #${upload.id}`);
  say('='.repeat(60));

  say('Identity');
  row('status', upload.status);
  row('source', upload.source);
  row('filename', upload.original_filename);
  row('extension', upload.extension);
  row('mime type', upload.mime_type);
  row('declared size', `${formatBytes(upload.file_size)} (${upload.file_size} bytes)`);
  row('bytes downloaded', `${formatBytes(upload.bytes_downloaded)} (${upload.bytes_downloaded})`);
  row('created', upload.created_at.toISOString());
  row('updated', upload.updated_at.toISOString());
  row('duration', upload.duration_ms === null ? null : `${Math.round(upload.duration_ms / 1000)}s`);

  say();
  say('Telegram');
  row('chat id', upload.telegram_chat_id);
  row('message id', upload.telegram_message_id);
  // file_id is a capability for this bot to fetch the file: shown truncated.
  row('file id', upload.telegram_file_id ? `${upload.telegram_file_id.slice(0, 12)}… (truncated)` : null);
  row('multipart session', upload.session_id);
  row('mtproto job', upload.mtproto_job_id);

  say();
  say('Failure');
  if (upload.status === 'FAILED') {
    row('stage', upload.error_stage ?? '(recorded before this column existed)');
    row('code', upload.error_code);
    row('retryable', upload.error_retryable);
    row('attempts', upload.attempts);
    row('failed at', upload.error_at ? upload.error_at.toISOString() : null);
    say(`  message                ${scrubString(upload.error_message ?? '—')}`);
  } else {
    row('none', `status is ${upload.status}`);
  }

  say();
  say('Identification');
  row('type', upload.media_type);
  row('title', upload.detected_title);
  row('year', upload.detected_year);
  row('season/episode', upload.detected_season ? `S${upload.detected_season}E${upload.detected_episode}` : null);
  row('recorded sha256', upload.checksum_sha256);

  say();
  say('Filesystem — staging');
  await fileFacts(upload.local_source_path, wantChecksum);
  say();
  say('Filesystem — library');
  await fileFacts(upload.stored_path, wantChecksum);

  // --- jobs -----------------------------------------------------------------
  const { rows: jobs } = await query<JobRow>(
    `SELECT * FROM jobs WHERE upload_id = $1 ORDER BY id DESC LIMIT 5`,
    [upload.id],
  );
  say();
  say('Jobs');
  if (jobs.length === 0) row('none', 'no job rows reference this upload');
  for (const j of jobs) {
    say(
      `  #${j.id} ${j.type} ${j.status} attempts=${j.attempts}/${j.max_attempts}` +
        `${j.last_error ? ` last_error=${scrubString(String(j.last_error)).slice(0, 120)}` : ''}`,
    );
  }

  // --- media / jellyfin -----------------------------------------------------
  const { rows: mediaRows } = await query<MediaRow>(
    `SELECT * FROM media WHERE upload_id = $1 ORDER BY id DESC LIMIT 1`,
    [upload.id],
  );
  const media = mediaRows[0] ?? null;
  say();
  say('Jellyfin');
  if (!media) {
    row('media row', 'none — never reached the organise stage');
  } else {
    row('media id', media.id);
    row('library path', media.path);
    row('verified', media.jellyfin_verified);
    row('item id', media.jellyfin_item_id);

    if (config.jellyfin.configured && media.jellyfin_item_id === null) {
      const user = await usersRepo.byId(media.user_id);
      if (user?.jellyfin_user_id) {
        const item = await jf
          .findItemByPath(user.jellyfin_user_id, media.path, media.title)
          .catch((err) => {
            row('live lookup', `failed: ${(err as Error).message}`);
            return null;
          });
        row('live lookup', item ? `Jellyfin has it now (${item.id})` : 'Jellyfin still does not have it');
      }
    }
  }
  say();
}

async function main(): Promise<void> {
  const id = arg('upload-id');
  const wantChecksum = has('checksum');

  if (has('failed') || !id) {
    const { rows } = await query<UploadRow>(
      `SELECT * FROM uploads WHERE status = 'FAILED' ORDER BY updated_at DESC LIMIT 10`,
    );
    say();
    say('Recent failed uploads');
    say('=====================');
    if (rows.length === 0) say('  none');
    for (const u of rows) {
      say(
        `  #${String(u.id).padEnd(6)} ${(u.error_stage ?? '?').padEnd(14)} ` +
          `${(u.error_code ?? '?').padEnd(14)} ${u.original_filename.slice(0, 44)}`,
      );
      if (u.error_message) say(`         ${scrubString(u.error_message).slice(0, 120)}`);
    }
    say();
    if (!id) {
      say('Run with --upload-id <id> for the full picture.');
      return;
    }
  }

  const upload = await uploadsRepo.byId(Number(id));
  if (!upload) {
    say(`No upload with id ${id}.`);
    process.exitCode = 1;
    return;
  }
  await describe(upload, wantChecksum);
}

main()
  .catch((err) => {
    log.error({ err }, 'Diagnosis failed');
    say(`Failed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
