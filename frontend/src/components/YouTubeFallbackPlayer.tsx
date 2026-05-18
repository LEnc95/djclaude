import { useEffect, useRef } from "preact/hooks";

interface Props {
  videoID: string;
  mode: "host" | "guest" | "screen";
}

// YouTubeFallbackPlayer renders an embedded YouTube iframe for songs that
// haven't been processed into the library yet. The host gets full controls
// (so they can play/pause). Guests just see the video (no controls; YouTube
// embed always exposes its own player chrome anyway — there's no clean way
// to hide it for guests).
//
// We pass `mute=1` for guests so all phones don't shout the song over the
// host's audio. The host's iframe is unmuted.
export function YouTubeFallbackPlayer(props: Props) {
  const { videoID, mode } = props;
  const wrapRef = useRef<HTMLDivElement>(null);

  // Re-mount the iframe when videoID changes to avoid the YT player
  // caching the previous video.
  useEffect(() => {
    if (!wrapRef.current) return;
    wrapRef.current.innerHTML = "";
    const iframe = document.createElement("iframe");
    const params = new URLSearchParams({
      autoplay: mode === "screen" || mode === "host" ? "1" : "0",
      mute: mode === "guest" ? "1" : "0",
      controls: mode === "host" ? "1" : "0",
      modestbranding: "1",
      rel: "0",
      playsinline: "1",
    });
    iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoID)}?${params}`;
    iframe.allow = "autoplay; encrypted-media; picture-in-picture";
    iframe.allowFullscreen = true;
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    iframe.style.border = "0";
    wrapRef.current.appendChild(iframe);
  }, [videoID, mode]);

  return (
    <div class="karaoke-player karaoke-player--fallback">
      <div class="karaoke-player__fallback-note">
        Playing from YouTube — not yet in library. Lyrics overlay disabled.
      </div>
      <div ref={wrapRef} class="karaoke-player__yt" />
    </div>
  );
}
