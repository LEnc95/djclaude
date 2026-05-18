import { useEffect, useRef, useState } from "preact/hooks";
import type { PlaybackState } from "../types";
import type { WSClient } from "../ws";

// usePlaybackSync — bidirectional helper.
//
// On the HOST page: pass `role="host"` and the active <video> ref. Every
// `tickMs` (default 500) we serialize {currentTime, paused, rate, song_id}
// and ws.send() it. The server stamps server_ts and fans out.
//
// On GUEST/SCREEN pages: pass `role="follower"`. Pipe playback:state events
// into setRemoteState(); the hook nudges the local <video> toward the host's
// reported time. We allow ±0.4s drift (imperceptible), seek hard when off
// by >1s, and pause/play to match.

const TICK_MS_HOST = 500;
const TOLERANCE_FOLLOW = 0.4; // small drift OK
const HARD_SEEK = 1.2;

type Role = "host" | "follower";

interface HostOpts {
  role: "host";
  videoRef: { current: HTMLVideoElement | null };
  ws: WSClient | null;
  songID: string;
  requestID?: string;
}

interface FollowerOpts {
  role: "follower";
  videoRef: { current: HTMLVideoElement | null };
}

export function usePlaybackSync(opts: HostOpts | FollowerOpts) {
  const [remote, setRemote] = useState<PlaybackState | null>(null);

  // ---- HOST: broadcast loop ----
  useEffect(() => {
    if (opts.role !== "host") return;
    const interval = window.setInterval(() => {
      const v = opts.videoRef.current;
      const ws = opts.ws;
      if (!v || !ws) return;
      ws.send({
        type: "playback:state",
        payload: {
          song_id: opts.songID,
          request_id: opts.requestID,
          current_time: v.currentTime,
          paused: v.paused,
          rate: v.playbackRate,
        },
      });
    }, TICK_MS_HOST);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.role, (opts as HostOpts).songID, (opts as HostOpts).ws]);

  // ---- FOLLOWER: reconcile local <video> with remote state ----
  useEffect(() => {
    if (opts.role !== "follower") return;
    if (!remote) return;
    const v = opts.videoRef.current;
    if (!v) return;

    // Compensate for transit latency: host's time was current at server_ts;
    // now is now. Add the wall-clock delta so we hit the same wall moment.
    const wallDriftSec = Math.max(0, (Date.now() - remote.server_ts) / 1000);
    const target = remote.current_time + (remote.paused ? 0 : wallDriftSec);

    const drift = v.currentTime - target;

    if (Math.abs(drift) > HARD_SEEK) {
      v.currentTime = target;
    } else if (Math.abs(drift) > TOLERANCE_FOLLOW) {
      // soft correction: nudge playback rate up/down briefly
      const dir = drift > 0 ? -1 : 1;
      v.playbackRate = 1 + dir * 0.05;
      window.setTimeout(() => {
        if (opts.videoRef.current) opts.videoRef.current.playbackRate = 1;
      }, 600);
    }

    if (remote.paused && !v.paused) v.pause();
    if (!remote.paused && v.paused) v.play().catch(() => {/* autoplay blocked */});
  }, [remote]);

  return { remote, setRemote };
}
