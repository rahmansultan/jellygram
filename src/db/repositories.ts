import { config } from '../config/index.js';
import type pg from 'pg';
import { pool, query, withTransaction, type Queryable } from './pool.js';
import {
  ACTIVE_MTPROTO_STATUSES,
  ACTIVE_SESSION_STATUSES,
  TERMINAL_STATUSES,
} from './types.js';
import type {
  AdminRow,
  JobRow,
  MediaRow,
  ForwardOriginKind,
  MediaType,
  MtprotoJobRow,
  MtprotoStatus,
  PartStatus,
  SessionStatus,
  UploadPartRow,
  UploadRow,
  UploadSessionRow,
  UploadStatus,
  UserLibraryRow,
  UserRow,
} from './types.js';

/**
 * All SQL lives here. Every statement is parameterised; no query is ever built
 * by string concatenation with caller-supplied values.
 */

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * A search term, made literal.
 *
 * `%` and `_` are wildcards to `LIKE`, so a filename search for `The_Movie`
 * quietly matched `TheXMovie`, and a search for `%` returned the entire table.
 * Underscores are ordinary in release names, which made the difference between
 * "contains this" and "matches this pattern" something the reader could not
 * see. The audit search already escaped them; every other search did not.
 *
 * Escaping the backslash first matters: doing it last would re-escape the
 * backslashes just added for `%` and `_`.
 */
