// Where the REST API + WebSocket live.
//
// Default ("") means "same origin as the SPA" — used by the single-binary
// Fly deploy and by local development through the Vite proxy.
//
// In split deploys (Vercel SPA → Fly API) set VITE_API_BASE at build time:
//   VITE_API_BASE=https://api.dj.aiandsons.io npm run build
//
// Trailing slashes are stripped for safety.
const raw = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
export const API_BASE = raw.replace(/\/+$/, "");

export const DJ_TIP_URL = ((import.meta.env.VITE_DJ_TIP_URL as string | undefined) ?? "").trim();
export const DEVELOPER_DONATE_URL = (
  (import.meta.env.VITE_DEVELOPER_DONATE_URL as string | undefined) ?? ""
).trim();

// WS URL prefix derived from API_BASE. Falls back to the current page origin
// converted to ws/wss for same-origin deploys.
export function wsURL(path: string): string {
  if (API_BASE) {
    const u = new URL(API_BASE);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.origin + path;
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}`;
}

export function apiURL(path: string): string {
  return API_BASE ? API_BASE + path : path;
}
