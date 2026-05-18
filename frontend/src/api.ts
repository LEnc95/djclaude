import type {
  AdminUser,
  AppSettings,
  CreateRequestResponse,
  ImportBatch,
  Job,
  JobStatus,
  KaraokeEvent,
  KaraokeRequest,
  LyricsStyle,
  PlaybackState,
  RequestStatus,
  Song,
  SongStatus,
} from "./types";
import { apiURL } from "./config";

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface RequestOpts extends RequestInit {
  hostToken?: string;
  adminToken?: string;
}

async function request<T>(path: string, init: RequestOpts = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (init.hostToken) headers.set("X-Host-Token", init.hostToken);
  if (init.adminToken) headers.set("X-Admin-Token", init.adminToken);
  const res = await fetch(apiURL(path), { ...init, headers });
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("Content-Type") ?? "";
  const body = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = typeof body === "object" && body && "error" in body ? body.error : String(body);
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

export const api = {
  // ---- events ----
  createEvent(input: {
    name: string;
    venue_name?: string;
    per_singer_limit?: number;
    auto_accept?: boolean;
  }): Promise<KaraokeEvent> {
    return request<KaraokeEvent>("/api/events", { method: "POST", body: JSON.stringify(input) });
  },
  getEvent(code: string, hostToken?: string): Promise<KaraokeEvent> {
    return request<KaraokeEvent>(`/api/events/${encodeURIComponent(code)}`, { hostToken });
  },
  updateEvent(
    code: string,
    patch: Partial<Pick<KaraokeEvent, "status" | "accepting_requests" | "auto_accept" | "per_singer_limit" | "name" | "venue_name">>,
    hostToken: string,
  ): Promise<KaraokeEvent> {
    return request<KaraokeEvent>(`/api/events/${encodeURIComponent(code)}`, {
      method: "PATCH", body: JSON.stringify(patch), hostToken,
    });
  },

  // ---- requests ----
  listRequests(
    code: string,
    opts: { statuses?: RequestStatus[]; hostToken?: string } = {},
  ): Promise<KaraokeRequest[]> {
    const qs = opts.statuses?.length ? `?status=${opts.statuses.join(",")}` : "";
    return request<KaraokeRequest[]>(`/api/events/${encodeURIComponent(code)}/requests${qs}`, {
      hostToken: opts.hostToken,
    });
  },
  createRequest(
    code: string,
    input: { singer_name: string; song_input: string; notes?: string; song_title?: string },
  ): Promise<CreateRequestResponse> {
    return request<CreateRequestResponse>(`/api/events/${encodeURIComponent(code)}/requests`, {
      method: "POST", body: JSON.stringify(input),
    });
  },
  updateRequest(
    code: string,
    id: string,
    patch: Partial<Pick<KaraokeRequest, "status" | "singer_name" | "youtube_url" | "song_title" | "notes" | "manual_order">>,
    hostToken: string,
  ): Promise<KaraokeRequest> {
    return request<KaraokeRequest>(`/api/events/${encodeURIComponent(code)}/requests/${id}`, {
      method: "PATCH", body: JSON.stringify(patch), hostToken,
    });
  },
  deleteRequest(code: string, id: string, hostToken: string): Promise<void> {
    return request<void>(`/api/events/${encodeURIComponent(code)}/requests/${id}`, {
      method: "DELETE", hostToken,
    });
  },

  // ---- playback (HTTP fallback to WS) ----
  postPlayback(code: string, state: PlaybackState, hostToken: string): Promise<void> {
    return request<void>(`/api/events/${encodeURIComponent(code)}/playback`, {
      method: "POST", body: JSON.stringify(state), hostToken,
    });
  },

  // ---- library ----
  listLibrary(
    params: { q?: string; artist?: string; year?: number; status?: SongStatus; limit?: number } = {},
  ): Promise<Song[]> {
    const u = new URLSearchParams();
    if (params.q) u.set("q", params.q);
    if (params.artist) u.set("artist", params.artist);
    if (params.year !== undefined) u.set("year", String(params.year));
    if (params.status) u.set("status", params.status);
    if (params.limit !== undefined) u.set("limit", String(params.limit));
    const qs = u.toString();
    return request<Song[]>(`/api/library/songs${qs ? `?${qs}` : ""}`);
  },
  getLibrarySong(id: string): Promise<Song> {
    return request<Song>(`/api/library/songs/${encodeURIComponent(id)}`);
  },
  deleteLibrarySong(id: string, adminToken: string): Promise<void> {
    return request<void>(`/api/library/songs/${encodeURIComponent(id)}`, {
      method: "DELETE", adminToken,
    });
  },
  searchLibrary(q: string): Promise<{ songs: Song[]; no_match: boolean }> {
    return request("/api/library/search", { method: "POST", body: JSON.stringify({ q }) });
  },

  // ---- jobs (admin) ----
  listJobs(
    params: { status?: JobStatus[]; batch_id?: string; limit?: number } = {},
    adminToken: string,
  ): Promise<Job[]> {
    const u = new URLSearchParams();
    if (params.status?.length) u.set("status", params.status.join(","));
    if (params.batch_id) u.set("batch_id", params.batch_id);
    if (params.limit) u.set("limit", String(params.limit));
    const qs = u.toString();
    return request<Job[]>(`/api/jobs${qs ? `?${qs}` : ""}`, { adminToken });
  },
  createJob(
    input: { youtube_url: string; title?: string; artist?: string; year?: number; priority?: number; batch_id?: string },
    adminToken: string,
  ): Promise<Job | { already_processed: true; song_id: string; media_id: string }> {
    return request("/api/jobs", { method: "POST", body: JSON.stringify(input), adminToken });
  },
  cancelJob(id: string, adminToken: string): Promise<void> {
    return request(`/api/jobs/${id}`, { method: "DELETE", adminToken });
  },
  retryJob(id: string, adminToken: string): Promise<Job> {
    return request(`/api/jobs/${id}/retry`, { method: "POST", adminToken });
  },
  setJobPriority(id: string, priority: number, adminToken: string): Promise<void> {
    return request(`/api/jobs/${id}/priority`, {
      method: "POST", body: JSON.stringify({ priority }), adminToken,
    });
  },

  // ---- imports (admin) ----
  importArtist(input: { query: string; limit?: number; priority?: number }, adminToken: string) {
    return request<{ batch: ImportBatch; queued: number; skipped: number; total: number }>(
      "/api/import/artist",
      { method: "POST", body: JSON.stringify(input), adminToken },
    );
  },
  importYear(input: { query: string; source?: string; limit?: number; priority?: number }, adminToken: string) {
    return request<{ batch: ImportBatch; queued: number; skipped: number; total: number }>(
      "/api/import/year",
      { method: "POST", body: JSON.stringify(input), adminToken },
    );
  },
  importGeneric(input: { source: string; query: string; limit?: number; priority?: number }, adminToken: string) {
    return request<{ batch: ImportBatch; queued: number; skipped: number; total: number }>(
      "/api/import",
      { method: "POST", body: JSON.stringify(input), adminToken },
    );
  },
  listBatches(adminToken: string, limit = 50): Promise<ImportBatch[]> {
    return request<ImportBatch[]>(`/api/import/batches?limit=${limit}`, { adminToken });
  },
  listImportSources(adminToken: string): Promise<{ sources: string[] }> {
    return request("/api/import/sources", { adminToken });
  },

  // ---- admin auth ----
  adminLogin(username: string, password: string) {
    return request<{ token: string; username: string; must_change_password: boolean }>(
      "/api/admin/login",
      { method: "POST", body: JSON.stringify({ username, password }) },
    );
  },
  adminLogout(adminToken: string): Promise<void> {
    return request("/api/admin/logout", { method: "POST", adminToken });
  },
  adminMe(adminToken: string): Promise<AdminUser> {
    return request<AdminUser>("/api/admin/me", { adminToken });
  },
  adminChangePassword(
    current_password: string,
    new_password: string,
    adminToken: string,
  ): Promise<void> {
    return request("/api/admin/change-password", {
      method: "POST", body: JSON.stringify({ current_password, new_password }), adminToken,
    });
  },

  // ---- settings ----
  getSettings(adminToken: string): Promise<AppSettings> {
    return request<AppSettings>("/api/settings", { adminToken });
  },
  updateSettings(patch: Partial<AppSettings> & {
    vps_ssh_key?: string;
    notify_slack_webhook?: string;
    player_lyrics_style?: LyricsStyle;
  }, adminToken: string): Promise<AppSettings> {
    return request<AppSettings>("/api/settings", {
      method: "PATCH", body: JSON.stringify(patch), adminToken,
    });
  },

  // ---- worker health ----
  workerHealth() {
    return request<{
      ok: boolean;
      device?: { type: string; name?: string; vram_gb?: number };
      models?: { demucs: string; whisper: string };
      concurrency?: number;
      error?: string;
    }>("/api/health/worker");
  },
};

export { ApiError };