export function likeLiteral(term: string): string {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

export const usersRepo = {
  async list(): Promise<UserRow[]> {
    const { rows } = await query<UserRow>('SELECT * FROM users ORDER BY name ASC');
    return rows;
  },

  async byId(id: number): Promise<UserRow | null> {
    const { rows } = await query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ?? null;
  },

  /** The bot's authorisation check: unknown or inactive chat ids get nothing. */
  async byTelegramChatId(chatId: number): Promise<UserRow | null> {
    const { rows } = await query<UserRow>('SELECT * FROM users WHERE telegram_chat_id = $1', [
      chatId,
    ]);
    return rows[0] ?? null;
  },

  async byJellyfinUsername(username: string): Promise<UserRow | null> {
    const { rows } = await query<UserRow>(
      'SELECT * FROM users WHERE lower(jellyfin_username) = lower($1)',
      [username],
    );
    return rows[0] ?? null;
  },

  async create(input: {
    name: string;
    telegram_chat_id: number;
    jellyfin_username: string;
    jellyfin_user_id: string | null;
    storage_slug: string;
    active?: boolean;
    upload_enabled?: boolean;
    quota_bytes?: number | null;
    notes?: string | null;
  }): Promise<UserRow> {
    const { rows } = await query<UserRow>(
      `INSERT INTO users
         (name, telegram_chat_id, jellyfin_username, jellyfin_user_id, storage_slug,
          active, upload_enabled, quota_bytes, notes)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,TRUE),COALESCE($7,TRUE),$8,$9)
       RETURNING *`,
      [
        input.name,
        input.telegram_chat_id,
        input.jellyfin_username,
        input.jellyfin_user_id,
        input.storage_slug,
        input.active ?? null,
        input.upload_enabled ?? null,
        input.quota_bytes ?? null,
        input.notes ?? null,
      ],
    );
    return rows[0]!;
  },

  async update(
    id: number,
    patch: Partial<
      Pick<
        UserRow,
        | 'name'
        | 'telegram_chat_id'
        | 'jellyfin_username'
        | 'jellyfin_user_id'
        | 'storage_slug'
        | 'active'
        | 'upload_enabled'
        | 'quota_bytes'
        | 'notes'
      >
    >,
  ): Promise<UserRow | null> {
    const allowed = [
      'name',
      'telegram_chat_id',
      'jellyfin_username',
      'jellyfin_user_id',
      'storage_slug',
      'active',
      'upload_enabled',
      'quota_bytes',
      'notes',
    ] as const;

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        values.push(patch[key]);
        sets.push(`${key} = $${values.length}`);
      }
    }
    if (sets.length === 0) return this.byId(id);

    values.push(id);
    const { rows } = await query<UserRow>(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    return rows[0] ?? null;
  },

  async remove(id: number): Promise<boolean> {
    const { rowCount } = await query('DELETE FROM users WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  /** Bytes stored per user, derived from the media table rather than a disk walk. */
  async storageUsage(): Promise<Array<{ user_id: number; bytes: number; items: number }>> {
    const { rows } = await query<{ user_id: number; bytes: number; items: number }>(
      `SELECT user_id, COALESCE(SUM(file_size), 0)::bigint AS bytes, COUNT(*)::bigint AS items
         FROM media GROUP BY user_id`,
    );
    return rows;
  },
};

// ---------------------------------------------------------------------------
// User libraries
// ---------------------------------------------------------------------------

export const librariesRepo = {
  /**
   * Managed library ids belonging to every user except this one.
   *
   * Provisioning strips exactly these from an account: they are the only
   * libraries whose visibility would break another user's privacy.
   */
  async itemIdsExcludingUser(userId: number): Promise<Set<string>> {
    const { rows } = await query<{ jellyfin_item_id: string }>(
      'SELECT jellyfin_item_id FROM user_libraries WHERE user_id <> $1 AND jellyfin_item_id IS NOT NULL',
      [userId],
    );
    return new Set(rows.map((r) => r.jellyfin_item_id));
  },

  async listForUser(userId: number): Promise<UserLibraryRow[]> {
    const { rows } = await query<UserLibraryRow>(
      'SELECT * FROM user_libraries WHERE user_id = $1 ORDER BY media_type',
      [userId],
    );
    return rows;
  },

  async listAll(): Promise<UserLibraryRow[]> {
    const { rows } = await query<UserLibraryRow>('SELECT * FROM user_libraries ORDER BY user_id');
    return rows;
  },

  async upsert(input: {
    user_id: number;
    media_type: MediaType;
    library_name: string;
    library_path: string;
    jellyfin_item_id: string | null;
  }): Promise<UserLibraryRow> {
    const { rows } = await query<UserLibraryRow>(
      `INSERT INTO user_libraries (user_id, media_type, library_name, library_path, jellyfin_item_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, media_type) DO UPDATE
         SET library_name = EXCLUDED.library_name,
             library_path = EXCLUDED.library_path,
             jellyfin_item_id = COALESCE(EXCLUDED.jellyfin_item_id, user_libraries.jellyfin_item_id)
       RETURNING *`,
      [input.user_id, input.media_type, input.library_name, input.library_path, input.jellyfin_item_id],
    );
    return rows[0]!;
  },

  async removeForUser(userId: number): Promise<void> {
    await query('DELETE FROM user_libraries WHERE user_id = $1', [userId]);
  },
};

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

export const uploadsRepo = {
  async create(input: {
    user_id: number;
    telegram_chat_id: number;
    telegram_message_id: number | null;
    telegram_file_id: string;
    telegram_file_unique_id: string | null;
    original_filename: string;
    safe_filename: string;
    extension: string;
    mime_type: string | null;
    file_size: number;
  }): Promise<UploadRow> {
    const { rows } = await query<UploadRow>(
      `INSERT INTO uploads
         (user_id, telegram_chat_id, telegram_message_id, telegram_file_id,
          telegram_file_unique_id, original_filename, safe_filename, extension,
          mime_type, file_size, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'RECEIVED')
       RETURNING *`,
      [
        input.user_id,
        input.telegram_chat_id,
        input.telegram_message_id,
        input.telegram_file_id,
        input.telegram_file_unique_id,
        input.original_filename,
        input.safe_filename,
        input.extension,
        input.mime_type,
        input.file_size,
      ],
    );
    return rows[0]!;
  },

  /**
   * Create the upload row for a file that has already been assembled on disk.
   *
   * From here the file takes exactly the same path as a single-file upload:
   * identify, deduplicate, organise, Jellyfin. Only the download stage differs,
   * and it differs by reading `local_source_path` instead of calling Telegram.
   */
  async createFromSession(input: {
    user_id: number;
    telegram_chat_id: number;
    session_id: number;
    original_filename: string;
    safe_filename: string;
    extension: string;
    file_size: number;
    local_source_path: string;
    progress_message_id: number | null;
    source?: 'telegram' | 'direct';
  }, client: Queryable = pool): Promise<UploadRow> {
    const { rows } = await query<UploadRow>(
      `INSERT INTO uploads
         (user_id, telegram_chat_id, telegram_message_id, telegram_file_id,
          telegram_file_unique_id, original_filename, safe_filename, extension,
          mime_type, file_size, status, local_source_path, session_id, progress_message_id, source)
       VALUES ($1,$2,NULL,NULL,NULL,$3,$4,$5,NULL,$6,'QUEUED',$7,$8,$9,COALESCE($10,'telegram'))
       RETURNING *`,
      [
        input.user_id,
        input.telegram_chat_id,
        input.original_filename,
        input.safe_filename,
        input.extension,
        input.file_size,
        input.local_source_path,
        input.session_id,
        input.progress_message_id,
        input.source ?? null,
      ],
      client,
    );
    return rows[0]!;
  },

  /**
   * Create the upload row for media fetched over MTProto.
   *
   * Identical to every other route from here on: the pipeline reads
   * `local_source_path` and each later stage is unchanged.
   */
  async createFromMtproto(input: {
    user_id: number;
    telegram_chat_id: number;
    mtproto_job_id: number;
    original_filename: string;
    safe_filename: string;
    extension: string;
    file_size: number;
    local_source_path: string;
    progress_message_id: number | null;
  }, client: Queryable = pool): Promise<UploadRow> {
    const { rows } = await query<UploadRow>(
      `INSERT INTO uploads
         (user_id, telegram_chat_id, telegram_message_id, telegram_file_id,
          telegram_file_unique_id, original_filename, safe_filename, extension,
          mime_type, file_size, status, local_source_path, progress_message_id,
          source, mtproto_job_id)
       VALUES ($1,$2,NULL,NULL,NULL,$3,$4,$5,NULL,$6,'QUEUED',$7,$8,'mtproto',$9)
       RETURNING *`,
      [
        input.user_id,
        input.telegram_chat_id,
        input.original_filename,
        input.safe_filename,
        input.extension,
        input.file_size,
        input.local_source_path,
        input.progress_message_id,
        input.mtproto_job_id,
      ],
      client,
    );
    return rows[0]!;
  },

  /**
   * An upload whose bytes the uploader streamed straight to this server.
   *
   * Identical to a Telegram upload from here on: the pipeline reads
   * `local_source_path` and every later stage is unchanged.
   */
  async createDirect(input: {
    user_id: number;
    telegram_chat_id: number;
    original_filename: string;
    safe_filename: string;
    extension: string;
    file_size: number;
    local_source_path: string;
  }): Promise<UploadRow> {
    const { rows } = await query<UploadRow>(
      `INSERT INTO uploads
         (user_id, telegram_chat_id, telegram_message_id, telegram_file_id,
          telegram_file_unique_id, original_filename, safe_filename, extension,
          mime_type, file_size, status, local_source_path, source)
       VALUES ($1,$2,NULL,NULL,NULL,$3,$4,$5,NULL,$6,'QUEUED',$7,'direct')
       RETURNING *`,
      [
        input.user_id,
        input.telegram_chat_id,
        input.original_filename,
        input.safe_filename,
        input.extension,
        input.file_size,
        input.local_source_path,
      ],
    );
    return rows[0]!;
  },

  async byId(id: number, client: Queryable = pool): Promise<UploadRow | null> {
    const { rows } = await query<UploadRow>('SELECT * FROM uploads WHERE id = $1', [id], client);
    return rows[0] ?? null;
  },

  /**
   * Publish live progress for the dashboard.
   *
   * Deliberately a narrow, single-statement write on the hot path: it runs
   * every couple of seconds per active upload, and it must never be able to
   * disturb the row's status or its failure detail.
   */
  async setProgressSnapshot(
    id: number,
    snapshot: {
      stage: string;
      percent: number;
      byteAccurate: boolean;
      bytes: number | null;
      bytesPerSecond: number | null;
      etaSeconds: number | null;
      part: { index: number; count: number } | null;
    },
  ): Promise<void> {
    await query(
      `UPDATE uploads
          SET progress_stage         = $2,
              progress_percent       = $3,
              progress_byte_accurate = $4,
              progress_bytes_per_sec = $5,
              progress_eta_sec       = $6,
              progress_part          = $7,
              progress_part_count    = $8,
              progress_updated_at    = now(),
              bytes_downloaded       = COALESCE($9, bytes_downloaded)
        WHERE id = $1`,
      [
        id,
        snapshot.stage,
        snapshot.percent,
        snapshot.byteAccurate,
        snapshot.bytesPerSecond,
        snapshot.etaSeconds,
        snapshot.part?.index ?? null,
        snapshot.part?.count ?? null,
        // Only a byte-accurate stage may move the byte counter; a stage-based
        // percentage says nothing about how much has been transferred.
        snapshot.byteAccurate ? snapshot.bytes : null,
      ],
    );
  },

  async setStatus(
    id: number,
    status: UploadStatus,
    extra: {
      error_message?: string | null;
      completed_at?: Date | null;
      duration_ms?: number | null;
      /** Structured failure detail; only meaningful alongside FAILED. */
      error_stage?: string | null;
      error_code?: string | null;
      error_retryable?: boolean | null;
      error_at?: Date | null;
      attempts?: number | null;
    } = {},
  ): Promise<UploadRow | null> {
    const { rows } = await query<UploadRow>(
      `UPDATE uploads
          SET status = $2,
              error_message = COALESCE($3, CASE WHEN $2 = 'FAILED' THEN error_message ELSE NULL END),
              completed_at  = COALESCE($4, completed_at),
              duration_ms   = COALESCE($5, duration_ms),
              -- Cleared on any non-FAILED transition so a later success never
              -- leaves a stale cause behind on the row.
              error_stage     = CASE WHEN $2 = 'FAILED' THEN COALESCE($6, error_stage) ELSE NULL END,
              error_code      = CASE WHEN $2 = 'FAILED' THEN COALESCE($7, error_code) ELSE NULL END,
              error_retryable = CASE WHEN $2 = 'FAILED' THEN COALESCE($8, error_retryable) ELSE NULL END,
              error_at        = CASE WHEN $2 = 'FAILED' THEN COALESCE($9, error_at) ELSE NULL END,
              attempts        = COALESCE($10, attempts)
        WHERE id = $1
        RETURNING *`,
      [
        id,
        status,
        extra.error_message ?? null,
        extra.completed_at ?? null,
        extra.duration_ms ?? null,
        extra.error_stage ?? null,
        extra.error_code ?? null,
        extra.error_retryable ?? null,
        extra.error_at ?? null,
        extra.attempts ?? null,
      ],
    );
    return rows[0] ?? null;
  },

  async patch(
    id: number,
    patch: Partial<
      Pick<
        UploadRow,
        | 'progress_message_id'
        | 'stored_path'
        | 'file_size'
        | 'bytes_downloaded'
        | 'checksum_sha256'
        | 'media_type'
        | 'detected_title'
        | 'detected_year'
        | 'detected_season'
        | 'detected_episode'
        | 'cancel_requested'
        | 'local_source_path'
      >
    >,
  ): Promise<UploadRow | null> {
    const allowed = [
      'progress_message_id',
      'stored_path',
      'file_size',
      'bytes_downloaded',
      'checksum_sha256',
      'media_type',
      'detected_title',
      'detected_year',
      'detected_season',
      'detected_episode',
      'cancel_requested',
      // Moves with the staged file: once the pipeline has taken a local
      // source into its scratch directory, a retry must look there.
      'local_source_path',
    ] as const;

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        values.push(patch[key]);
        sets.push(`${key} = $${values.length}`);
      }
    }
    if (sets.length === 0) return this.byId(id);

    values.push(id);
    const { rows } = await query<UploadRow>(
      `UPDATE uploads SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    return rows[0] ?? null;
  },

  /** Progress is written often; keep it to one cheap statement. */
  async setProgress(id: number, bytesDownloaded: number): Promise<void> {
    await query('UPDATE uploads SET bytes_downloaded = $2 WHERE id = $1', [id, bytesDownloaded]);
  },

  /**
   * Cancel an upload.
   *
   * A pipeline that is running it sees `cancel_requested` at its next
   * checkpoint and finishes the cancellation itself, with the Telegram edit.
   * One that is *not* running — queued, or backing off after a failed attempt
   * — has nobody to do that: its pending job is cancelled here, and with it
   * gone the upload would otherwise sit at QUEUED forever, holding its quota
   * and its staging file and refusing both retry and a second cancel. So when
   * no job is active the upload is made terminal in the same transaction.
   */
  async requestCancel(id: number): Promise<UploadRow | null> {
    return withTransaction(async (client: pg.PoolClient) => {
      const { rows } = await client.query<UploadRow>(
        `UPDATE uploads SET cancel_requested = TRUE
          WHERE id = $1 AND NOT (status = ANY($2::text[]))
          RETURNING *`,
        [id, TERMINAL_STATUSES as readonly string[]],
      );
      const row = rows[0];
      if (!row) return null;

      await client.query(
        `UPDATE jobs SET status='cancelled', finished_at=now() WHERE upload_id=$1 AND status='pending'`,
        [id],
      );
      const { rows: active } = await client.query(
        `SELECT 1 FROM jobs WHERE upload_id = $1 AND status = 'active' LIMIT 1`,
        [id],
      );
      if (active.length > 0) return row;

      const { rows: done } = await client.query<UploadRow>(
        `UPDATE uploads
            SET status = 'CANCELLED', completed_at = now(),
                error_message = 'Cancelled before it ran',
                progress_stage = 'CANCELLED', progress_updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [id],
      );
      return done[0] ?? row;
    });
  },

  async isCancelRequested(id: number): Promise<boolean> {
    const { rows } = await query<{ cancel_requested: boolean }>(
      'SELECT cancel_requested FROM uploads WHERE id = $1',
      [id],
    );
    return rows[0]?.cancel_requested ?? false;
  },

  async search(opts: {
    userId?: number;
    status?: UploadStatus;
    /**
     * Several statuses at once, filtered in SQL.
     *
     * "Everything still running" cannot be expressed as one status, and doing
     * it by fetching a page and filtering in JavaScript loses any row with
     * more than a page of newer ones — and reports a total that is really the
     * size of the filtered page.
     */
    statusIn?: readonly UploadStatus[];
    mediaType?: string;
    q?: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: Array<UploadRow & { user_name: string }>; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (opts.userId !== undefined) {
      values.push(opts.userId);
      where.push(`u.user_id = $${values.length}`);
    }
    if (opts.status) {
      values.push(opts.status);
      where.push(`u.status = $${values.length}`);
    }
    if (opts.statusIn && opts.statusIn.length > 0) {
      values.push(opts.statusIn as readonly string[]);
      where.push(`u.status = ANY($${values.length}::text[])`);
    }
    if (opts.mediaType) {
      values.push(opts.mediaType);
      where.push(`u.media_type = $${values.length}`);
    }
    if (opts.q) {
      values.push(likeLiteral(opts.q));
      where.push(`(u.original_filename ILIKE $${values.length} OR u.detected_title ILIKE $${values.length})`);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalRes = await query<{ count: number }>(
      `SELECT COUNT(*)::bigint AS count FROM uploads u ${clause}`,
      values,
    );

    values.push(opts.limit, opts.offset);
    // The media row is joined rather than fetched per upload: a list of 100
    // completed uploads would otherwise be 101 queries just to say whether
    // each one is visible in Jellyfin.
    const { rows } = await query<UploadRow & { user_name: string; jellyfin_verified: boolean | null; media_id: number | null }>(
      `SELECT u.*, us.name AS user_name, m.jellyfin_verified, m.id AS media_id
         FROM uploads u
         JOIN users us ON us.id = u.user_id
         LEFT JOIN LATERAL (
           SELECT id, jellyfin_verified FROM media WHERE upload_id = u.id ORDER BY id LIMIT 1
         ) m ON TRUE
         ${clause}
         ORDER BY u.created_at DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );

    return { rows, total: totalRes.rows[0]?.count ?? 0 };
  },

  async recent(limit = 10): Promise<Array<UploadRow & { user_name: string }>> {
    const { rows } = await query<UploadRow & { user_name: string }>(
      `SELECT u.*, us.name AS user_name
         FROM uploads u JOIN users us ON us.id = u.user_id
         ORDER BY u.created_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  },

  async statusCounts(): Promise<Record<string, number>> {
    const { rows } = await query<{ status: string; count: number }>(
      'SELECT status, COUNT(*)::bigint AS count FROM uploads GROUP BY status',
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.count]));
  },

  async statusCountsForUser(userId: number): Promise<Record<string, number>> {
    const { rows } = await query<{ status: string; count: number }>(
      'SELECT status, COUNT(*)::bigint AS count FROM uploads WHERE user_id = $1 GROUP BY status',
      [userId],
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.count]));
  },

  /**
   * When this user first and last sent something, and how long a finished
   * upload typically takes them.
   *
   * The median rather than the mean: one 5 GiB transfer that took four hours
   * would otherwise make every other upload look slow. Measured from
   * `duration_ms` — the work itself — rather than from created_at, which also
   * counts time spent waiting in the queue and is a different question. The
   * uploads table's "Took" column reports the same figure.
   */
  async activityForUser(userId: number): Promise<{
    firstAt: string | null;
    lastAt: string | null;
    medianDurationMs: number | null;
  }> {
    const { rows } = await query<{
      first_at: Date | null;
      last_at: Date | null;
      median_ms: string | null;
    }>(
      `SELECT
         MIN(created_at) AS first_at,
         MAX(created_at) AS last_at,
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY duration_ms
         ) FILTER (WHERE duration_ms IS NOT NULL)::text AS median_ms
       FROM uploads WHERE user_id = $1`,
      [userId],
    );
    const row = rows[0];
    return {
      firstAt: row?.first_at ? new Date(row.first_at).toISOString() : null,
      lastAt: row?.last_at ? new Date(row.last_at).toISOString() : null,
      medianDurationMs: row?.median_ms === null || row?.median_ms === undefined ? null : Math.round(Number(row.median_ms)),
    };
  },

  /**
   * Staging paths still owed to an upload that has not reached a terminal
   * status.
   *
   * The reaper treats these as live: deleting one would strand an upload that
   * is queued, retrying, or mid-pipeline.
   */
  async liveLocalSourcePaths(): Promise<string[]> {
    const { rows } = await query<{ local_source_path: string }>(
      `SELECT DISTINCT local_source_path FROM uploads
        WHERE local_source_path IS NOT NULL
          AND NOT (status = ANY($1::text[]))`,
      [TERMINAL_STATUSES as readonly string[]],
    );
    return rows.map((r) => r.local_source_path);
  },

  /**
   * Uploads left mid-flight by a worker crash. Reset on worker start so they
   * are retried rather than sitting in DOWNLOADING forever.
   */
  async resetStale(): Promise<number> {
    const { rowCount } = await query(
      `UPDATE uploads SET status = 'QUEUED'
        WHERE status IN ('DOWNLOADING','PROCESSING','ORGANIZING','JELLYFIN_SCAN')`,
    );
    return rowCount ?? 0;
  },
};

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export const mediaRepo = {
  async byId(id: number): Promise<MediaRow | null> {
    const { rows } = await query<MediaRow>('SELECT * FROM media WHERE id = $1', [id]);
    return rows[0] ?? null;
  },


  async create(
    input: Omit<MediaRow, 'id' | 'created_at' | 'updated_at'>,
    client: Queryable = pool,
  ): Promise<MediaRow> {
    const { rows } = await query<MediaRow>(
      `INSERT INTO media
         (user_id, upload_id, title, original_title, year, type, season, episode,
          episode_title, path, file_size, checksum_sha256, tmdb_id, overview,
          poster_path, jellyfin_item_id, jellyfin_verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        input.user_id,
        input.upload_id,
        input.title,
        input.original_title,
        input.year,
        input.type,
        input.season,
        input.episode,
        input.episode_title,
        input.path,
        input.file_size,
        input.checksum_sha256,
        input.tmdb_id,
        input.overview,
        input.poster_path,
        input.jellyfin_item_id,
        input.jellyfin_verified,
      ],
      client,
    );
    return rows[0]!;
  },

  /**
   * Duplicate detection.
   *
   * A match on content hash is definitive; a match on title/year (movies) or
   * show/season/episode (TV) is the practical case where the same film arrives
   * under a different release name.
   */
  async findDuplicate(input: {
    user_id: number;
    type: MediaType;
    title: string;
    year: number | null;
    season: number | null;
    episode: number | null;
    checksum: string | null;
  }): Promise<MediaRow | null> {
    if (input.checksum) {
      const { rows } = await query<MediaRow>(
        'SELECT * FROM media WHERE user_id = $1 AND checksum_sha256 = $2 LIMIT 1',
        [input.user_id, input.checksum],
      );
      if (rows[0]) return rows[0];
    }

    if (input.type === 'movie') {
      const { rows } = await query<MediaRow>(
        `SELECT * FROM media
          WHERE user_id = $1 AND type = 'movie'
            AND lower(title) = lower($2)
            AND COALESCE(year, 0) = COALESCE($3, 0)
          LIMIT 1`,
        [input.user_id, input.title, input.year],
      );
      return rows[0] ?? null;
    }

    const { rows } = await query<MediaRow>(
      `SELECT * FROM media
        WHERE user_id = $1 AND type = 'tv'
          AND lower(title) = lower($2) AND season = $3 AND episode = $4
        LIMIT 1`,
      [input.user_id, input.title, input.season, input.episode],
    );
    return rows[0] ?? null;
  },

  async byPath(path: string): Promise<MediaRow | null> {
    const { rows } = await query<MediaRow>('SELECT * FROM media WHERE path = $1', [path]);
    return rows[0] ?? null;
  },

  async setJellyfinItem(id: number, itemId: string | null, verified: boolean): Promise<void> {
    await query('UPDATE media SET jellyfin_item_id = $2, jellyfin_verified = $3 WHERE id = $1', [
      id,
      itemId,
      verified,
    ]);
  },

  async search(opts: {
    userId?: number;
    type?: MediaType;
    q?: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: Array<MediaRow & { user_name: string }>; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (opts.userId !== undefined) {
      values.push(opts.userId);
      where.push(`m.user_id = $${values.length}`);
    }
    if (opts.type) {
      values.push(opts.type);
      where.push(`m.type = $${values.length}`);
    }
    if (opts.q) {
      values.push(likeLiteral(opts.q));
      where.push(`m.title ILIKE $${values.length}`);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalRes = await query<{ count: number }>(
      `SELECT COUNT(*)::bigint AS count FROM media m ${clause}`,
      values,
    );

    values.push(opts.limit, opts.offset);
    const { rows } = await query<MediaRow & { user_name: string }>(
      `SELECT m.*, u.name AS user_name
         FROM media m JOIN users u ON u.id = m.user_id
         ${clause}
         ORDER BY m.created_at DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return { rows, total: totalRes.rows[0]?.count ?? 0 };
  },

  async counts(): Promise<{ movies: number; episodes: number; shows: number; bytes: number }> {
    const { rows } = await query<{
      movies: number;
      episodes: number;
      shows: number;
      bytes: number;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE type = 'movie')::bigint AS movies,
         COUNT(*) FILTER (WHERE type = 'tv')::bigint    AS episodes,
         COUNT(DISTINCT lower(title)) FILTER (WHERE type = 'tv')::bigint AS shows,
         COALESCE(SUM(file_size), 0)::bigint AS bytes
       FROM media`,
    );
    return rows[0] ?? { movies: 0, episodes: 0, shows: 0, bytes: 0 };
  },

  /**
   * The same shape as `counts()`, for one user.
   *
   * The user page reports what that user's library actually holds; deriving it
   * from the same expression as the global figure means the two can never tell
   * different stories about the same rows.
   */
  async countsForUser(
    userId: number,
  ): Promise<{ movies: number; episodes: number; shows: number; bytes: number }> {
    const { rows } = await query<{ movies: number; episodes: number; shows: number; bytes: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE type = 'movie')::bigint AS movies,
         COUNT(*) FILTER (WHERE type = 'tv')::bigint    AS episodes,
         COUNT(DISTINCT lower(title)) FILTER (WHERE type = 'tv')::bigint AS shows,
         COALESCE(SUM(file_size), 0)::bigint AS bytes
       FROM media WHERE user_id = $1`,
      [userId],
    );
    return rows[0] ?? { movies: 0, episodes: 0, shows: 0, bytes: 0 };
  },

  async remove(id: number): Promise<MediaRow | null> {
    const { rows } = await query<MediaRow>('DELETE FROM media WHERE id = $1 RETURNING *', [id]);
    return rows[0] ?? null;
  },

  /** The media row an upload produced, if an earlier attempt got that far. */
  async byUploadId(uploadId: number): Promise<MediaRow | null> {
    const { rows } = await query<MediaRow>(
      'SELECT * FROM media WHERE upload_id = $1 ORDER BY id DESC LIMIT 1',
      [uploadId],
    );
    return rows[0] ?? null;
  },
};

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** How far ahead drain mode parks new work: long enough never to be claimed. */
const PAUSED_DELAY_MS = 100 * 365 * 24 * 60 * 60 * 1000;

