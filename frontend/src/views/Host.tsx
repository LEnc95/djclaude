import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../api";
import { connectWS, type WSClient } from "../ws";
import type { AppSettings, KaraokeEvent, KaraokeRequest, Song, WSEvent } from "../types";
import { Icon } from "../components/Icon";
import { RequestQRCode } from "../components/RequestQRCode";
import { SEO } from "../components/SEO";
import { KaraokePlayer } from "../components/KaraokePlayer";
import { YouTubeFallbackPlayer } from "../components/YouTubeFallbackPlayer";
import { usePlaybackSync } from "../hooks/usePlaybackSync";
import { DEFAULT_LYRICS_STYLE } from "../lyrics/presets";

interface Props {
  code: string;
}

function tokenForCode(code: string): string | null {
  const url = new URL(location.href);
  const t = url.searchParams.get("token");
  if (t) {
    localStorage.setItem(`host_token:${code}`, t);
    url.searchParams.delete("token");
    history.replaceState({}, "", url.toString());
    return t;
  }
  return localStorage.getItem(`host_token:${code}`);
}

function fmtMinsAgo(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 60000;
  if (diff < 1) return "just now";
  if (diff < 60) return `${Math.floor(diff)} min ago`;
  return `${Math.floor(diff / 60)}h ago`;
}

