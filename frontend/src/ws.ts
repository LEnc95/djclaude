import type { WSEvent } from "./types";
import { wsURL } from "./config";

export interface WSOptions {
  code: string;
  hostToken?: string;
  onEvent: (ev: WSEvent) => void;
  onStatus?: (s: "connecting" | "open" | "closed") => void;
}

// Tiny auto-reconnecting WebSocket client. Backoff doubles up to 8s.
export function connectWS(opts: WSOptions): () => void {
  let stopped = false;
  let ws: WebSocket | null = null;
  let retry = 0;
  let reconnectTimer: number | undefined;

  const open = () => {
    if (stopped) return;
    opts.onStatus?.("connecting");
    const qs = opts.hostToken ? `?host_token=${encodeURIComponent(opts.hostToken)}` : "";
    ws = new WebSocket(wsURL(`/ws/${encodeURIComponent(opts.code)}${qs}`));

    ws.onopen = () => {
      retry = 0;
      opts.onStatus?.("open");
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

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  };
}