export const jobsRepo = {
  async enqueue(input: {
    type: string;
    upload_id: number | null;
    /** The parent the job serves, so it is removed along with it. */
    session_id?: number | null;
    mtproto_job_id?: number | null;
    payload?: Record<string, unknown>;
    priority?: number;
    max_attempts?: number;
    run_after?: Date;
  }, client: Queryable = pool): Promise<JobRow> {
    // Drain mode dates new work far enough ahead that `claim` never sees it.
    // The job is still recorded and still ordered normally; it simply waits.
    const runAfter =
      input.run_after ?? (config.worker.paused ? new Date(Date.now() + PAUSED_DELAY_MS) : null);

    const { rows } = await query<JobRow>(
      `INSERT INTO jobs (type, upload_id, session_id, mtproto_job_id, payload, priority, max_attempts, run_after)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,100),COALESCE($7,3),COALESCE($8, now()))
       RETURNING *`,
      [
        input.type,
        input.upload_id,
        input.session_id ?? null,
        input.mtproto_job_id ?? null,
        JSON.stringify(input.payload ?? {}),
        input.priority ?? null,
        input.max_attempts ?? null,
        runAfter,
      ],
      client,
    );
    return rows[0]!;
  },

  /**
   * Claim one runnable job.
   *
   * `FOR UPDATE SKIP LOCKED` lets several workers share the queue without
   * either blocking on the other or handing the same job to both.
   */
  /**
   * Claim the next job in a lane.
   *
   * Lanes exist because one `process-upload` can hold a slot for hours — a
   * 5 GiB fetch is a single job from the queue's point of view — so with a
   * flat concurrency limit two large uploads starve every small one behind
   * them. Splitting the pipeline into per-stage jobs would fix that more
   * completely but would mean rebuilding the part of the system least worth
   * risking, so capacity is divided by *size* instead: a large upload can
   * never occupy the slots reserved for short work.
   *
   * Size is decided by job type and, for an upload, by the file itself:
   *   - `mtproto-download` and `assemble-session` move gigabytes by
   *     definition, so they are always large;
   *   - `process-upload` is large only if its file is;
   *   - everything else is short.
   *
   * The ordering within a lane is unchanged, so `queuePosition` stays honest.
   */
  async claimForLane(
    workerId: string,
    lane: 'large' | 'small',
    largeBytes: number,
    /**
     * Scheduling cutoff, defaulting to now.
     *
     * Injectable for the same reason the reaper takes a clock: a test needs to
     * claim jobs the running worker must not touch. Parking a fixture far in
     * the future hides it from production — which uses the default — while the
     * test moves its own cutoff past it.
     */
    cutoff?: Date,
  ): Promise<JobRow | null> {
    const predicate =
      lane === 'large'
        ? `(j.type IN ('mtproto-download','assemble-session')
             OR (j.type = 'process-upload' AND COALESCE(u.file_size, 0) >= $1))`
        : `(j.type NOT IN ('mtproto-download','assemble-session')
             AND (j.type <> 'process-upload' OR COALESCE(u.file_size, 0) < $1))`;

    return withTransaction(async (client: pg.PoolClient) => {
      const { rows } = await client.query<JobRow>(
        `SELECT j.* FROM jobs j
           LEFT JOIN uploads u ON u.id = j.upload_id
          WHERE j.status = 'pending' AND j.run_after <= COALESCE($2::timestamptz, now())
            AND ${predicate}
          ORDER BY j.priority ASC, j.id ASC
          FOR UPDATE OF j SKIP LOCKED
          LIMIT 1`,
        // Only the size is a parameter here; the worker id belongs to the
        // UPDATE below, and passing it to a SELECT that does not use it leaves
        // Postgres unable to infer its type.
        [largeBytes, cutoff ?? null],
      );
      const job = rows[0];
      if (!job) return null;

      const { rows: updated } = await client.query<JobRow>(
        `UPDATE jobs
            SET status = 'active', attempts = attempts + 1,
                locked_by = $2, locked_at = now()
          WHERE id = $1
          RETURNING *`,
        [job.id, workerId],
      );
      return updated[0] ?? null;
    });
  },

  /**
   * Claim one named job, if it is still pending.
   *
   * The worker claims by lane; this exists for code that already knows which
   * job it means — tests, and recovery. The generic "next pending job"
   * claim that used to live here was removed: a test calling it against a
   * shared database once claimed a real user's queued upload and marked it
   * completed without doing the work.
   */
  async claimById(id: number, workerId: string): Promise<JobRow | null> {
    const { rows } = await query<JobRow>(
      `UPDATE jobs
          SET status = 'active', attempts = attempts + 1,
              locked_by = $2, locked_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING *`,
      [id, workerId],
    );
    return rows[0] ?? null;
  },

  async setProgress(id: number, progress: number): Promise<void> {
    await query('UPDATE jobs SET progress = $2 WHERE id = $1', [id, Math.min(100, Math.max(0, progress))]);
  },

  async complete(id: number): Promise<void> {
    await query(
      `UPDATE jobs SET status='completed', progress=100, finished_at=now(), locked_by=NULL WHERE id=$1`,
      [id],
    );
  },

  async cancel(id: number): Promise<void> {
    await query(
      `UPDATE jobs SET status='cancelled', finished_at=now(), locked_by=NULL WHERE id=$1`,
      [id],
    );
  },

  /** Fail the job, scheduling a retry when attempts remain. */
  async fail(id: number, error: string, backoffMs: number): Promise<{ willRetry: boolean }> {
    const { rows } = await query<JobRow>(
      `UPDATE jobs
          SET status = CASE WHEN attempts < max_attempts THEN 'pending' ELSE 'failed' END,
              last_error = $2,
              run_after = CASE WHEN attempts < max_attempts
                               THEN now() + ($3 || ' milliseconds')::interval
                               ELSE run_after END,
              finished_at = CASE WHEN attempts < max_attempts THEN NULL ELSE now() END,
              locked_by = NULL
        WHERE id = $1
        RETURNING *`,
      [id, error.slice(0, 2000), String(backoffMs)],
    );
    return { willRetry: rows[0]?.status === 'pending' };
  },

  /** Fail without a retry, for errors that will recur identically. */
  async failPermanently(id: number, error: string): Promise<void> {
    await query(
      `UPDATE jobs
          SET status='failed', last_error=$2, finished_at=now(), locked_by=NULL,
              attempts = GREATEST(attempts, max_attempts)
        WHERE id=$1`,
      [id, error.slice(0, 2000)],
    );
  },

  /** Requeue jobs a crashed worker left marked active. */
  /**
   * Return jobs a dead worker was holding to the queue.
   *
   * The attempt is given back as well. `claim` counts an attempt on the way in,
   * so a worker that is restarted mid-job would otherwise burn one for a job
   * that never actually failed — and a download of a multi-gigabyte file can
   * legitimately hold a slot for hours, making a restart during one likely.
   * Three deploys would have exhausted `JOB_MAX_ATTEMPTS` on a perfectly
   * healthy upload.
   */
  /**
   * How many jobs will be claimed before this one, and how many are running.
   *
   * Position is derived from the same ordering `claim` uses — `priority ASC,
   * id ASC` — so it is the real answer rather than an estimate. Jobs already
   * active are counted separately: they are not "ahead" in the queue, but they
   * are what the waiting job is waiting for.
   */
  async queuePosition(jobId: number): Promise<{ ahead: number; active: number } | null> {
    const { rows } = await query<{ ahead: string; active: string }>(
      `WITH me AS (SELECT priority, id FROM jobs WHERE id = $1)
       SELECT
         (SELECT count(*) FROM jobs, me
           WHERE jobs.status = 'pending'
             -- The claim predicate exactly: a job backing off after a failure,
             -- or parked by drain mode, is pending but not ahead of anyone.
             AND jobs.run_after <= now()
             AND (jobs.priority, jobs.id) < (me.priority, me.id)) AS ahead,
         (SELECT count(*) FROM jobs WHERE status = 'active') AS active`,
      [jobId],
    );
    const row = rows[0];
    return row ? { ahead: Number(row.ahead), active: Number(row.active) } : null;
  },

  /** Queued upload jobs with a Telegram message worth keeping current. */
  async waitingUploadJobs(limit = 50): Promise<Array<{ id: number; upload_id: number }>> {
    const { rows } = await query<{ id: number; upload_id: number }>(
      `SELECT id, upload_id FROM jobs
        WHERE status = 'pending' AND type = 'process-upload' AND upload_id IS NOT NULL
        ORDER BY priority ASC, id ASC
        LIMIT $1`,
      [limit],
    );
    return rows;
  },

  async releaseOrphans(lockedBy?: string): Promise<number> {
    // Unfiltered by default: a restarted worker gets a new id, so it is
    // reclaiming jobs held by its own previous incarnation, which it cannot
    // name. Pass `lockedBy` to release only one worker's jobs — required if
    // ever more than one worker process runs against this database, since the
    // unfiltered form would otherwise steal the other's in-flight work.
    const { rowCount } = await query(
      `UPDATE jobs
          SET status='pending', locked_by=NULL, locked_at=NULL,
              attempts = GREATEST(attempts - 1, 0)
        WHERE status='active'
          AND ($1::text IS NULL OR locked_by = $1)`,
      [lockedBy ?? null],
    );
    return rowCount ?? 0;
  },

  /**
   * Queue depth, with waiting separated from deferred.
   *
   * A `pending` job whose `run_after` is in the future is not queued: it is
   * either backing off after a failure or parked by drain mode, which sets the
   * time a century out. Counting both as "pending" made the dashboard report a
   * queue that nothing was ever going to work on.
   */
  async stats(): Promise<Record<string, number>> {
    const { rows } = await query<{ status: string; count: number }>(
      `SELECT
         CASE
           WHEN status = 'pending' AND run_after > now() THEN 'deferred'
           ELSE status
         END AS status,
         COUNT(*)::bigint AS count
       FROM jobs
       GROUP BY 1`,
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.count]));
  },

  /**
   * Queue an upload for another attempt.
   *
   * Everything the failed run left on the row — its failure detail, its
   * completion time, its last progress — is cleared, so a queued upload does
   * not read as having both a failure stage and a finish time. Row and job are
   * written together: a job without the reset, or the reset without a job,
   * is exactly the stuck state this is meant to leave.
   */
  async retryUpload(uploadId: number): Promise<JobRow> {
    return withTransaction(async (client: pg.PoolClient) => {
      await client.query(
        `UPDATE uploads
            SET status = 'QUEUED', cancel_requested = FALSE,
                error_message = NULL, error_stage = NULL, error_code = NULL,
                error_retryable = NULL, error_at = NULL,
                completed_at = NULL, duration_ms = NULL,
                progress_stage = 'QUEUED', progress_percent = NULL, progress_byte_accurate = NULL,
                progress_bytes_per_sec = NULL, progress_eta_sec = NULL,
                progress_part = NULL, progress_part_count = NULL, progress_updated_at = now(),
                bytes_downloaded = 0
          WHERE id = $1`,
        [uploadId],
      );
      return this.enqueue({ type: 'process-upload', upload_id: uploadId }, client);
    });
  },
};

