// Mirrors backend/internal/models. Keep in sync.

export type EventStatus = "active" | "closed";

export type RequestStatus =
  | "pending"
  | "accepted"
  | "singing"
  | "done"
  | "skipped"
  | "rejected";

export interface KaraokeEvent {
  id: string;
  code: string;
  venue_name: string;
  name: string;
  status: EventStatus;
  accepting_requests: boolean;
  auto_accept: boolean;
  per_singer_limit: number;
  host_token?: string;
  starts_at?: string;
  ends_at?: string;
  created_at: string;
}

export interface KaraokeRequest {
  id: string;
  event_id: string;
  singer_name: string;
  youtube_url: string;
  youtube_video_id?: string;
  song_title?: string;
  song_id?: string;            // set when resolved to a library song
  notes?: string;
  status: RequestStatus;
  rotation_index: number;
  manual_order: number;
  is_duplicate?: boolean;
  guest_id?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateRequestResponse {
  request: KaraokeRequest;
  position: number;
}

// =========================================================================
// Library
// =========================================================================

export type SongStatus = "pending" | "ready" | "failed";

export interface Media {
  id: string;
  song_id: string;
  source_url: string;
  source_video_id?: string;
  instrumental_path: string;
  lyrics_path: string;
  thumb_path?: string;
  bytes: number;
  created_at: string;
}

export interface Song {
  id: string;
  title: string;
  artist: string;
  year?: number;
  duration_sec: number;
  canonical_hash: string;
  primary_media_id?: string;
  status: SongStatus;
  created_at: string;
  updated_at: string;
  primary_media?: Media;
}

// =========================================================================
// Jobs + bulk imports
// =========================================================================

export type JobStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "canceled"
  | "paused";

export type JobStage = "download" | "separate" | "transcribe" | "render";

export interface Job {
  id: string;
  song_id?: string;
  youtube_url: string;
  title_hint?: string;
  artist_hint?: string;
  year_hint?: number;
  priority: number;
  status: JobStatus;
  stage?: JobStage;
  progress: number;            // 0..1
  error?: string;
  attempts: number;
  batch_id?: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
}

export interface ImportBatch {
  id: string;
  kind: string;                // 'musicbrainz' | 'wikipedia' | 'spotify' | etc.
  query: string;
  total: number;
  completed: number;
  failed: number;
  notify_email?: string;
  notify_slack?: string;
  created_at: string;
  finished_at?: string;
}

// =========================================================================
// Admin + settings
// =========================================================================

export interface AdminUser {
  id: string;
  username: string;
  must_change_password: boolean;
  created_at: string;
  updated_at: string;
}

export interface AppSettings {
  vps_host: string;
  vps_user: string;
  vps_path: string;
  vps_ssh_key_set: boolean;
  vps_rsync_opts: string;
  notify_email: string;
  notify_slack_set: boolean;
  auto_enqueue_on_fallback: boolean;
  worker_concurrency: number;
  player_lyrics_style?: LyricsStyle;
}

// =========================================================================
// Lyrics
// =========================================================================

export interface LyricsWord {
  word: string;
  start: number;        // seconds
  end: number;
  score?: number;
}

export interface LyricsSegment {
  start: number;
  end: number;
  text: string;
  words: LyricsWord[];
}

export interface LyricsDoc {
  language: string;
  duration: number;
  segments: LyricsSegment[];
}

export type LyricsPresetName =
  | "neon"
  | "classic"
  | "concert"
  | "vaporwave"
  | "minimal"
  | "custom";

export interface LyricsStyle {
  preset: LyricsPresetName;
  fontFamily: string;
  fontSize: number;            // px at 1080p; player scales for phone
  fontWeight: number;
  fontStyle: "normal" | "italic";
  textColor: string;
  activeColor: string;
  upcomingColor: string;
  uppercase: boolean;
  letterSpacing: number;
  textAlign: "left" | "center" | "right";
  shadowEnabled: boolean;
  shadowColor: "auto" | string;
  shadowOpacity: number;
  shadowBlur: number;
  bgPanelEnabled: boolean;
  bgPanelOpacity: number;
}

// =========================================================================
// Playback wire shapes
// =========================================================================

export interface PlaybackState {
  song_id: string;
  request_id?: string;
  current_time: number;
  paused: boolean;
  rate: number;
  server_ts: number;            // ms since unix epoch; server-stamped
}

// =========================================================================
// WebSocket envelope (all message types the client may receive)
// =========================================================================

export type WSEvent =
  | { type: "snapshot"; payload: { event: KaraokeEvent; requests: KaraokeRequest[] } }
  | { type: "request:created"; payload: KaraokeRequest }
  | { type: "request:updated"; payload: KaraokeRequest }
  | { type: "request:deleted"; payload: { id: string } }
  | { type: "event:updated"; payload: KaraokeEvent }
  | { type: "playback:state"; payload: PlaybackState }
  | { type: "playback:load"; payload: { request_id?: string; song_id?: string } }
  | { type: "job:updated"; payload: Job };
