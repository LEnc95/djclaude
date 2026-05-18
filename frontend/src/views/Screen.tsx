import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api";
import { connectWS, type WSClient } from "../ws";
import type { AppSettings, KaraokeEvent, KaraokeRequest, PlaybackState, Song } from "../types";
import { KaraokePlayer } from "../components/KaraokePlayer";
import { YouTubeFallbackPlayer } from "../components/YouTubeFallbackPlayer";
import { usePlaybackSync } from "../hooks/usePlaybackSync";
import { DEFAULT_LYRICS_STYLE } from "../lyrics/presets";

interface Props {
  code: string;
}

// Screen — projector/TV mode. Same player as Host/Guest but chromeless and
// auto-fullscreen on first interaction. Audio is UNMUTED (this is what's
// connected to the actual speakers via HDMI).
export function Screen({ code }: Props) {
  const [event, setEvent] = useState<KaraokeEvent | null>(null);
  const [requests, setRequests] = useState<KaraokeRequest[]>([]);
  const [song, setSong] = useState<Song | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wsRef = useRef<WSClient | null>(null);
  const { remote, setRemote } = usePlaybackSync({ role: "follower", videoRef });

  // Connect WS (no host token — screen is a follower).
  useEffect(() => {
    const ws = connectWS({
      code,
      onEvent: (ev) => {
        if (ev.type === "snapshot") {
          setEvent(ev.payload.event);
          setRequests(ev.payload.requests);
        } else if (ev.type === "request:created" || ev.type === "request:updated") {
          setRequests((rs) => {
            const idx = rs.findIndex((r) => r.id === ev.payload.id);
            if (idx === -1) return [...rs, ev.payload];
            const next = [...rs];
            next[idx] = ev.payload;
            return next;
          });
        } else if (ev.type === "request:deleted") {
          setRequests((rs) => rs.filter((r) => r.id !== ev.payload.id));
        } else if (ev.type === "playback:state") {
          setRemote(ev.payload as PlaybackState);
          // Lazy-load the song details when song_id changes.
          if (ev.payload.song_id && (!song || song.id !== ev.payload.song_id)) {
            api.getLibrarySong(ev.payload.song_id).then(setSong).catch(() => setSong(null));
          }
        } else if (ev.type === "playback:load") {
          if (ev.payload.song_id) {
            api.getLibrarySong(ev.payload.song_id).then(setSong).catch(() => setSong(null));
          }
        }
      },
    });
    wsRef.current = ws;
    return () => ws.close();
  }, [code]);

  // Load latest player style (no admin token needed; settings.player_lyrics_style
  // is the only field; we proxy through the host pages anyway in real use).
  useEffect(() => {
    // Settings endpoint requires admin. Screen mode falls back to default style
    // unless the host shares it via a separate WS message in the future.
    setSettings(null);
  }, []);

  const current = requests.find((r) => r.status === "singing");

  // Resolve the playable artifact for the current "singing" request:
  // 1. song already loaded via playback:load? use it
  // 2. request.song_id present? fetch the Song
  // 3. else fall back to YouTube embed
  useEffect(() => {
    if (!current) {
      setSong(null);
      return;
    }
    if (current.song_id) {
      api.getLibrarySong(current.song_id).then(setSong).catch(() => setSong(null));
    } else {
      setSong(null);
    }
  }, [current?.song_id]);

  const isFallback = !!current && !current.song_id && !!current.youtube_video_id;

  return (
    <div class="screen-mode">
      {!event && <div class="screen-mode__empty">Connecting…</div>}
      {event && !current && (
        <div class="screen-mode__empty">
          <h1>{event.name}</h1>
          <p>{event.venue_name}</p>
          <p class="muted">Waiting for the next song…</p>
        </div>
      )}
      {current && isFallback && (
        <YouTubeFallbackPlayer videoID={current.youtube_video_id!} mode="screen" />
      )}
      {current && !isFallback && (
        <KaraokePlayer
          song={song}
          mode="screen"
          lyricsStyle={settings?.player_lyrics_style ?? DEFAULT_LYRICS_STYLE}
          onVideoRef={(v) => { videoRef.current = v; }}
        />
      )}
    </div>
  );
}