// ---------------------------------------------------------------------------
// Settings and audit
// ---------------------------------------------------------------------------

export const settingsRepo = {
  async getAll(): Promise<Record<string, unknown>> {
    const { rows } = await query<{ key: string; value: unknown }>('SELECT key, value FROM settings');
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },

  async get<T>(key: string, fallback: T): Promise<T> {
    const { rows } = await query<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key]);
    return rows[0]?.value ?? fallback;
  },

  async set(key: string, value: unknown, adminId: number | null): Promise<void> {
    await query(
      `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), adminId],
    );
  },
};

export const auditRepo = {
  async log(input: {
    actor_type: 'admin' | 'system' | 'telegram';
    actor_id?: string | null;
    action: string;
    entity_type?: string | null;
    entity_id?: string | null;
    detail?: Record<string, unknown>;
    ip_address?: string | null;
  }): Promise<void> {
    await query(
      `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, detail, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [
        input.actor_type,
        input.actor_id ?? null,
        input.action,
        input.entity_type ?? null,
        input.entity_id ?? null,
        JSON.stringify(input.detail ?? {}),
        input.ip_address ?? null,
      ],
    );
  },

  async list(limit: number, offset: number): Promise<{ rows: unknown[]; total: number }> {
    return this.search({ limit, offset });
  },

  /**
   * The audit trail, filtered.
   *
   * `action` matches a prefix so that "user" selects every `user.*` event
   * without the caller needing to know the full vocabulary; the trail grows
   * new verbs over time and a UI built on an exact list goes stale silently.
   */
  async search(opts: {
    limit: number;
    offset: number;
    entityType?: string;
    entityId?: string;
    actorType?: string;
    action?: string;
    q?: string;
  }): Promise<{ rows: unknown[]; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (opts.entityType) {
      values.push(opts.entityType);
      where.push(`entity_type = $${values.length}`);
    }
    if (opts.entityId) {
      values.push(opts.entityId);
      where.push(`entity_id = $${values.length}`);
    }
    if (opts.actorType) {
      values.push(opts.actorType);
      where.push(`actor_type = $${values.length}`);
    }
    if (opts.action) {
      // LIKE on a literal prefix, with the caller's own wildcards escaped so
      // a filter string can never widen its own match.
      values.push(`${opts.action.replace(/[\\%_]/g, '\\$&')}%`);
      where.push(`action LIKE $${values.length}`);
    }
    if (opts.q) {
      values.push(likeLiteral(opts.q));
      where.push(`(action ILIKE $${values.length} OR actor_id ILIKE $${values.length} OR detail::text ILIKE $${values.length})`);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalRes = await query<{ count: number }>(
      `SELECT COUNT(*)::bigint AS count FROM audit_logs ${clause}`,
      values,
    );

    values.push(opts.limit, opts.offset);
    const { rows } = await query(
      `SELECT * FROM audit_logs ${clause} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return { rows, total: totalRes.rows[0]?.count ?? 0 };
  },

  /** Distinct actions actually present, so a filter offers only real choices. */
  async actions(): Promise<string[]> {
    const { rows } = await query<{ action: string }>(
      'SELECT DISTINCT action FROM audit_logs ORDER BY action',
    );
    return rows.map((r) => r.action);
  },
};

export const adminsRepo = {
  async byUsername(username: string): Promise<AdminRow | null> {
    const { rows } = await query<AdminRow>(
      'SELECT * FROM admins WHERE lower(username) = lower($1)',
      [username],
    );
    return rows[0] ?? null;
  },

  async byId(id: number): Promise<AdminRow | null> {
    const { rows } = await query<AdminRow>('SELECT * FROM admins WHERE id = $1', [id]);
    return rows[0] ?? null;
  },

  async count(): Promise<number> {
    const { rows } = await query<{ count: number }>('SELECT COUNT(*)::bigint AS count FROM admins');
    return rows[0]?.count ?? 0;
  },

  async create(username: string, passwordHash: string): Promise<AdminRow> {
    const { rows } = await query<AdminRow>(
      'INSERT INTO admins (username, password_hash) VALUES ($1,$2) RETURNING *',
      [username, passwordHash],
    );
    return rows[0]!;
  },

  async setPassword(id: number, passwordHash: string): Promise<void> {
    await query('UPDATE admins SET password_hash = $2 WHERE id = $1', [id, passwordHash]);
  },

  async touchLogin(id: number): Promise<void> {
    await query('UPDATE admins SET last_login_at = now() WHERE id = $1', [id]);
  },
};

// ---------------------------------------------------------------------------
// Multi-part upload sessions
// ---------------------------------------------------------------------------

export const sessionsRepo = {
  /**
   * Find the session a newly arrived part belongs to, or start one.
   *
   * Concurrent parts of the same file race here, so creation relies on the
   * partial unique index rather than a read-then-write check.
   */
  async findOrCreate(input: {
    user_id: number;
    telegram_chat_id: number;
    base_filename: string;
    safe_base_filename: string;
    extension: string;
    expected_parts: number | null;
    /** Declared total size, where the sender states one (the direct uploader does). */
    expected_bytes?: number | null;
    source?: 'telegram' | 'direct';
  }): Promise<UploadSessionRow> {
    const existing = await this.findOpen(input.user_id, input.safe_base_filename);
    if (existing) {
      // A later part may declare the total the first one did not.
      const fill: { expected_parts?: number; expected_bytes?: number } = {};
      if (existing.expected_parts === null && input.expected_parts !== null) {
        fill.expected_parts = input.expected_parts;
      }
      if (existing.expected_bytes === null && typeof input.expected_bytes === 'number') {
        fill.expected_bytes = input.expected_bytes;
      }
      if (Object.keys(fill).length > 0) {
        const updated = await this.patch(existing.id, fill);
        return updated ?? existing;
      }
      return existing;
    }

    try {
      const { rows } = await query<UploadSessionRow>(
        `INSERT INTO upload_sessions
           (user_id, telegram_chat_id, base_filename, safe_base_filename, extension,
            expected_parts, expected_bytes, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'telegram'))
         RETURNING *`,
        [
          input.user_id,
          input.telegram_chat_id,
          input.base_filename,
          input.safe_base_filename,
          input.extension,
          input.expected_parts,
          input.expected_bytes ?? null,
          input.source ?? null,
        ],
      );
      return rows[0]!;
    } catch (err) {
      // Another part created it first; use that one.
      const raced = await this.findOpen(input.user_id, input.safe_base_filename);
      if (raced) return raced;
      throw err;
    }
  },

  async findOpen(userId: number, safeBaseFilename: string): Promise<UploadSessionRow | null> {
    const { rows } = await query<UploadSessionRow>(
      `SELECT * FROM upload_sessions
        WHERE user_id = $1 AND lower(safe_base_filename) = lower($2)
          AND status IN ('COLLECTING','READY','ASSEMBLING','VERIFYING','HANDOFF')
        LIMIT 1`,
      [userId, safeBaseFilename],
    );
    return rows[0] ?? null;
  },

  async byId(id: number): Promise<UploadSessionRow | null> {
    const { rows } = await query<UploadSessionRow>('SELECT * FROM upload_sessions WHERE id = $1', [id]);
    return rows[0] ?? null;
  },

  /** Every session a user still has in flight, newest first. */
  async openForUser(userId: number): Promise<UploadSessionRow[]> {
    const { rows } = await query<UploadSessionRow>(
      `SELECT * FROM upload_sessions
        WHERE user_id = $1 AND status IN ('COLLECTING','READY','ASSEMBLING','VERIFYING','HANDOFF')
        ORDER BY created_at DESC`,
      [userId],
    );
    return rows;
  },

  async patch(
    id: number,
    patch: Partial<
      Pick<
        UploadSessionRow,
        | 'expected_parts'
        | 'expected_bytes'
        | 'received_parts'
        | 'received_bytes'
        | 'assembled_path'
        | 'assembled_size'
        | 'assembled_sha256'
        | 'upload_id'
        | 'progress_message_id'
        | 'cancel_requested'
        | 'last_part_at'
      >
    >,
    client: Queryable = pool,
  ): Promise<UploadSessionRow | null> {
    const allowed = [
      'expected_parts',
      'expected_bytes',
      'received_parts',
      'received_bytes',
      'assembled_path',
      'assembled_size',
      'assembled_sha256',
      'upload_id',
      'progress_message_id',
      'cancel_requested',
      'last_part_at',
    ] as const;

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        values.push(patch[key]);
        sets.push(`${key} = $${values.length}`);
      }
    }
    if (sets.length === 0) return this.byId(id);

    values.push(id);
    const { rows } = await query<UploadSessionRow>(
      `UPDATE upload_sessions SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
      client,
    );
    return rows[0] ?? null;
  },

  async setStatus(
    id: number,
    status: SessionStatus,
    extra: { error_message?: string | null; completed_at?: Date | null } = {},
    client: Queryable = pool,
  ): Promise<UploadSessionRow | null> {
    const { rows } = await query<UploadSessionRow>(
      `UPDATE upload_sessions
          SET status = $2,
              error_message = COALESCE($3, CASE WHEN $2 = 'FAILED' THEN error_message ELSE NULL END),
              completed_at = COALESCE($4, completed_at)
        WHERE id = $1
        RETURNING *`,
      [id, status, extra.error_message ?? null, extra.completed_at ?? null],
      client,
    );
    return rows[0] ?? null;
  },

  /**
   * Claim a session for assembly.
   *
   * The status transition is the lock: only one worker can move a session out
   * of READY, so two workers can never concatenate the same parts at once.
   */
  async claimForAssembly(id: number): Promise<UploadSessionRow | null> {
    const { rows } = await query<UploadSessionRow>(
      `UPDATE upload_sessions SET status = 'ASSEMBLING'
        WHERE id = $1 AND status = 'READY'
        RETURNING *`,
      [id],
    );
    return rows[0] ?? null;
  },

  /** Recompute the received counters from the parts actually on disk. */
  async refreshCounters(id: number): Promise<UploadSessionRow | null> {
    const { rows } = await query<UploadSessionRow>(
      `UPDATE upload_sessions s
          SET received_parts = c.n, received_bytes = c.bytes, last_part_at = now()
         FROM (
           SELECT COUNT(*)::int AS n, COALESCE(SUM(file_size), 0)::bigint AS bytes
             FROM upload_parts WHERE session_id = $1 AND status = 'READY'
         ) c
        WHERE s.id = $1
        RETURNING s.*`,
      [id],
    );
    return rows[0] ?? null;
  },

  async requestCancel(id: number): Promise<UploadSessionRow | null> {
    const { rows } = await query<UploadSessionRow>(
      `UPDATE upload_sessions SET cancel_requested = TRUE
        WHERE id = $1 AND status IN ('COLLECTING','READY','ASSEMBLING','VERIFYING','HANDOFF')
        RETURNING *`,
      [id],
    );
    if (rows[0]) {
      await query(
        `UPDATE jobs SET status='cancelled'
          WHERE status='pending' AND payload->>'sessionId' = $1`,
        [String(id)],
      );
    }
    return rows[0] ?? null;
  },

  /**
   * Sessions that have gone quiet and should be finalised or expired.
   *
   * A part still on its way counts as activity: `last_part_at` only moves when
   * a part *finishes*, and a one-gigabyte piece on a slow link — or a Telegram
   * part queued behind a long transfer — can legitimately take longer than the
   * idle limit. Expiring the session then deleted the directory under an open
   * write. A part left in flight for a day is a different problem, and not
   * one that should keep the session alive forever.
   */
  async idleSessions(idleMinutes: number): Promise<UploadSessionRow[]> {
    const { rows } = await query<UploadSessionRow>(
      `SELECT * FROM upload_sessions s
        WHERE s.status = 'COLLECTING'
          AND COALESCE(s.last_part_at, s.created_at) < now() - ($1 || ' minutes')::interval
          AND NOT EXISTS (
            SELECT 1 FROM upload_parts p
             WHERE p.session_id = s.id
               AND p.status IN ('PENDING','DOWNLOADING')
               AND p.updated_at > now() - interval '24 hours')
        ORDER BY s.id`,
      [String(idleMinutes)],
    );
    return rows;
  },

  async search(opts: {
    userId?: number;
    status?: SessionStatus;
    active?: boolean;
    q?: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: Array<UploadSessionRow & { user_name: string }>; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (opts.userId !== undefined) {
      values.push(opts.userId);
      where.push(`s.user_id = $${values.length}`);
    }
    if (opts.status) {
      values.push(opts.status);
      where.push(`s.status = $${values.length}`);
    }
    if (opts.active) {
      where.push(`s.status IN ('COLLECTING','READY','ASSEMBLING','VERIFYING','HANDOFF')`);
    }
    if (opts.q) {
      values.push(likeLiteral(opts.q));
      where.push(`s.base_filename ILIKE $${values.length}`);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalRes = await query<{ count: number }>(
      `SELECT COUNT(*)::bigint AS count FROM upload_sessions s ${clause}`,
      values,
    );

    values.push(opts.limit, opts.offset);
    const { rows } = await query<UploadSessionRow & { user_name: string }>(
      `SELECT s.*, u.name AS user_name
         FROM upload_sessions s JOIN users u ON u.id = s.user_id
         ${clause}
         ORDER BY s.created_at DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return { rows, total: totalRes.rows[0]?.count ?? 0 };
  },

  async statusCounts(): Promise<Record<string, number>> {
    const { rows } = await query<{ status: string; count: number }>(
      'SELECT status, COUNT(*)::bigint AS count FROM upload_sessions GROUP BY status',
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.count]));
  },

  /** Reset sessions a crashed worker left mid-assembly. */
  /** Assembled files an unfinished session still depends on. */
  /**
   * Classify part directories on disk against the sessions they name.
   *
   * `missing` — no row: the session is gone, so its parts are unreachable.
   * `retained` — the session failed permanently. Its parts were kept on
   *   purpose so a retry need not re-upload gigabytes, so they get a longer
   *   retention than a plain orphan rather than being removed at once.
   * Sessions still working are simply absent from the result, which is what
   *   keeps a live upload's parts safe.
   */
  async classifyForReaping(ids: number[]): Promise<Map<number, 'missing' | 'retained'>> {
    const out = new Map<number, 'missing' | 'retained'>();
    if (ids.length === 0) return out;

    const { rows } = await query<{ id: number; status: SessionStatus }>(
      'SELECT id, status FROM upload_sessions WHERE id = ANY($1::bigint[])',
      [ids],
    );
    const known = new Map(rows.map((r) => [Number(r.id), r.status]));

    for (const id of ids) {
      const status = known.get(id);
      if (status === undefined) {
        out.set(id, 'missing');
        continue;
      }
      // COLLECTING/READY/ASSEMBLING/VERIFYING/HANDOFF are all still live —
      // READY in particular is where a *retryable* failure parks, and those
      // parts must stay until the retry happens or the session expires.
      if (status === 'FAILED') out.set(id, 'retained');
      else if (status === 'COMPLETED' || status === 'CANCELLED' || status === 'EXPIRED') {
        // Cleanup normally runs inline; reaching here means it did not, so
        // treat the leftovers as an ordinary orphan.
        out.set(id, 'missing');
      }
    }
    return out;
  },

  async liveAssembledPaths(): Promise<string[]> {
    const { rows } = await query<{ assembled_path: string }>(
      `SELECT DISTINCT assembled_path FROM upload_sessions
        WHERE assembled_path IS NOT NULL
          AND status = ANY($1::text[])`,
      [ACTIVE_SESSION_STATUSES as readonly string[]],
    );
    return rows.map((r) => r.assembled_path);
  },

  /**
   * Repair sessions a crashed worker left mid-flight.
   *
   * ASSEMBLING and VERIFYING go back to READY for another assembly. HANDOFF is
   * subtler: the handoff is now one transaction, so a row can only be found in
   * it by a worker that crashed under older code — and such a row either has
   * its upload (then it merely needs its job, and to be marked done) or does
   * not (then it is assembled again). Left alone, a HANDOFF row blocked its
   * filename, kept its parts and its assembled file forever, and showed as
   * active with no way to retry.
   */
  async resetStale(): Promise<number> {
    let total = 0;
    const ensured = await query(
      `INSERT INTO jobs (type, upload_id, payload, priority, max_attempts)
       SELECT 'process-upload', s.upload_id, '{}', 100, $1
         FROM upload_sessions s
        WHERE s.status = 'HANDOFF' AND s.upload_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.upload_id = s.upload_id)`,
      [config.worker.maxAttempts],
    );
    total += ensured.rowCount ?? 0;
    const finished = await query(
      `UPDATE upload_sessions
          SET status = 'COMPLETED', completed_at = COALESCE(completed_at, now())
        WHERE status = 'HANDOFF' AND upload_id IS NOT NULL`,
    );
    total += finished.rowCount ?? 0;
    const { rowCount } = await query(
      `UPDATE upload_sessions SET status = 'READY'
        WHERE status IN ('ASSEMBLING','VERIFYING','HANDOFF')`,
    );
    return total + (rowCount ?? 0);
  },
};

export const partsRepo = {
  /**
   * Record an arriving part.
   *
   * A repeated part number is not a second part: an identical resend is
   * ignored, and a genuinely different file replaces the earlier one so a
   * sender can correct a bad piece without restarting the session.
   */
  async upsert(input: {
    session_id: number;
    part_number: number;
    original_filename: string;
    telegram_file_id: string | null;
    telegram_file_unique_id: string | null;
    telegram_message_id: number | null;
    file_size: number;
  }): Promise<{ part: UploadPartRow; outcome: 'created' | 'duplicate' | 'replaced' }> {
    const existing = await this.byNumber(input.session_id, input.part_number);

    if (existing) {
      const sameFile =
        existing.telegram_file_unique_id !== null &&
        existing.telegram_file_unique_id === input.telegram_file_unique_id;

      if (sameFile && existing.status !== 'FAILED') {
        return { part: existing, outcome: 'duplicate' };
      }

      const { rows } = await query<UploadPartRow>(
        `UPDATE upload_parts
            SET original_filename = $2, telegram_file_id = $3, telegram_file_unique_id = $4,
                telegram_message_id = $5, file_size = $6, bytes_downloaded = 0,
                stored_path = NULL, checksum_sha256 = NULL, status = 'PENDING',
                error_message = NULL, completed_at = NULL
          WHERE id = $1
          RETURNING *`,
        [
          existing.id,
          input.original_filename,
          input.telegram_file_id,
          input.telegram_file_unique_id,
          input.telegram_message_id,
          input.file_size,
        ],
      );
      return { part: rows[0]!, outcome: 'replaced' };
    }

    try {
      const { rows } = await query<UploadPartRow>(
        `INSERT INTO upload_parts
           (session_id, part_number, original_filename, telegram_file_id,
            telegram_file_unique_id, telegram_message_id, file_size)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          input.session_id,
          input.part_number,
          input.original_filename,
          input.telegram_file_id,
          input.telegram_file_unique_id,
          input.telegram_message_id,
          input.file_size,
        ],
      );
      return { part: rows[0]!, outcome: 'created' };
    } catch (err) {
      // Two requests for the same part number raced between the read above
      // and this insert; the unique index caught it. The row now exists, so
      // the update branch applies — the same shape as `sessionsRepo.findOrCreate`.
      if ((err as { code?: string }).code === '23505' && (await this.byNumber(input.session_id, input.part_number))) {
        return this.upsert(input);
      }
      throw err;
    }
  },

  async byId(id: number): Promise<UploadPartRow | null> {
    const { rows } = await query<UploadPartRow>('SELECT * FROM upload_parts WHERE id = $1', [id]);
    return rows[0] ?? null;
  },

  async byNumber(sessionId: number, partNumber: number): Promise<UploadPartRow | null> {
    const { rows } = await query<UploadPartRow>(
      'SELECT * FROM upload_parts WHERE session_id = $1 AND part_number = $2',
      [sessionId, partNumber],
    );
    return rows[0] ?? null;
  },

  /** Parts in concatenation order. */
  async listForSession(sessionId: number): Promise<UploadPartRow[]> {
    const { rows } = await query<UploadPartRow>(
      'SELECT * FROM upload_parts WHERE session_id = $1 ORDER BY part_number ASC',
      [sessionId],
    );
    return rows;
  },

  async readyNumbers(sessionId: number): Promise<number[]> {
    const { rows } = await query<{ part_number: number }>(
      `SELECT part_number FROM upload_parts
        WHERE session_id = $1 AND status = 'READY' ORDER BY part_number`,
      [sessionId],
    );
    return rows.map((r) => r.part_number);
  },

  async setStatus(
    id: number,
    status: PartStatus,
    extra: {
      stored_path?: string | null;
      checksum_sha256?: string | null;
      file_size?: number | null;
      error_message?: string | null;
      completed_at?: Date | null;
    } = {},
  ): Promise<UploadPartRow | null> {
    const { rows } = await query<UploadPartRow>(
      `UPDATE upload_parts
          SET status = $2,
              stored_path = COALESCE($3, stored_path),
              checksum_sha256 = COALESCE($4, checksum_sha256),
              file_size = COALESCE($5, file_size),
              error_message = CASE WHEN $2 = 'FAILED' THEN $6 ELSE NULL END,
              completed_at = COALESCE($7, completed_at)
        WHERE id = $1
        RETURNING *`,
      [
        id,
        status,
        extra.stored_path ?? null,
        extra.checksum_sha256 ?? null,
        extra.file_size ?? null,
        extra.error_message ?? null,
        extra.completed_at ?? null,
      ],
    );
    return rows[0] ?? null;
  },

  async setProgress(id: number, bytes: number): Promise<void> {
    await query('UPDATE upload_parts SET bytes_downloaded = $2 WHERE id = $1', [id, bytes]);
  },

  async failedCount(sessionId: number): Promise<number> {
    const { rows } = await query<{ count: number }>(
      `SELECT COUNT(*)::bigint AS count FROM upload_parts WHERE session_id = $1 AND status = 'FAILED'`,
      [sessionId],
    );
    return rows[0]?.count ?? 0;
  },

  /** Requeue every failed part of a session. */
  async resetFailed(sessionId: number): Promise<UploadPartRow[]> {
    const { rows } = await query<UploadPartRow>(
      `UPDATE upload_parts SET status = 'PENDING', error_message = NULL, bytes_downloaded = 0
        WHERE session_id = $1 AND status = 'FAILED'
        RETURNING *`,
      [sessionId],
    );
    return rows;
  },

  async resetStale(): Promise<number> {
    const { rowCount } = await query(
      `UPDATE upload_parts SET status = 'PENDING' WHERE status = 'DOWNLOADING'`,
    );
    return rowCount ?? 0;
  },
};

