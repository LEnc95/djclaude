import { useEffect, useRef } from "preact/hooks";
import type { LyricsDoc, LyricsSegment, LyricsStyle } from "../types";
import { DEFAULT_LYRICS_STYLE, resolveShadowColor, rgba } from "../lyrics/presets";

interface Props {
  doc: LyricsDoc | null;
  getTime: () => number;          // called every frame; returns video.currentTime
  style?: LyricsStyle;
  className?: string;
  // Render at the natural 1920x1080 aspect; we letterbox automatically.
  // For phones we scale fontSize down proportional to canvas width.
}

const TARGET_W = 1920;

// LyricsCanvas: a requestAnimationFrame loop that paints the active segment
// word-by-word against `getTime()`. Designed to overlay a <video> element.
export function LyricsCanvas(props: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const docRef = useRef<LyricsDoc | null>(props.doc);
  const styleRef = useRef<LyricsStyle>(props.style ?? DEFAULT_LYRICS_STYLE);
  const getTimeRef = useRef(props.getTime);

  docRef.current = props.doc;
  styleRef.current = props.style ?? DEFAULT_LYRICS_STYLE;
  getTimeRef.current = props.getTime;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const dpr = window.devicePixelRatio || 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    };
    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = () => {
      const doc = docRef.current;
      const style = styleRef.current;
      const t = getTimeRef.current();

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!doc) {
        raf = requestAnimationFrame(draw);
        return;
      }

      // scale fontSize from the 1080p design height to the actual canvas
      const w = canvas.width;
      const h = canvas.height;
      const scale = w / (TARGET_W * dpr);
      const fontSize = Math.max(14, Math.round(style.fontSize * scale * dpr));

      const seg = currentSegment(doc, t);
      if (!seg) {
        raf = requestAnimationFrame(draw);
        return;
      }

      ctx.font = `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
      ctx.textBaseline = "middle";
      const align = style.textAlign;
      ctx.textAlign = align;

      // Decide horizontal anchor
      const anchorX = align === "center" ? w / 2 : align === "right" ? w - 64 * dpr : 64 * dpr;
      const y = h * 0.78; // lower third — keeps the album-art space above

      const tokens = seg.words.length > 0 ? seg.words : [{
        word: seg.text, start: seg.start, end: seg.end, score: 1,
      }];

      const fmt = (s: string) => style.uppercase ? s.toUpperCase() : s;
      const padded = tokens.map((tk) => fmt(tk.word) + " ");
      const widths = padded.map((s) => ctx.measureText(s).width);
      const totalW = widths.reduce((a, b) => a + b, 0);

      // Optional translucent backing panel behind the line (improves
      // readability over busy album art).
      if (style.bgPanelEnabled) {
        const padX = 48 * dpr;
        const padY = 28 * dpr;
        const left = align === "center" ? anchorX - totalW / 2 - padX
          : align === "right" ? anchorX - totalW - padX
          : anchorX - padX;
        ctx.fillStyle = rgba("#000000", style.bgPanelOpacity);
        roundRect(ctx, left, y - fontSize / 2 - padY, totalW + padX * 2, fontSize + padY * 2, 12 * dpr);
        ctx.fill();
      }

      // Layout: draw each word; the currently-singing word uses activeColor,
      // already-sung words use textColor, upcoming words use upcomingColor.
      let cursorX = align === "center" ? anchorX - totalW / 2
        : align === "right" ? anchorX - totalW
        : anchorX;
      ctx.textAlign = "left";
      const shadowColor = resolveShadowColor(style);

      for (let i = 0; i < tokens.length; i++) {
        const tk = tokens[i];
        let color = style.upcomingColor;
        if (t >= tk.start && t <= tk.end + 0.05) {
          color = style.activeColor;
        } else if (t > tk.end) {
          color = style.textColor;
        }
        if (style.shadowEnabled && style.shadowOpacity > 0) {
          ctx.shadowColor = rgba(shadowColor, style.shadowOpacity);
          ctx.shadowBlur = style.shadowBlur * dpr;
        } else {
          ctx.shadowBlur = 0;
        }
        ctx.fillStyle = color;
        // letter-spacing isn't part of Canvas2D — we fake it by drawing letter
        // by letter when > 0. Skip when zero for performance.
        if (style.letterSpacing > 0) {
          drawSpaced(ctx, padded[i], cursorX, y, style.letterSpacing * dpr);
        } else {
          ctx.fillText(padded[i], cursorX, y);
        }
        cursorX += widths[i];
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={ref} class={props.className ?? "lyrics-canvas"} />;
}

// ----- helpers -----

function currentSegment(doc: LyricsDoc, t: number): LyricsSegment | null {
  // Binary search would be tidier; segments are typically 50-200 → linear is fine.
  // Pick the segment whose [start, end] brackets t; if none, fall back to the
  // most recent past segment so the screen isn't empty between lines.
  let latest: LyricsSegment | null = null;
  for (const s of doc.segments) {
    if (t >= s.start && t <= s.end + 0.5) return s;
    if (t > s.end) latest = s;
    if (t < s.start) break;
  }
  return latest;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawSpaced(
  ctx: CanvasRenderingContext2D,
  text: string, x: number, y: number, spacing: number,
) {
  let cx = x;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacing;
  }
}
