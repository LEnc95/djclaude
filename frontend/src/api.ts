import type {
  CreateRequestResponse,
  KaraokeEvent,
  KaraokeRequest,
  RequestStatus,
} from "./types";
import { apiURL } from "./config";

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { hostToken?: string } = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (init.hostToken) headers.set("X-Host-Token", init.hostToken);
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
  createEvent(input: {
    name: string;
    venue_name?: string;
    per_singer_limit?: number;
    auto_accept?: boolean;
  }): Promise<KaraokeEvent> {
    return request<KaraokeEvent>("/api/events", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  getEvent(code: string, hostToken?: string): Promise<KaraokeEvent> {
    return request<KaraokeEvent>(`/api/events/${encodeURIComponent(code)}`, { hostToken });
  },

  updateEvent(
    code: string,
    patch: Partial<Pick<KaraokeEvent, "status" | "accepting_requests" | "auto_accept" | "per_singer_limit" | "name" | "venue_name">>,
    hostToken: string
  ): Promise<KaraokeEvent> {
    return request<KaraokeEvent>(`/api/events/${encodeURIComponent(code)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
      hostToken,
    });
  },

  listRequests(
    code: string,
    opts: { statuses?: RequestStatus[]; hostToken?: string } = {}
  ): Promise<KaraokeRequest[]> {
    const qs = opts.statuses?.length ? `?status=${opts.statuses.join(",")}` : "";
    return request<KaraokeRequest[]>(`/api/events/${encodeURIComponent(code)}/requests${qs}`, {
      hostToken: opts.hostToken,
    });
  },

  createRequest(
    code: string,
    input: { singer_name: string; song_input: string; notes?: string; song_title?: string }
  ): Promise<CreateRequestResponse> {
    return request<CreateRequestResponse>(`/api/events/${encodeURIComponent(code)}/requests`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  updateRequest(
    code: string,
    id: string,
    patch: Partial<Pick<KaraokeRequest, "status" | "singer_name" | "youtube_url" | "song_title" | "notes" | "manual_order">>,
    hostToken: string
  ): Promise<KaraokeRequest> {
    return request<KaraokeRequest>(`/api/events/${encodeURIComponent(code)}/requests/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
      hostToken,
    });
  },

  deleteRequest(code: string, id: string, hostToken: string): Promise<void> {
    return request<void>(`/api/events/${encodeURIComponent(code)}/requests/${id}`, {
      method: "DELETE",
      hostToken,
    });
  },
};

export { ApiError };