export function Host({ code }: Props) {
  const [token] = useState<string | null>(() => tokenForCode(code));
  const [event, setEvent] = useState<KaraokeEvent | null>(null);
  const [requests, setRequests] = useState<KaraokeRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [conn, setConn] = useState<"connecting" | "open" | "closed">("connecting");
  const [activeTab, setActiveTab] = useState<"deck" | "requests">("deck");
  const [qrOpen, setQrOpen] = useState(false);

  const wsRef = useRef<WSClient | null>(null);

  useEffect(() => {
    if (!token) return;
    const ws = connectWS({
      code,
      hostToken: token,
      onEvent: handleEvent,
      onStatus: setConn,
    });
    wsRef.current = ws;
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [code, token]);

  function handleEvent(ev: WSEvent) {
    switch (ev.type) {
      case "snapshot":
        setEvent(ev.payload.event);
        setRequests(ev.payload.requests);
        break;
      case "event:updated":
        setEvent((prev) => ({ ...(prev ?? ev.payload), ...ev.payload }));
        break;
      case "request:created":
      case "request:updated":
        setRequests((prev) => upsert(prev, ev.payload));
        break;
      case "request:deleted":
        setRequests((prev) => prev.filter((r) => r.id !== ev.payload.id));
        break;
    }
  }
  function upsert(list: KaraokeRequest[], r: KaraokeRequest) {
    const i = list.findIndex((x) => x.id === r.id);
    if (i === -1) return [...list, r];
    const next = list.slice();
    next[i] = r;
    return next;
  }

  const singing = useMemo(() => requests.find((r) => r.status === "singing"), [requests]);

  // ---- Player + playback sync ----
  const [activeSong, setActiveSong] = useState<Song | null>(null);
  const [lyricsStyle, setLyricsStyle] = useState(DEFAULT_LYRICS_STYLE);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  usePlaybackSync({
    role: "host",
    videoRef: videoElRef,
    ws: wsRef.current,
    songID: activeSong?.id ?? "",
    requestID: singing?.id,
  });
  // Load the library song for the current singer; null while loading or
  // when the request hasn't been resolved (→ YT fallback in UI).
  useEffect(() => {
    if (singing?.song_id) {
      api.getLibrarySong(singing.song_id).then(setActiveSong).catch(() => setActiveSong(null));
    } else {
      setActiveSong(null);
    }
  }, [singing?.song_id]);
  // Load the saved lyrics style once (admins set it from the Admin page).
  useEffect(() => {
    const adminTok = localStorage.getItem("djclaude.admin_token");
    if (!adminTok) return;
    api.getSettings(adminTok).then((s: AppSettings) => {
      if (s.player_lyrics_style) setLyricsStyle(s.player_lyrics_style);
    }).catch(() => {});
  }, []);

  const queue = useMemo(
    () =>
      requests
        .filter((r) => r.status === "accepted")
        .sort((a, b) => {
          const ma = a.manual_order || Number.MAX_SAFE_INTEGER;
          const mb = b.manual_order || Number.MAX_SAFE_INTEGER;
          if (ma !== mb) return ma - mb;
          if (a.rotation_index !== b.rotation_index)
            return a.rotation_index - b.rotation_index;
          return a.created_at.localeCompare(b.created_at);
        }),
    [requests]
  );
  const pending = useMemo(
    () =>
      requests
        .filter((r) => r.status === "pending")
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [requests]
  );
  const stats = useMemo(() => {
    const active = requests.filter(
      (r) =>
        r.status === "accepted" ||
        r.status === "singing" ||
        r.status === "pending"
    );
    const singers = new Set(active.map((r) => r.singer_name.toLowerCase())).size;
    const done = requests.filter((r) => r.status === "done").length;
    return { singers, done, queued: queue.length };
  }, [requests, queue.length]);

  const patch = useCallback(
    async (id: string, body: Parameters<typeof api.updateRequest>[2]) => {
      if (!token) return;
      try {
        await api.updateRequest(code, id, body, token);
      } catch (e: any) {
        setError(e.message ?? "Update failed");
      }
    },
    [code, token]
  );

  const remove = useCallback(
    async (id: string) => {
      if (!token) return;
      if (!confirm("Remove this request?")) return;
      try {
        await api.deleteRequest(code, id, token);
      } catch (e: any) {
        setError(e.message ?? "Delete failed");
      }
    },
    [code, token]
  );

  async function updateEventField<K extends keyof KaraokeEvent>(field: K, value: KaraokeEvent[K]) {
    if (!event || !token) return;
    try {
      const next = await api.updateEvent(code, { [field]: value } as any, token);
      setEvent(next);
    } catch (e: any) {
      setError(e.message ?? "Update failed");
    }
  }

  function move(req: KaraokeRequest, direction: -1 | 1) {
    const idx = queue.findIndex((r) => r.id === req.id);
    const neighbour = queue[idx + direction];
    if (!neighbour) return;
    const cur = req.manual_order || idx + 1;
    const nei = neighbour.manual_order || idx + 1 + direction;
    patch(req.id, { manual_order: nei });
    patch(neighbour.id, { manual_order: cur });
  }

  function openYouTube(req: KaraokeRequest) {
    if (req.youtube_url) window.open(req.youtube_url, "_blank", "noopener");
  }

  async function copyUrl(req: KaraokeRequest) {
    if (!req.youtube_url) return;
    try {
      await navigator.clipboard.writeText(req.youtube_url);
    } catch {
      /* clipboard may be unavailable; ignore */
    }
  }

  // Keyboard shortcuts: D / S / N.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "d" && singing) patch(singing.id, { status: "done" });
      else if (k === "s" && singing) patch(singing.id, { status: "skipped" });
      else if (k === "n" && queue[0]) patch(queue[0].id, { status: "singing" });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [singing, queue, patch]);

  if (!token) {
    return (
      <div class="min-h-screen flex items-center justify-center p-md">
        <SEO
          title="Host Dashboard Login"
          description="Private DJClaude host dashboard."
          canonicalPath="/"
          noindex
        />
        <div class="glass-panel rounded-xl p-md max-w-md text-center">
          <Icon name="lock" class="text-error text-5xl mb-sm" />
          <h2 class="font-headline-md text-headline-md text-on-surface mb-2">
            Host token required
          </h2>
          <p class="font-body-md text-body-md text-on-surface-variant">
            Open the host link you got when you created this event, or append
            <code class="font-label-caps px-1"> ?token=YOUR_TOKEN</code> to the URL.
          </p>
        </div>
      </div>
    );
  }

  if (!event) {
    return (
      <div class="min-h-screen flex items-center justify-center">
        <SEO
          title="Connecting Host Dashboard"
          description="Connecting to a private DJClaude karaoke host dashboard."
          canonicalPath="/"
          noindex
        />
        <p class="font-body-md text-on-surface-variant">Connecting…</p>
      </div>
    );
  }

  const eventActive = event.status === "active";
  const guestURL = `${location.origin}/r/${event.code}`;

  return (
    <div
      class="min-h-screen flex flex-col"
      style="background-color:#0F0F1A; background-image: radial-gradient(circle at 50% 0%, #1f1e2a 0%, #12121d 70%); background-attachment: fixed;"
    >
      <SEO
        title={`${event.name} Host Dashboard`}
        description={`Private host dashboard for ${event.name} at ${event.venue_name || "your event"}.`}
        canonicalPath={`/host/${event.code}`}
        noindex
      />
      {/* Top bar */}
      <header class="bg-surface/40 backdrop-blur-lg flex justify-between items-center px-gutter py-sm w-full sticky top-0 z-50 border-b border-white/10 shadow-[0_4px_30px_rgba(0,0,0,0.1)]">
        <div class="flex items-center gap-sm">
          <Icon name="mic_external_on" fill class="text-primary text-2xl" />
          <span class="font-headline-md text-headline-md font-bold tracking-tighter text-primary drop-shadow-[0_0_8px_rgba(236,177,255,0.4)]">
            {event.venue_name || "Neon Lounge"}
          </span>
        </div>
        <div class="flex items-center gap-md">
          <button
            type="button"
            onClick={() => setQrOpen(true)}
            class="h-10 px-3 rounded-lg bg-tertiary/10 border border-tertiary/40 text-tertiary flex items-center justify-center gap-2 hover:bg-tertiary/20 transition-colors"
            aria-label="Show guest QR"
            title="Show guest QR"
          >
            <Icon name="qr_code_2" class="text-[20px]" />
            <span class="hidden sm:inline font-label-caps text-label-caps">
              Guest QR
            </span>
          </button>
          <div class="hidden md:flex items-center gap-sm glass-panel rounded-full px-4 py-2 border-primary/30">
            <Toggle
              on={event.accepting_requests}
              onChange={(v) => updateEventField("accepting_requests", v)}
            />
            <span class="font-label-caps text-label-caps text-on-surface-variant">
              Accepting Requests
            </span>
          </div>
          <span class="flex items-center gap-2 text-sm">
            <span
              class={`w-2 h-2 rounded-full ${
                conn === "open"
                  ? "bg-tertiary"
                  : conn === "connecting"
                  ? "bg-secondary animate-pulse"
                  : "bg-error"
              }`}
            />
            <span class="hidden sm:inline font-label-caps text-label-caps text-on-surface-variant">
              {conn}
            </span>
          </span>
          <span class="hidden sm:inline-block font-label-caps text-label-caps text-on-surface-variant px-3 py-1 rounded-full bg-surface-container border border-white/10">
            {event.code}
          </span>
        </div>
      </header>

      {/* Karaoke player — only mounts when there's a "now singing" request */}
      {singing && (
        <section class="w-full max-w-[1600px] mx-auto px-gutter pt-md">
          {!singing.song_id && singing.youtube_video_id ? (
            <YouTubeFallbackPlayer videoID={singing.youtube_video_id} mode="host" />
          ) : (
            <KaraokePlayer
              song={activeSong}
              mode="host"
              lyricsStyle={lyricsStyle}
              autoPlay={true}
              onVideoRef={(v) => { videoElRef.current = v; }}
            />
          )}
        </section>
      )}

      {/* Main layout */}
      <main class="flex-grow flex flex-col md:flex-row w-full max-w-[1600px] mx-auto p-4 md:p-gutter gap-md md:h-[calc(100vh-80px)] md:overflow-hidden">
        {/* Sidebar (desktop) */}
        <aside class="hidden md:flex flex-col h-full w-64 bg-surface-container rounded-r-2xl border-r border-primary/20 shadow-2xl shadow-primary/10 py-md flex-shrink-0">
          <div class="px-6 pb-6 border-b border-white/10 mb-4">
            <div class="flex items-center gap-sm mb-2">
              <div class="w-12 h-12 rounded-full border-2 border-primary bg-primary/10 flex items-center justify-center">
                <Icon name="dashboard_customize" class="text-primary" />
              </div>
              <div>
                <h2 class="font-headline-md text-headline-md text-primary">
                  {event.name}
                </h2>
                <p class="font-label-caps text-label-caps text-on-surface-variant">
                  Host
                </p>
              </div>
            </div>
            <p class="font-body-md text-body-md text-on-surface-variant">
              {stats.done} songs done today
            </p>
          </div>
          <nav class="flex-1 flex flex-col gap-1 overflow-y-auto">
            <SidebarLink icon="dashboard_customize" label="DJ Deck" active />
            <SidebarLink icon="format_list_numbered" label={`Queue (${stats.queued})`} />
            <SidebarLink icon="notifications" label={`Pending (${pending.length})`} />
            <div class="mt-auto">
              <SidebarLink
                icon={eventActive ? "podcasts" : "block"}
                label={eventActive ? "Event active" : "Event closed"}
                onClick={() =>
                  updateEventField("status", eventActive ? "closed" : "active")
                }
              />
              <SidebarLink
                icon={event.auto_accept ? "check_circle" : "approval"}
                label={event.auto_accept ? "Auto-accept ON" : "Requires approval"}
                onClick={() => updateEventField("auto_accept", !event.auto_accept)}
              />
            </div>
          </nav>
        </aside>

        {/* Content grid */}
        <div class="flex-grow grid grid-cols-1 md:grid-cols-12 gap-md md:overflow-hidden pb-24 md:pb-0">
          {/* Center column */}
          <div
            class={`${
              activeTab === "deck" ? "flex" : "hidden md:flex"
            } md:col-span-8 flex-col gap-md min-h-0`}
          >
            {/* Now singing */}
            <section class="glass-panel rounded-xl p-md flex flex-col relative overflow-hidden border-primary/50 neon-glow-primary shrink-0">
              <div class="absolute inset-0 bg-gradient-to-br from-primary-container/20 to-transparent pointer-events-none" />
              {singing ? (
                <>
                  <div class="flex justify-between items-start mb-4 relative z-10 gap-sm">
                    <div class="min-w-0">
                      <span class="font-label-caps text-label-caps text-secondary mb-1 block animate-pulse">
                        ● NOW SINGING
                      </span>
                      <h1 class="font-display-lg text-display-lg text-on-primary-container line-clamp-1">
                        {singing.song_title || "Untitled"}
                      </h1>
                      <p class="font-headline-md text-headline-md text-primary-fixed-dim truncate">
                        {singing.youtube_url || "Song name only"}
                      </p>
                      {singing.notes && (
                        <p class="font-body-md text-body-md text-on-surface-variant italic mt-1">
                          “{singing.notes}”
                        </p>
                      )}
                    </div>
                    <div class="bg-surface-container rounded-lg p-2 text-center border border-white/10 shrink-0">
                      <span class="block font-label-caps text-label-caps text-on-surface-variant">
                        SINGER
                      </span>
                      <span class="font-headline-md text-headline-md text-tertiary">
                        {singing.singer_name}
                      </span>
                    </div>
                  </div>
                  <div class="flex flex-wrap gap-sm mt-auto relative z-10 pt-4 border-t border-white/10">
                    <button
                      class="btn-primary font-label-caps text-label-caps px-6 py-3 rounded-lg flex items-center gap-2"
                      onClick={() => patch(singing.id, { status: "done" })}
                    >
                      <Icon name="check_circle" class="text-[18px]" />
                      Done
                    </button>
                    <button
                      class="bg-transparent border-2 border-secondary text-secondary font-label-caps text-label-caps px-6 py-3 rounded-lg flex items-center gap-2 hover:bg-secondary/10 transition-colors"
                      onClick={() => patch(singing.id, { status: "skipped" })}
                    >
                      <Icon name="skip_next" class="text-[18px]" />
                      Skip
                    </button>
                    <button
                      class="bg-transparent border-2 border-white/20 text-on-surface-variant font-label-caps text-label-caps px-6 py-3 rounded-lg flex items-center gap-2 hover:bg-white/5 transition-colors"
                      onClick={() => patch(singing.id, { status: "accepted" })}
                    >
                      <Icon name="undo" class="text-[18px]" />
                      Back to queue
                    </button>
                    {singing.youtube_url && (
                      <>
                        <button
                          class="ml-auto bg-surface-variant text-on-surface font-label-caps text-label-caps px-4 py-3 rounded-lg flex items-center gap-2 hover:bg-surface-bright transition-colors"
                          onClick={() => openYouTube(singing)}
                        >
                          <Icon name="smart_display" class="text-[18px]" />
                          Open YouTube
                        </button>
                        <button
                          class="bg-surface-variant text-on-surface font-label-caps text-label-caps px-4 py-3 rounded-lg flex items-center gap-2 hover:bg-surface-bright transition-colors"
                          onClick={() => copyUrl(singing)}
                        >
                          <Icon name="content_copy" class="text-[18px]" />
                          Copy URL
                        </button>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <div class="text-center py-md relative z-10">
                  <Icon name="music_off" class="text-on-surface-variant text-5xl" />
                  <p class="font-headline-md text-headline-md text-on-surface mt-2">
                    Nobody on stage
                  </p>
                  <p class="font-body-md text-body-md text-on-surface-variant">
                    Press <kbd class="font-label-caps text-label-caps px-2 py-1 rounded bg-surface-container">N</kbd> to bring up next.
                  </p>
                </div>
              )}
            </section>

            {/* Up next */}
            <section class="glass-panel rounded-xl flex flex-col flex-grow overflow-hidden min-h-0">
              <div class="p-4 border-b border-white/10 flex justify-between items-center bg-surface-container/50">
                <h2 class="font-headline-md text-headline-md text-on-surface">
                  Up Next
                </h2>
                <span class="font-label-caps text-label-caps text-on-surface-variant bg-surface-variant px-3 py-1 rounded-full">
                  {queue.length} queued
                </span>
              </div>
              <div class="flex-grow overflow-y-auto p-2 space-y-2 min-h-0">
                {queue.length === 0 ? (
                  <div class="p-md text-center text-on-surface-variant font-body-md">
                    Queue is empty.
                  </div>
                ) : (
                  queue.map((r, i) => (
                    <div
                      key={r.id}
                      class="queue-item flex items-center gap-4 p-3 rounded-lg transition-colors border border-transparent hover:border-white/10 group"
                    >
                      <span class="material-symbols-outlined text-on-surface-variant opacity-50 group-hover:opacity-100">
                        drag_indicator
                      </span>
                      <div class="w-10 h-10 rounded bg-surface-variant flex items-center justify-center font-label-caps text-label-caps text-primary shrink-0">
                        {String(i + 1).padStart(2, "0")}
                      </div>
                      <div class="flex-grow min-w-0">
                        <h3 class="font-body-lg text-body-lg font-bold text-on-surface truncate">
                          {r.song_title || r.youtube_url}
                        </h3>
                        <p class="font-body-md text-body-md text-on-surface-variant truncate">
                          {r.notes ? `“${r.notes}”` : r.youtube_video_id || "Song name only"}
                        </p>
                      </div>
                      <div class="text-right shrink-0 hidden sm:block">
                        <span class="block font-label-caps text-label-caps text-secondary-fixed">
                          {r.singer_name}
                        </span>
                        <span class="font-label-caps text-label-caps text-on-surface-variant opacity-50">
                          rot #{r.rotation_index}
                        </span>
                      </div>
                      <div class="flex items-center gap-1 shrink-0">
                        <button
                          class="p-2 text-on-surface-variant hover:text-primary transition-colors disabled:opacity-30"
                          onClick={() => move(r, -1)}
                          disabled={i === 0}
                          aria-label="Move up"
                          title="Move up"
                        >
                          <Icon name="arrow_upward" />
                        </button>
                        <button
                          class="p-2 text-on-surface-variant hover:text-primary transition-colors disabled:opacity-30"
                          onClick={() => move(r, 1)}
                          disabled={i === queue.length - 1}
                          aria-label="Move down"
                          title="Move down"
                        >
                          <Icon name="arrow_downward" />
                        </button>
                        <button
                          class="p-2 text-on-surface-variant hover:text-primary transition-colors"
                          onClick={() => patch(r.id, { status: "singing" })}
                          aria-label="Set singing"
                          title="Set singing"
                        >
                          <Icon name="play_arrow" />
                        </button>
                        <button
                          class="p-2 text-on-surface-variant hover:text-error transition-colors"
                          onClick={() => remove(r.id)}
                          aria-label="Remove"
                          title="Remove"
                        >
                          <Icon name="delete" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>

          {/* Right column */}
          <div
            class={`${
              activeTab === "requests" ? "flex" : "hidden md:flex"
            } md:col-span-4 flex-col gap-md min-h-0`}
          >
            <section class="grid grid-cols-2 gap-sm shrink-0">
              <Stat value={stats.singers} label="SINGERS" tone="tertiary" />
              <Stat value={stats.done} label="SONGS DONE" tone="primary" />
            </section>

            <section class="glass-panel rounded-xl flex flex-col flex-grow overflow-hidden border-secondary/30 min-h-0">
              <div class="p-4 border-b border-white/10 flex justify-between items-center bg-surface-container/50">
                <div class="flex items-center gap-2">
                  <h2 class="font-headline-md text-headline-md text-on-surface">
                    Requests
                  </h2>
                  {pending.length > 0 && (
                    <span class="flex h-3 w-3 relative" aria-label="new requests">
                      <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-secondary opacity-75" />
                      <span class="relative inline-flex rounded-full h-3 w-3 bg-secondary" />
                    </span>
                  )}
                </div>
                <span class="font-label-caps text-label-caps text-on-surface-variant">
                  {pending.length}
                </span>
              </div>
              <div class="flex-grow overflow-y-auto p-2 space-y-2 min-h-0">
                {pending.length === 0 ? (
                  <div class="p-md text-center text-on-surface-variant font-body-md">
                    {event.auto_accept
                      ? "Auto-accept is on — new requests go straight to the queue."
                      : "No pending requests."}
                  </div>
                ) : (
                  pending.map((r) => (
                    <div
                      key={r.id}
                      class={`bg-surface-container p-3 rounded-lg ${
                        r.is_duplicate
                          ? "border border-secondary/20 neon-glow-secondary"
                          : "border border-white/5 hover:border-white/20 transition-colors"
                      }`}
                    >
                      <div class="flex justify-between items-start mb-2 gap-2">
                        <div class="min-w-0">
                          <h4 class="font-body-lg text-body-lg font-bold text-on-surface truncate">
                            {r.song_title || r.youtube_url}
                          </h4>
                          <p class="font-body-md text-body-md text-on-surface-variant truncate">
                            {r.youtube_video_id || "Song name only"}
                          </p>
                        </div>
                        {r.is_duplicate && (
                          <span class="font-label-caps text-label-caps text-secondary bg-secondary/10 px-2 py-1 rounded shrink-0">
                            DUP
                          </span>
                        )}
                      </div>
                      {r.notes && (
                        <p class="font-body-md text-sm text-on-surface-variant italic">
                          “{r.notes}”
                        </p>
                      )}
                      <div class="flex justify-between items-center mt-3 gap-2">
                        <span class="font-label-caps text-label-caps text-on-surface-variant truncate">
                          {r.singer_name} · {fmtMinsAgo(r.created_at)}
                        </span>
                        <div class="flex gap-2 shrink-0">
                          <button
                            class="w-8 h-8 rounded bg-error/20 text-error flex items-center justify-center hover:bg-error/40 transition-colors"
                            onClick={() => patch(r.id, { status: "rejected" })}
                            aria-label="Reject"
                            title="Reject"
                          >
                            <Icon name="close" class="text-[18px]" />
                          </button>
                          <button
                            class="w-8 h-8 rounded bg-secondary/20 text-secondary flex items-center justify-center hover:bg-secondary/40 transition-colors"
                            onClick={() => patch(r.id, { status: "accepted" })}
                            aria-label="Approve"
                            title="Approve"
                          >
                            <Icon name="check" class="text-[18px]" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>
      </main>

      {error && (
        <div class="fixed bottom-24 md:bottom-4 left-1/2 -translate-x-1/2 z-50 rounded-lg bg-error-container/80 border border-error/40 text-error px-4 py-2 font-body-md">
          {error}
        </div>
      )}

      {qrOpen && (
        <div
          class="fixed inset-0 z-[80] bg-black/80 backdrop-blur-md p-md flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-label="Guest request QR code"
          onClick={() => setQrOpen(false)}
        >
          <div class="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
            <div class="flex justify-end mb-sm">
              <button
                type="button"
                onClick={() => setQrOpen(false)}
                class="w-10 h-10 rounded-full bg-surface-container text-on-surface flex items-center justify-center border border-white/10 hover:bg-surface-variant transition-colors"
                aria-label="Close QR"
                title="Close QR"
              >
                <Icon name="close" />
              </button>
            </div>
            <RequestQRCode
              guestURL={guestURL}
              eventName={event.name}
              venueName={event.venue_name}
              code={event.code}
              large
            />
          </div>
        </div>
      )}

      {/* Mobile bottom nav */}
      <nav class="md:hidden bg-surface/60 backdrop-blur-xl fixed bottom-0 w-full rounded-t-xl z-40 border-t border-white/10 shadow-[0_-8px_32px_rgba(0,0,0,0.5)] flex justify-around items-center h-20 px-4 pb-safe">
        <TabButton
          icon="dashboard_customize"
          label="DJ Deck"
          active={activeTab === "deck"}
          onClick={() => setActiveTab("deck")}
        />
        <TabButton
          icon="notifications"
          label={`Requests${pending.length ? ` (${pending.length})` : ""}`}
          active={activeTab === "requests"}
          onClick={() => setActiveTab("requests")}
        />
        <TabButton
          icon={event.accepting_requests ? "toggle_on" : "toggle_off"}
          label={event.accepting_requests ? "Accepting" : "Paused"}
          active={false}
          onClick={() => updateEventField("accepting_requests", !event.accepting_requests)}
        />
      </nav>
    </div>
  );
}

function Stat(props: { value: number; label: string; tone: "primary" | "tertiary" }) {
  const cls = props.tone === "tertiary" ? "text-tertiary" : "text-primary";
  return (
    <div class="glass-panel rounded-xl p-4 flex flex-col items-center justify-center text-center">
      <span class={`font-display-lg text-display-lg ${cls}`}>{props.value}</span>
      <span class="font-label-caps text-label-caps text-on-surface-variant mt-1">
        {props.label}
      </span>
    </div>
  );
}

function SidebarLink(props: {
  icon: string;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const baseCls =
    "flex items-center gap-md px-6 py-4 transition-colors text-left w-full";
  if (props.active) {
    return (
      <div class={`${baseCls} bg-primary-container/20 text-primary border-l-4 border-primary`}>
        <Icon name={props.icon} />
        <span class="font-label-caps text-label-caps font-bold">{props.label}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={props.onClick}
      class={`${baseCls} text-on-surface-variant hover:bg-surface-variant/30 hover:text-on-surface`}
    >
      <Icon name={props.icon} />
      <span class="font-label-caps text-label-caps">{props.label}</span>
    </button>
  );
}

function TabButton(props: {
  icon: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class={`flex flex-col items-center justify-center transition-all active:scale-110 duration-200 ${
        props.active
          ? "text-primary font-bold drop-shadow-[0_0_5px_rgba(236,177,255,0.6)]"
          : "text-on-surface-variant/70 hover:text-secondary"
      }`}
    >
      <Icon name={props.icon} fill={props.active} />
      <span class="font-label-caps text-[10px] mt-1">{props.label}</span>
    </button>
  );
}

function Toggle(props: { on: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      onClick={() => props.onChange(!props.on)}
      class={`relative inline-block w-10 h-5 rounded-full transition-colors ${
        props.on ? "bg-primary-container" : "bg-surface-variant"
      }`}
    >
      <span
        class={`absolute top-0.5 ${
          props.on ? "right-0.5" : "left-0.5"
        } w-4 h-4 rounded-full bg-white transition-all`}
      />
    </button>
  );
}
