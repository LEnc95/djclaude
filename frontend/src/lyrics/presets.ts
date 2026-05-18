import type { LyricsPresetName, LyricsStyle } from "../types";

// Six built-in themes. The "custom" entry below is just a copy of "classic"
// and serves as the seed when the user starts tweaking values manually.
export const LYRICS_PRESETS: Record<LyricsPresetName, LyricsStyle> = {
  neon: {
    preset: "neon",
    fontFamily: '"Bebas Neue", Impact, system-ui',
    fontSize: 90,
    fontWeight: 700,
    fontStyle: "normal",
    textColor: "#0ff5ff",
    activeColor: "#ff3ec8",
    upcomingColor: "#5577aa",
    uppercase: true,
    letterSpacing: 4,
    textAlign: "center",
    shadowEnabled: true,
    shadowColor: "#001122",
    shadowOpacity: 0.85,
    shadowBlur: 26,
    bgPanelEnabled: true,
    bgPanelOpacity: 0.45,
  },
  classic: {
    preset: "classic",
    fontFamily: '"Inter", system-ui',
    fontSize: 72,
    fontWeight: 800,
    fontStyle: "normal",
    textColor: "#ffffff",
    activeColor: "#ffe14a",
    upcomingColor: "#cccccc",
    uppercase: false,
    letterSpacing: 0,
    textAlign: "center",
    shadowEnabled: true,
    shadowColor: "auto",
    shadowOpacity: 0.7,
    shadowBlur: 14,
    bgPanelEnabled: true,
    bgPanelOpacity: 0.35,
  },
  concert: {
    preset: "concert",
    fontFamily: '"Oswald", "Bebas Neue", Impact, system-ui',
    fontSize: 96,
    fontWeight: 700,
    fontStyle: "normal",
    textColor: "#ffd24a",
    activeColor: "#ffffff",
    upcomingColor: "#a07d00",
    uppercase: true,
    letterSpacing: 3,
    textAlign: "center",
    shadowEnabled: true,
    shadowColor: "#000000",
    shadowOpacity: 0.9,
    shadowBlur: 22,
    bgPanelEnabled: true,
    bgPanelOpacity: 0.55,
  },
  vaporwave: {
    preset: "vaporwave",
    fontFamily: '"Press Start 2P", "Courier New", monospace',
    fontSize: 56,
    fontWeight: 400,
    fontStyle: "normal",
    textColor: "#ff77ff",
    activeColor: "#00f0ff",
    upcomingColor: "#9050b5",
    uppercase: true,
    letterSpacing: 2,
    textAlign: "center",
    shadowEnabled: true,
    shadowColor: "#270049",
    shadowOpacity: 0.8,
    shadowBlur: 24,
    bgPanelEnabled: true,
    bgPanelOpacity: 0.5,
  },
  minimal: {
    preset: "minimal",
    fontFamily: '"Inter", system-ui',
    fontSize: 56,
    fontWeight: 400,
    fontStyle: "normal",
    textColor: "#f5f5f5",
    activeColor: "#ffffff",
    upcomingColor: "#888888",
    uppercase: false,
    letterSpacing: 0,
    textAlign: "center",
    shadowEnabled: false,
    shadowColor: "auto",
    shadowOpacity: 0.0,
    shadowBlur: 0,
    bgPanelEnabled: false,
    bgPanelOpacity: 0.0,
  },
  custom: {
    preset: "custom",
    fontFamily: '"Inter", system-ui',
    fontSize: 72,
    fontWeight: 800,
    fontStyle: "normal",
    textColor: "#ffffff",
    activeColor: "#ffe14a",
    upcomingColor: "#cccccc",
    uppercase: false,
    letterSpacing: 0,
    textAlign: "center",
    shadowEnabled: true,
    shadowColor: "auto",
    shadowOpacity: 0.7,
    shadowBlur: 14,
    bgPanelEnabled: true,
    bgPanelOpacity: 0.35,
  },
};

export const DEFAULT_LYRICS_STYLE: LyricsStyle = LYRICS_PRESETS.classic;

// resolveShadowColor: handles the "auto" sentinel by computing a high-contrast
// color (black for light text, white for dark text). Uses the standard YIQ
// luminance formula.
export function resolveShadowColor(style: LyricsStyle): string {
  if (style.shadowColor !== "auto") return style.shadowColor;
  const { r, g, b } = hexToRgb(style.textColor);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 128 ? "#000000" : "#ffffff";
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
