import { useEffect, useRef, useState } from "preact/hooks";
import type { LyricsDoc, LyricsStyle, Media, PlaybackState, Song } from "../types";
import { mediaURL } from "../config";
import { LyricsCanvas } from "./LyricsCanvas";

export type PlayerMode = "host" | "guest" | "screen";

interface Props {
  song: Song | null;            // null while loading or before any song selected
  mode: PlayerMode;
  lyricsStyle?: LyricsStyle;
  // Force autoplay on mount. Defaults to true for "screen" mode; opt-in for
  // others when the parent knows the action was user-initiated (clicking
  // "Play" in the library, etc.) — that user gesture is what browsers
  // require to allow audible autoplay.
  autoPlay?: boolean;
  // host-only:
  onVideoRef?: (v: HTMLVideoElement | null) => void;
  // guest/screen-only: incoming remote state used to follow
  remoteState?: PlaybackState | null;
}

// KaraokePlayer wraps the muted-on-followers <video> + a LyricsCanvas
// overlay. On the host it plays unmuted (audio out of the laptop). On
// guests it's muted; on screen mode (HDMI/cast) it's unmuted.
//
// The sync logic lives in usePlaybackSync — this component only renders.
export function KaraokePlayer(props: Props) {
  const { song, mode, lyricsStyle } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [doc, setDoc] = useState<LyricsDoc | null>(null);
  const [loading, setLoading] = useState(false);

  const media: Media | null = song?.primary_media ?? null;

  // Tell parent about the <video> element so it can wire usePlaybackSync.
  useEffect(() => {
    props.onVideoRef?.(videoRef.current);
    return () => props.onVideoRef?.(null);
  }, [videoRef.current]);

  // Load lyrics whenever the active song changes.
  useEffect(() => {
    if (!media) {
      setDoc(null);
      return;
    }
    setLoading(true);
    fetch(mediaURL(media.lyrics_path))
      .then((r) => r.json())
      .then((d: LyricsDoc) => setDoc(d))
      .catch(() => setDoc(null))
      .finally(() => setLoading(false));
  }, [media?.id]);

  if (!song) {
    return (
      <div class="karaoke-player karaoke-player--empty">
        <div class="karaoke-player__placeholder">Waiting for next song…</div>
      </div>
    );
  }

  if (!media) {
    return (
      <div class="karaoke-player karaoke-player--empty">
        <div class="karaoke-player__placeholder">
          <strong>{song.title}</strong>
          <span>— {song.artist}</span>
          <p>Still being processed. Library version will appear when ready.</p>
        </div>
      </div>
    );
  }

  const muted = mode === "guest";
  const shouldAutoplay = props.autoPlay ?? (mode === "screen");

  // Even with the autoPlay attribute, some browsers gate audible playback
  // unless we explicitly call .play() in response to a recent user gesture
  // (e.g. clicking the "Play" button that opened this modal). Try; ignore
  // the rejection — native controls still work as a manual fallback.
  useEffect(() => {
    if (!shouldAutoplay || !videoRef.current || !media) return;
    videoRef.current.play().catch(() => {/* autoplay blocked, fall back to controls */});
  }, [media?.id, shouldAutoplay]);

  return (
    <div class="karaoke-player">
      <video
        ref={videoRef}
        class="karaoke-player__video"
        src={mediaURL(media.instrumental_path)}
        muted={muted}
        playsInline
        preload="auto"
        // controls only on host; guests can't pause for everyone
        controls={mode === "host"}
        autoPlay={shouldAutoplay}
      />
      <LyricsCanvas
        className="karaoke-player__lyrics"
        doc={doc}
        style={lyricsStyle}
        getTime={() => videoRef.current?.currentTime ?? 0}
      />
      {loading && <div class="karaoke-player__loading">Loading lyrics…</div>}
    </div>
  );
}
