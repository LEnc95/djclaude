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

export type WSEvent =
  | { type: "snapshot"; payload: { event: KaraokeEvent; requests: KaraokeRequest[] } }
  | { type: "request:created"; payload: KaraokeRequest }
  | { type: "request:updated"; payload: KaraokeRequest }
  | { type: "request:deleted"; payload: { id: string } }
  | { type: "event:updated"; payload: KaraokeEvent };