// ---------------------------------------------------------------------------
// Uploader tokens
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';

/**
 * Credentials for the local uploader client.
 *
 * The token is shown once at creation and never again: only its SHA-256 is
 * stored, and lookup is by that hash, so the database holds nothing that can
 * be replayed.
 */
export const uploadTokensRepo = {
  hash(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  },

  /** Mint a new token for a user, replacing any previous one. */
  async issue(userId: number): Promise<string> {
    const token = `jellygram_${crypto.randomBytes(32).toString('base64url')}`;
    await query(
      `UPDATE users
          SET upload_token_hash = $2, upload_token_created_at = now(),
              upload_token_last_used_at = NULL
        WHERE id = $1`,
      [userId, this.hash(token)],
    );
    return token;
  },

  async revoke(userId: number): Promise<void> {
    await query(
      `UPDATE users
          SET upload_token_hash = NULL, upload_token_created_at = NULL,
              upload_token_last_used_at = NULL
        WHERE id = $1`,
      [userId],
    );
  },

  /** Resolve a presented token to its user, or null. */
  async authenticate(token: string): Promise<UserRow | null> {
    if (!token || token.length < 16) return null;
    const { rows } = await query<UserRow>(
      'SELECT * FROM users WHERE upload_token_hash = $1',
      [this.hash(token)],
    );
    const user = rows[0];
    if (!user) return null;

    // Best-effort last-used stamp; never block an upload on it.
    void query('UPDATE users SET upload_token_last_used_at = now() WHERE id = $1', [user.id]).catch(
      () => {},
    );
    return user;
  },
};

