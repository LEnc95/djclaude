import type { PlaybackState, WSEvent } from "./types";
import { wsURL } from "./config";

export interface WSOptions {
  code: string;
  hostToken?: string;
  onEvent: (ev: WSEvent) => void;
  onStatus?: (s: "connecting" | "open" | "closed") => void;
}

// WSClient: tiny auto-reconnecting WebSocket that also exposes outbound
// send helpers (the host pushes playback:state via this). Backoff doubles
// up to 8s.
export interface WSClient {
  send(msg: WSOutbound): void;
  close(): void;
}

export type WSOutbound =
  | { type: "playback:state"; payload: Omit<PlaybackState, "server_ts"> }
  | { type: "playback:load"; payload: { request_id?: string; song_id?: string } }
  | { type: "ping"; payload: {} };

export function connectWS(opts: WSOptions): WSClient {
  let stopped = false;
  let ws: WebSocket | null = null;
  let retry = 0;
  let reconnectTimer: number | undefined;
  let pendingOutbound: WSOutbound[] = [];

  const flush = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (const m of pendingOutbound) ws.send(JSON.stringify(m));
    pendingOutbound = [];
  };

  const open = () => {
    if (stopped) return;
    opts.onStatus?.("connecting");
    const qs = opts.hostToken ? `?host_token=${encodeURIComponent(opts.hostToken)}` : "";
    ws = new WebSocket(wsURL(`/ws/${encodeURIComponent(opts.code)}${qs}`));

    ws.onopen = () => {
      retry = 0;
      opts.onStatus?.("open");
      flush();
    };
    ws.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as WSEvent;
        opts.onEvent(ev);
      } catch (err) {
        console.warn("ws parse", err);
      }
    };
    ws.onclose = () => {
      opts.onStatus?.("closed");
      if (stopped) return;
      const delay = Math.min(8000, 500 * 2 ** retry++);
      reconnectTimer = window.setTimeout(open, delay);
    };
    ws.onerror = () => ws?.close();
  };

  open();

  return {
    send(m) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(m));
      } else {
        // Buffer until the next open. The host's playback:state is sent at
        // ~2 Hz; missing a tick or two during reconnect is harmless.
        pendingOutbound.push(m);
        if (pendingOutbound.length > 16) pendingOutbound = pendingOutbound.slice(-16);
      }
    },
    close() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
