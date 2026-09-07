export type MediaType = 'movie' | 'tv';
export type DetectedMediaType = MediaType | 'unknown';

/** Lifecycle of an upload, mirrored in the dashboard and in Telegram. */
export const UPLOAD_STATUSES = [
  'RECEIVED',
  'QUEUED',
  'DOWNLOADING',
  'PROCESSING',
  'ORGANIZING',
  'JELLYFIN_SCAN',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'DUPLICATE',
  /** Identification confidence was too low to guess; a human must decide. */
  'NEEDS_REVIEW',
] as const;

export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

/** Statuses after which no further work happens. */
export const TERMINAL_STATUSES: readonly UploadStatus[] = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'DUPLICATE',
  // Terminal for the pipeline: no further automatic work will happen, because
  // the next step is a decision only a person can make.
  'NEEDS_REVIEW',
];

export interface UserRow {
  id: number;
  name: string;
  telegram_chat_id: number;
  jellyfin_username: string;
  jellyfin_user_id: string | null;
  storage_slug: string;
  active: boolean;
  upload_enabled: boolean;
  quota_bytes: number | null;
  notes: string | null;
  upload_token_hash: string | null;
  upload_token_created_at: Date | null;
  upload_token_last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface UploadRow {
  id: number;
  user_id: number;
  telegram_chat_id: number;
  telegram_message_id: number | null;
  progress_message_id: number | null;
  telegram_file_id: string | null;
  telegram_file_unique_id: string | null;
  original_filename: string;
  safe_filename: string;
  extension: string;
  mime_type: string | null;
  stored_path: string | null;
  file_size: number;
  bytes_downloaded: number;
  checksum_sha256: string | null;
  media_type: DetectedMediaType | null;
  detected_title: string | null;
  detected_year: number | null;
  detected_season: number | null;
  detected_episode: number | null;
  status: UploadStatus;
  error_message: string | null;
  cancel_requested: boolean;
  duration_ms: number | null;
  /** Set when the bytes are already on disk (an assembled multi-part upload). */
  local_source_path: string | null;
  /** Live progress for the dashboard; meaningless once terminal. */
  progress_stage: string | null;
  progress_percent: number | null;
  progress_byte_accurate: boolean | null;
  progress_bytes_per_sec: number | null;
  progress_eta_sec: number | null;
  progress_part: number | null;
  progress_part_count: number | null;
  progress_updated_at: Date | null;
  /** Which pipeline stage was active when the upload failed. */
  error_stage: string | null;
  /** Machine-readable cause, e.g. an errno or an error class name. */
  error_code: string | null;
  error_retryable: boolean | null;
  error_at: Date | null;
  attempts: number;
  session_id: number | null;
  source: 'telegram' | 'direct' | 'mtproto';
  mtproto_job_id: number | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface MediaRow {
  id: number;
  user_id: number;
  upload_id: number | null;
  title: string;
  original_title: string | null;
  year: number | null;
  type: MediaType;
  season: number | null;
  episode: number | null;
  episode_title: string | null;
  path: string;
  file_size: number;
  checksum_sha256: string | null;
  tmdb_id: number | null;
  overview: string | null;
  poster_path: string | null;
  jellyfin_item_id: string | null;
  jellyfin_verified: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface JobRow {
  id: number;
  type: string;
  upload_id: number | null;
  /** The multi-part session this job serves, where it serves one; cascades with it. */
  session_id: number | null;
  /** The MTProto fetch this job performs, where it performs one; cascades with it. */
  mtproto_job_id: number | null;
  payload: Record<string, unknown>;
  status: 'pending' | 'active' | 'completed' | 'failed' | 'cancelled';
  priority: number;
  attempts: number;
  max_attempts: number;
  progress: number;
  last_error: string | null;
  locked_by: string | null;
  locked_at: Date | null;
  run_after: Date;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

export interface UserLibraryRow {
  id: number;
  user_id: number;
  media_type: MediaType;
  library_name: string;
  library_path: string;
  jellyfin_item_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AdminRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

/** Lifecycle of a multi-part upload session. */
export const SESSION_STATUSES = [
  'COLLECTING',
  'READY',
  'ASSEMBLING',
  'VERIFYING',
  'HANDOFF',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Statuses in which a session is still accepting or processing work. */
export const ACTIVE_SESSION_STATUSES: readonly SessionStatus[] = [
  'COLLECTING',
  'READY',
  'ASSEMBLING',
  'VERIFYING',
  'HANDOFF',
];

export const PART_STATUSES = ['PENDING', 'DOWNLOADING', 'READY', 'FAILED'] as const;
export type PartStatus = (typeof PART_STATUSES)[number];

export interface UploadSessionRow {
  id: number;
  user_id: number;
  telegram_chat_id: number;
  base_filename: string;
  safe_base_filename: string;
  extension: string;
  expected_parts: number | null;
  /** The size the sender declared at /begin; null for Telegram-fed sessions. */
  expected_bytes: number | null;
  received_parts: number;
  received_bytes: number;
  assembled_path: string | null;
  assembled_size: number | null;
  assembled_sha256: string | null;
  upload_id: number | null;
  progress_message_id: number | null;
  status: SessionStatus;
  source: 'telegram' | 'direct';
  error_message: string | null;
  cancel_requested: boolean;
  created_at: Date;
  updated_at: Date;
  last_part_at: Date | null;
  completed_at: Date | null;
}

export interface UploadPartRow {
  id: number;
  session_id: number;
  part_number: number;
  original_filename: string;
  telegram_file_id: string | null;
  telegram_file_unique_id: string | null;
  telegram_message_id: number | null;
  file_size: number;
  bytes_downloaded: number;
  stored_path: string | null;
  checksum_sha256: string | null;
  status: PartStatus;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

/** Lifecycle of an MTProto ingestion job. */
export const MTPROTO_STATUSES = [
  'PENDING',
  'LOCATING',
  'DOWNLOADING',
  'VERIFYING',
  'HANDOFF',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'UNAVAILABLE',
] as const;

export type MtprotoStatus = (typeof MTPROTO_STATUSES)[number];

export const ACTIVE_MTPROTO_STATUSES: readonly MtprotoStatus[] = [
  'PENDING',
  'LOCATING',
  'DOWNLOADING',
  'VERIFYING',
  'HANDOFF',
];

export type ForwardOriginKind = 'channel' | 'user' | 'chat' | 'hidden' | 'unknown';

export interface MtprotoJobRow {
  id: number;
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
  status: MtprotoStatus;
  bytes_downloaded: number;
  speed_bps: number | null;
  sha256: string | null;
  temp_path: string | null;
  upload_id: number | null;
  attempts: number;
  error_message: string | null;
  cancel_requested: boolean;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}
