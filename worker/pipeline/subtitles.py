"""Convert our lyrics JSON into an ASS subtitle file with karaoke timing.

ASS (Advanced SubStation Alpha) is the standard for karaoke videos —
ffmpeg's `subtitles` filter burns it in, and the `\k` timing tags color
the word currently being sung. The output is a self-contained file you
can drop into any video player and see lyrics highlight in real time.
"""
from __future__ import annotations

from pathlib import Path


def _ts(seconds: float) -> str:
    """ASS timestamp: H:MM:SS.cc (centiseconds, not milliseconds)."""
    if seconds < 0:
        seconds = 0.0
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    cs = int(round((seconds - int(seconds)) * 100))
    if cs >= 100:
        cs = 99
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _escape_ass(text: str) -> str:
    """ASS uses `\` as an escape char and treats `{` `}` as override blocks.
    We strip/escape so lyric text doesn't accidentally trigger formatting."""
    return (text or "").replace("\\", " ").replace("{", "(").replace("}", ")")


def lyrics_to_ass(lyrics: dict, *, width: int = 1920, height: int = 1080) -> str:
    """Render our lyrics JSON into an ASS file string.

    Each segment becomes a Dialogue line containing per-word `\k<cs>` tags
    that drive karaoke-style fill animation.

    Returns the full ASS file contents (header + styles + events).
    """
    # Big, bold, white-with-black-outline — readable over any album art.
    # Karaoke fill highlights the currently-singing word.
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: KFill,   Arial Black, 84, &H00FFFFFF, &H0014C8FF, &H00000000, &H80000000, -1, 0, 0, 0, 100, 100, 1, 0, 1, 4, 2, 2, 80, 80, 110, 1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    lines: list[str] = []
    segments = lyrics.get("segments") or []
    for seg in segments:
        seg_text = (seg.get("text") or "").strip()
        if not seg_text:
            continue

        words = seg.get("words") or []
        start = float(seg.get("start", 0.0))
        end = float(seg.get("end", start + 2.0))

        if not words:
            # No per-word timings → just plain text for the segment
            ev_text = _escape_ass(seg_text)
        else:
            # Build karaoke timing: \k<centiseconds_to_sing_this_word>
            chunks: list[str] = []
            prev_end = start
            for w in words:
                w_text = _escape_ass((w.get("word") or "").strip())
                if not w_text:
                    continue
                w_start = float(w.get("start", prev_end))
                w_end = float(w.get("end", w_start + 0.2))
                # Gap-before-word (silence): show but don't fill yet
                gap_cs = max(0, int(round((w_start - prev_end) * 100)))
                if gap_cs > 0 and chunks:
                    chunks.append(f"{{\\k{gap_cs}}} ")
                # Word duration in centiseconds (min 5cs = 50ms so highlight visible)
                dur_cs = max(5, int(round((w_end - w_start) * 100)))
                chunks.append(f"{{\\kf{dur_cs}}}{w_text} ")
                prev_end = w_end
            ev_text = "".join(chunks).strip()

        lines.append(
            f"Dialogue: 0,{_ts(start)},{_ts(end + 0.3)},KFill,,0,0,0,,{ev_text}"
        )

    return header + "\n".join(lines) + "\n"


def write_ass(lyrics: dict, out_path: Path) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(lyrics_to_ass(lyrics), encoding="utf-8")
    return out_path