// ---------------------------------------------------------------------------
// MTProto ingestion jobs
// ---------------------------------------------------------------------------

export const mtprotoJobsRepo = {
  async create(input: {
    user_id: number;
    telegram_chat_id: number;
    bot_message_id: number | null;
    progress_message_id: number | null;
    origin_kind: ForwardOriginKind;
    origin_chat: string | null;
    origin_message_id: number | null;
    origin_title: string | null;
    file_name: string;
    file_size: number;
    mime_type: string | null;
    telegram_file_unique_id: string | null;
    caption: string | null;
  }): Promise<MtprotoJobRow> {
    const { rows } = await query<MtprotoJobRow>(
      `INSERT INTO mtproto_jobs
         (user_id, telegram_chat_id, bot_message_id, progress_message_id,
          origin_kind, origin_chat, origin_message_id, origin_title,
          file_name, file_size, mime_type, telegram_file_unique_id, caption)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        input.user_id,
        input.telegram_chat_id,
        input.bot_message_id,
        input.progress_message_id,
        input.origin_kind,
        input.origin_chat,
        input.origin_message_id,
        input.origin_title,
        input.file_name,
        input.file_size,
        input.mime_type,
        input.telegram_file_unique_id,
        input.caption,
      ],
    );
    return rows[0]!;
  },

  async byId(id: number): Promise<MtprotoJobRow | null> {
    const { rows } = await query<MtprotoJobRow>('SELECT * FROM mtproto_jobs WHERE id = $1', [id]);
    return rows[0] ?? null;
  },

  /** The in-flight job for a forwarded message, if the bot already saw it. */
  async activeForMessage(userId: number, botMessageId: number): Promise<MtprotoJobRow | null> {
    const { rows } = await query<MtprotoJobRow>(
      `SELECT * FROM mtproto_jobs
        WHERE user_id = $1 AND bot_message_id = $2
          AND status IN ('PENDING','LOCATING','DOWNLOADING','VERIFYING','HANDOFF')
        LIMIT 1`,
      [userId, botMessageId],
    );
    return rows[0] ?? null;
  },

  async setStatus(
    id: number,
    status: MtprotoStatus,
    extra: {
      error_message?: string | null;
      started_at?: Date | null;
      completed_at?: Date | null;
    } = {},
    client: Queryable = pool,
  ): Promise<MtprotoJobRow | null> {
    const { rows } = await query<MtprotoJobRow>(
      `UPDATE mtproto_jobs
          SET status = $2,
              error_message = COALESCE($3, CASE WHEN $2 IN ('FAILED','UNAVAILABLE') THEN error_message ELSE NULL END),
              started_at = COALESCE($4, started_at),
              completed_at = COALESCE($5, completed_at)
        WHERE id = $1
        RETURNING *`,
      [id, status, extra.error_message ?? null, extra.started_at ?? null, extra.completed_at ?? null],
      client,
    );
    return rows[0] ?? null;
  },

  async patch(
    id: number,
    patch: Partial<
      Pick<
        MtprotoJobRow,
        | 'progress_message_id'
        | 'bytes_downloaded'
        | 'speed_bps'
        | 'sha256'
        | 'temp_path'
        | 'upload_id'
        | 'cancel_requested'
        | 'file_size'
        | 'attempts'
      >
    >,
    client: Queryable = pool,
  ): Promise<MtprotoJobRow | null> {
    const allowed = [
      'progress_message_id',
      'bytes_downloaded',
      'speed_bps',
      'sha256',
      'temp_path',
      'upload_id',
      'cancel_requested',
      'file_size',
      // Reset by a manual retry, so it starts with a full budget of attempts.
      'attempts',
    ] as const;

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        values.push(patch[key]);
        sets.push(`${key} = $${values.length}`);
      }
    }
    if (sets.length === 0) return this.byId(id);

    values.push(id);
    const { rows } = await query<MtprotoJobRow>(
      `UPDATE mtproto_jobs SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
      client,
    );
    return rows[0] ?? null;
  },

  /** Progress is written often; keep it to one cheap statement. */
  async setProgress(id: number, bytes: number, speedBps: number): Promise<void> {
    await query('UPDATE mtproto_jobs SET bytes_downloaded = $2, speed_bps = $3 WHERE id = $1', [
      id,
      bytes,
      Math.round(speedBps),
    ]);
  },

  /**
   * Claim a job for one worker.
   *
   * The status transition is the lock: only one caller can move a job out of
   * PENDING, so two queue entries pointing at the same job cannot both start
   * downloading it. Mirrors `sessionsRepo.claimForAssembly`.
   */
  async claimForDownload(id: number): Promise<MtprotoJobRow | null> {
    const { rows } = await query<MtprotoJobRow>(
      `UPDATE mtproto_jobs
          SET status = 'LOCATING', started_at = now(), attempts = attempts + 1
        WHERE id = $1 AND status = 'PENDING'
        RETURNING *`,
      [id],
    );
    return rows[0] ?? null;
  },

  async incrementAttempts(id: number): Promise<number> {
    const { rows } = await query<{ attempts: number }>(
      'UPDATE mtproto_jobs SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts',
      [id],
    );
    return rows[0]?.attempts ?? 0;
  },

  async requestCancel(id: number): Promise<MtprotoJobRow | null> {
    const { rows } = await query<MtprotoJobRow>(
      `UPDATE mtproto_jobs SET cancel_requested = TRUE
        WHERE id = $1 AND status IN ('PENDING','LOCATING','DOWNLOADING','VERIFYING','HANDOFF')
        RETURNING *`,
      [id],
    );
    if (rows[0]) {
      await query(`UPDATE jobs SET status='cancelled' WHERE status='pending' AND payload->>'mtprotoJobId' = $1`, [
        String(id),
      ]);
    }
    return rows[0] ?? null;
  },

  async isCancelRequested(id: number): Promise<boolean> {
    const { rows } = await query<{ cancel_requested: boolean }>(
      'SELECT cancel_requested FROM mtproto_jobs WHERE id = $1',
      [id],
    );
    return rows[0]?.cancel_requested ?? false;
  },

  async search(opts: {
    userId?: number;
    status?: MtprotoStatus;
    active?: boolean;
    q?: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: Array<MtprotoJobRow & { user_name: string }>; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (opts.userId !== undefined) {
      values.push(opts.userId);
      where.push(`j.user_id = $${values.length}`);
    }
    if (opts.status) {
      values.push(opts.status);
      where.push(`j.status = $${values.length}`);
    }
    if (opts.active) {
      where.push(`j.status IN ('PENDING','LOCATING','DOWNLOADING','VERIFYING','HANDOFF')`);
    }
    if (opts.q) {
      values.push(likeLiteral(opts.q));
      where.push(`j.file_name ILIKE $${values.length}`);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalRes = await query<{ count: number }>(
      `SELECT COUNT(*)::bigint AS count FROM mtproto_jobs j ${clause}`,
      values,
    );

    values.push(opts.limit, opts.offset);
    const { rows } = await query<MtprotoJobRow & { user_name: string }>(
      `SELECT j.*, u.name AS user_name
         FROM mtproto_jobs j JOIN users u ON u.id = j.user_id
         ${clause}
         ORDER BY j.created_at DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return { rows, total: totalRes.rows[0]?.count ?? 0 };
  },

  async statusCounts(): Promise<Record<string, number>> {
    const { rows } = await query<{ status: string; count: number }>(
      'SELECT status, COUNT(*)::bigint AS count FROM mtproto_jobs GROUP BY status',
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.count]));
  },

  /** Temp files an unfinished MTProto job still depends on. */
  async liveTempPaths(): Promise<string[]> {
    const { rows } = await query<{ temp_path: string }>(
      `SELECT DISTINCT temp_path FROM mtproto_jobs
        WHERE temp_path IS NOT NULL
          AND status = ANY($1::text[])`,
      [ACTIVE_MTPROTO_STATUSES as readonly string[]],
    );
    return rows.map((r) => r.temp_path);
  },

  /**
   * Reset jobs a crashed worker left mid-flight.
   *
   * The attempt the claim counted is given back, as `jobsRepo.releaseOrphans`
   * does for the queue row: a restart during a multi-hour download is not a
   * failed attempt, and with three attempts and frequent deploys the counter
   * used to run out on a perfectly healthy fetch. A HANDOFF row that already
   * has its upload only needs its job and to be marked done.
   */
  async resetStale(): Promise<number> {
    let total = 0;
    const ensured = await query(
      `INSERT INTO jobs (type, upload_id, payload, priority, max_attempts)
       SELECT 'process-upload', m.upload_id, '{}', 100, $1
         FROM mtproto_jobs m
        WHERE m.status = 'HANDOFF' AND m.upload_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.upload_id = m.upload_id)`,
      [config.worker.maxAttempts],
    );
    total += ensured.rowCount ?? 0;
    const finished = await query(
      `UPDATE mtproto_jobs
          SET status = 'COMPLETED', completed_at = COALESCE(completed_at, now())
        WHERE status = 'HANDOFF' AND upload_id IS NOT NULL`,
    );
    total += finished.rowCount ?? 0;
    const { rowCount } = await query(
      `UPDATE mtproto_jobs
          SET status = 'PENDING', bytes_downloaded = 0, attempts = GREATEST(attempts - 1, 0)
        WHERE status IN ('LOCATING','DOWNLOADING','VERIFYING','HANDOFF')`,
    );
    return total + (rowCount ?? 0);
  },
};
