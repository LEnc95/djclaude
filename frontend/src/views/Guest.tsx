import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../api";
import { connectWS } from "../ws";
import type { KaraokeEvent, KaraokeRequest, PlaybackState, Song, WSEvent } from "../types";
import { AuraBackground } from "../components/AuraBackground";
import { TopBar } from "../components/TopBar";
import { Icon } from "../components/Icon";
import { SEO } from "../components/SEO";
import { KaraokePlayer } from "../components/KaraokePlayer";
import { YouTubeFallbackPlayer } from "../components/YouTubeFallbackPlayer";
import { SongAutocomplete } from "../components/SongAutocomplete";
import { usePlaybackSync } from "../hooks/usePlaybackSync";
import { DEFAULT_LYRICS_STYLE } from "../lyrics/presets";

interface Props {
  code: string;
}

type SubmittedRef = { id: string; created_at: string };

const LS_SINGER = "guest_singer_name";
const lsRequestsKey = (code: string) => `guest_requests:${code}`;

function loadSubmitted(code: string): SubmittedRef[] {
  try {
    const raw = localStorage.getItem(lsRequestsKey(code));
    return raw ? (JSON.parse(raw) as SubmittedRef[]) : [];
  } catch {
    return [];
  }
}
function saveSubmitted(code: string, list: SubmittedRef[]) {
  localStorage.setItem(lsRequestsKey(code), JSON.stringify(list));
}

function thumbURL(videoID?: string) {
  return videoID ? `https://i.ytimg.com/vi/${videoID}/hqdefault.jpg` : "";
}

export function Guest({ code }: Props) {
  const [event, setEvent] = useState<KaraokeEvent | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);
  const [requests, setRequests] = useState<KaraokeRequest[]>([]);
  const [mySubmitted, setMySubmitted] = useState<SubmittedRef[]>(() => loadSubmitted(code));

  const [singer, setSinger] = useState<string>(() => localStorage.getItem(LS_SINGER) ?? "");
  const [song, setSong] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    api.getEvent(code).then(
      (ev) => {
        if (!cancel) setEvent(ev);
      },
      (err) => {
        if (cancel) return;
        if (err instanceof ApiError && err.status === 404) {
          setEventError("This karaoke event doesn't exist.");
        } else {
          setEventError(err.message ?? "Failed to load event");
        }
      }
    );
    const ws = connectWS({ code, onEvent: handleEvent });
    return () => {
      cancel = true;
      ws.close();
    };
  }, [code]);

  // ---- Synced follower player ----
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const [activeSong, setActiveSong] = useState<Song | null>(null);
  const sync = usePlaybackSync({ role: "follower", videoRef: videoElRef });
  const singing = useMemo(() => requests.find((r) => r.status === "singing"), [requests]);
  useEffect(() => {
    if (singing?.song_id) {
      api.getLibrarySong(singing.song_id).then(setActiveSong).catch(() => setActiveSong(null));
    } else {
      setActiveSong(null);
    }
  }, [singing?.song_id]);
  // Pipe playback:state into the sync hook.
  // (handleEvent below routes it via setRemote.)
  // Expose setRemote on a ref for handleEvent to call.
  const setRemoteRef = useRef(sync.setRemote);
  setRemoteRef.current = sync.setRemote;

  function handleEvent(ev: WSEvent) {
    switch (ev.type) {
      case "snapshot":
        setEvent(ev.payload.event);
        setRequests(ev.payload.requests);
        break;
      case "event:updated":
        setEvent(ev.payload);
        break;
      case "playback:state":
        setRemoteRef.current?.(ev.payload as PlaybackState);
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

  const queueReqs = useMemo(
    () =>
      requests.filter((r) => r.status === "accepted" || r.status === "singing"),
    [requests]
  );
  // `singing` is declared earlier (player wiring); reuse.
  const myRequests = useMemo(
    () =>
      mySubmitted
        .map((s) => requests.find((r) => r.id === s.id))
        .filter((r): r is KaraokeRequest => !!r),
    [requests, mySubmitted]
  );
  // Latest "live" request belonging to this guest — drives queue-status mode.
  const myLive = useMemo(
    () =>
      myRequests.find(
        (r) =>
          r.status === "accepted" ||
          r.status === "singing" ||
          r.status === "pending"
      ),
    [myRequests]
  );
  const myPosition = useMemo(() => {
    if (!myLive) return 0;
    const idx = queueReqs.findIndex((r) => r.id === myLive.id);
    return idx >= 0 ? idx + 1 : 0;
  }, [myLive, queueReqs]);

  async function submit(e: Event) {
    e.preventDefault();
    setSubmitError(null);
    if (!event || event.status === "closed" || !event.accepting_requests) {
      setSubmitError("Requests are closed right now.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.createRequest(code, {
        singer_name: singer.trim(),
        song_input: song.trim(),
        notes: notes.trim() || undefined,
      });
      localStorage.setItem(LS_SINGER, singer.trim());
      const nextSubmitted = [
        { id: res.request.id, created_at: res.request.created_at },
        ...mySubmitted,
      ].slice(0, 20);
      setMySubmitted(nextSubmitted);
      saveSubmitted(code, nextSubmitted);
      setSong("");
      setNotes("");
    } catch (err: any) {
      setSubmitError(err.message ?? "Failed to submit");
    } finally {
      setBusy(false);
    }
  }

  async function cancelMyRequest() {
    if (!myLive) return;
    // Guests can't delete via host API; cleanest path is to forget locally.
    const next = mySubmitted.filter((s) => s.id !== myLive.id);
    setMySubmitted(next);
    saveSubmitted(code, next);
  }

  if (eventError) {
    return (
      <div class="min-h-screen flex flex-col">
        <SEO
          title="Karaoke Event Not Found"
          description="This DJClaude karaoke event could not be found."
          canonicalPath="/"
          noindex
        />
        <AuraBackground />
        <TopBar />
        <main class="flex-grow flex items-center justify-center px-margin-mobile">
          <div class="glass-panel rounded-xl p-md text-center max-w-md">
            <Icon name="error" class="text-error text-5xl mb-sm" />
            <p class="font-body-lg text-body-lg">{eventError}</p>
          </div>
        </main>
      </div>
    );
  }

  if (!event) {
    return (
      <div class="min-h-screen flex flex-col">
        <SEO
          title="Loading Karaoke Event"
          description="Loading a private DJClaude karaoke request event."
          canonicalPath="/"
          noindex
        />
        <AuraBackground />
        <TopBar />
        <main class="flex-grow flex items-center justify-center">
          <p class="font-body-md text-on-surface-variant">Loading…</p>
        </main>
      </div>
    );
  }

  const closed = event.status === "closed";
  const notAccepting = !event.accepting_requests && !closed;
  const showQueueStatus = !!myLive && !notAccepting && !closed;

  return (
    <div class="min-h-screen flex flex-col">
      <SEO
        title={`${event.name} Guest Requests`}
        description={`Submit karaoke requests for ${event.name} at ${event.venue_name || "your event"}.`}
        canonicalPath={`/r/${event.code}`}
        noindex
      />
      <AuraBackground />
      <TopBar brand={event.venue_name || "Neon Lounge"} />

      <main class="flex-grow flex flex-col w-full max-w-4xl mx-auto px-margin-mobile md:px-margin-desktop py-lg gap-lg pb-24">
        {/* Synced now-playing panel — muted local <video> so the guest sees */}
        {/* lyrics on their phone without having to look at the host's screen. */}
        {singing && (
          <section class="w-full">
            {!singing.song_id && singing.youtube_video_id ? (
              <YouTubeFallbackPlayer videoID={singing.youtube_video_id} mode="guest" />
            ) : (
              <KaraokePlayer
                song={activeSong}
                mode="guest"
                lyricsStyle={DEFAULT_LYRICS_STYLE}
                autoPlay={true}
                onVideoRef={(v) => { videoElRef.current = v; }}
              />
            )}
          </section>
        )}
        {closed && (
          <Banner icon="block" tone="error">
            Karaoke is closed for tonight. See you next time!
          </Banner>
        )}
        {notAccepting && (
          <Banner icon="pause" tone="warn">
            The DJ has paused new requests. Hang tight!
          </Banner>
        )}

        {showQueueStatus ? (
          <QueueStatus
            event={event}
            myReq={myLive!}
            position={myPosition}
            singing={singing}
            queueReqs={queueReqs}
            onCancel={cancelMyRequest}
          />
        ) : (
          <SubmitForm
            event={event}
            singer={singer}
            setSinger={setSinger}
            song={song}
            setSong={setSong}
            notes={notes}
            setNotes={setNotes}
            busy={busy}
            submitError={submitError}
            disabled={closed || notAccepting}
            onSubmit={submit}
          />
        )}

        {!showQueueStatus && queueReqs.length > 0 && (
          <section class="glass-panel rounded-xl p-md flex flex-col gap-sm">
            <h3 class="font-headline-md text-headline-md flex items-center gap-sm">
              <Icon name="format_list_numbered" class="text-primary" />
              Up Next
            </h3>
            <ul class="flex flex-col gap-2">
              {queueReqs.slice(0, 5).map((r, i) => (
                <li
                  key={r.id}
                  class={`flex items-center gap-3 p-2 rounded-lg ${
                    r.status === "singing"
                      ? "bg-secondary/10 border border-secondary/30"
                      : "bg-surface-container-highest/40"
                  }`}
                >
                  <span class="font-label-caps text-label-caps text-on-surface-variant w-6 text-center">
                    {r.status === "singing" ? "🎤" : `#${i + 1}`}
                  </span>
                  <div class="flex-grow min-w-0">
                    <div class="font-body-md text-body-md font-bold text-on-surface truncate">
                      {r.singer_name}
                    </div>
                    <div class="font-body-md text-sm text-on-surface-variant truncate">
                      {r.song_title || r.youtube_url}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}

function Banner({
  icon,
  tone,
  children,
}: {
  icon: string;
  tone: "error" | "warn";
  children: any;
}) {
  const cls =
    tone === "error"
      ? "border-error/40 bg-error-container/30 text-error"
      : "border-secondary/40 bg-secondary/10 text-secondary";
  return (
    <div class={`rounded-xl border ${cls} px-4 py-3 flex items-center gap-3 font-body-md text-body-md`}>
      <Icon name={icon} />
      <span>{children}</span>
    </div>
  );
}

function SubmitForm(props: {
  event: KaraokeEvent;
  singer: string;
  setSinger: (s: string) => void;
  song: string;
  setSong: (s: string) => void;
  notes: string;
  setNotes: (s: string) => void;
  busy: boolean;
  submitError: string | null;
  disabled: boolean;
  onSubmit: (e: Event) => void;
}) {
  const { event, singer, setSinger, song, setSong, notes, setNotes, busy, submitError, disabled, onSubmit } = props;
  return (
    <>
      <div class="text-center">
        <h2 class="font-display-lg text-display-lg text-on-surface drop-shadow-md">
          {event.name}
        </h2>
        <p class="font-body-md text-body-md text-on-surface-variant flex items-center justify-center gap-2 mt-2">
          <Icon name="location_on" fill class="text-tertiary" />
          Live at {event.venue_name}
        </p>
      </div>

      <form onSubmit={onSubmit} class="glass-panel-strong rounded-xl p-md md:p-lg flex flex-col gap-md relative overflow-hidden">
        <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary via-tertiary to-secondary" />
        <div class="flex items-center gap-sm mb-sm border-b border-white/10 pb-sm">
          <Icon name="add_circle" class="text-primary text-3xl drop-shadow-[0_0_8px_rgba(236,177,255,0.6)]" />
          <h3 class="font-headline-md text-headline-md text-on-surface">
            Submit Request
          </h3>
        </div>

        <Field label="Singer Name *" accent="primary">
          <input
            class="neon-input"
            type="text"
            required
            placeholder="Who is taking the stage?"
            value={singer}
            onInput={(e) => setSinger((e.target as HTMLInputElement).value)}
            autoComplete="name"
            inputMode="text"
          />
        </Field>

        <Field label="Song Title or YouTube URL *" accent="tertiary">
          <div class="relative">
            <Icon
              name="search"
              class="absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none z-10"
            />
            <SongAutocomplete
              className="neon-input tertiary pl-12"
              placeholder="Start typing — we'll search the library"
              value={song}
              onChange={setSong}
            />
          </div>
        </Field>

        <Field label="Notes (Optional)" accent="muted">
          <textarea
            class="neon-input secondary resize-none"
            rows={2}
            placeholder="e.g. Lower the key, singing with Sarah"
            value={notes}
            onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
          />
        </Field>

        {submitError && (
          <div class="rounded-lg bg-error-container/30 border border-error/40 text-error px-3 py-2 font-body-md text-body-md">
            {submitError}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || disabled}
          class="btn-primary mt-sm relative w-full h-14 rounded-lg flex items-center justify-center gap-2 font-headline-md text-headline-md font-bold"
        >
          <span class="relative z-10 flex items-center gap-2">
            {busy ? "Sending…" : "Send Request"}
            <Icon name="send" />
          </span>
        </button>
      </form>

      <p class="text-center font-body-md text-sm text-on-surface-variant/70">
        Your request will be sent to the DJ booth. Keep an eye on the screens!
      </p>
    </>
  );
}

function Field(props: {
  label: string;
  accent: "primary" | "tertiary" | "secondary" | "muted";
  children: any;
}) {
  const accentCls =
    props.accent === "primary"
      ? "text-primary drop-shadow-[0_0_4px_rgba(236,177,255,0.4)]"
      : props.accent === "tertiary"
      ? "text-tertiary drop-shadow-[0_0_4px_rgba(0,220,229,0.4)]"
      : props.accent === "secondary"
      ? "text-secondary drop-shadow-[0_0_4px_rgba(255,177,196,0.4)]"
      : "text-on-surface-variant";
  return (
    <div class="flex flex-col gap-xs">
      <span class={`font-label-caps text-label-caps uppercase ${accentCls}`}>
        {props.label}
      </span>
      {props.children}
    </div>
  );
}

function QueueStatus(props: {
  event: KaraokeEvent;
  myReq: KaraokeRequest;
  position: number;
  singing: KaraokeRequest | undefined;
  queueReqs: KaraokeRequest[];
  onCancel: () => void;
}) {
  const { event, myReq, position, singing, queueReqs, onCancel } = props;
  const upNext = queueReqs
    .filter((r) => r.status === "accepted" && r.id !== myReq.id)
    .slice(0, 2);
  const songName = myReq.song_title || myReq.youtube_url;
  const isSinging = myReq.status === "singing";

  return (
    <>
      {/* Hero */}
      <section class="flex flex-col items-center text-center gap-md">
        <div class="w-24 h-24 rounded-full bg-primary/20 border-2 border-primary flex items-center justify-center pulse-border mb-sm">
          <Icon
            name={isSinging ? "mic" : "hourglass_top"}
            fill
            class="text-primary text-5xl"
          />
        </div>
        <h2 class="font-display-lg text-display-lg text-on-background neon-text-glow">
          {isSinging ? "You're on stage!" : "You're in the Queue!"}
        </h2>
        <div class="glass-panel rounded-xl p-md inline-flex flex-col items-center gap-sm min-w-[280px]">
          <span class="font-label-caps text-label-caps text-on-surface-variant uppercase tracking-widest">
            Current Position
          </span>
          <span class="font-display-lg text-display-lg text-secondary">
            #{position || "—"}
          </span>
          <div class="flex items-center gap-xs mt-xs">
            <span class="w-2 h-2 rounded-full bg-tertiary animate-pulse" />
            <span class="font-body-md text-body-md text-tertiary capitalize">
              {myReq.status}
              {myReq.status === "pending" ? " · DJ is reviewing" : ""}
            </span>
          </div>
        </div>
      </section>

      {/* Bento: my request + live stage */}
      <section class="grid grid-cols-1 md:grid-cols-2 gap-gutter">
        <div class="glass-panel rounded-xl p-md flex flex-col gap-md relative overflow-hidden">
          <div class="absolute -top-10 -right-10 w-32 h-32 bg-primary/10 rounded-full blur-3xl pointer-events-none" />
          <h3 class="font-headline-md text-headline-md text-on-surface flex items-center gap-sm">
            <Icon name="person_play" class="text-primary" />
            Your Request
          </h3>
          <div class="bg-surface-container-highest/50 rounded-lg p-sm flex items-center gap-md border border-white/5">
            <div class="w-16 h-16 rounded-md overflow-hidden bg-surface-variant shrink-0 flex items-center justify-center">
              {myReq.youtube_video_id ? (
                <img
                  src={thumbURL(myReq.youtube_video_id)}
                  alt=""
                  class="w-full h-full object-cover"
                />
              ) : (
                <Icon name="music_note" class="text-on-surface-variant text-3xl" />
              )}
            </div>
            <div class="flex flex-col min-w-0">
              <span class="font-headline-md text-headline-md text-on-background line-clamp-1">
                {songName}
              </span>
              {myReq.notes && (
                <span class="font-body-md text-body-md text-on-surface-variant italic">
                  “{myReq.notes}”
                </span>
              )}
            </div>
          </div>
          <div class="flex justify-between items-center mt-auto pt-sm border-t border-white/5">
            <span class="font-label-caps text-label-caps text-on-surface-variant">
              Requested by
            </span>
            <span class="font-body-md text-body-md text-on-surface">
              {myReq.singer_name}
            </span>
          </div>
        </div>

        <div class="glass-panel rounded-xl p-md flex flex-col gap-md relative overflow-hidden">
          <div class="absolute -top-10 -left-10 w-32 h-32 bg-secondary/10 rounded-full blur-3xl pointer-events-none" />
          <div class="flex justify-between items-center">
            <h3 class="font-headline-md text-headline-md text-on-surface flex items-center gap-sm">
              <Icon name="mic" class="text-secondary" />
              On Stage Now
            </h3>
            <span class="px-2 py-1 rounded bg-error/20 text-error font-label-caps text-[10px] animate-pulse">
              LIVE
            </span>
          </div>
          {singing ? (
            <div class="bg-surface-container-highest/80 rounded-lg p-sm flex items-center gap-md border border-secondary/30 neon-glow-secondary">
              <div class="w-10 h-10 rounded-full bg-secondary/20 flex items-center justify-center shrink-0">
                <Icon name="music_note" class="text-secondary" />
              </div>
              <div class="flex flex-col flex-1 min-w-0">
                <span class="font-body-md text-body-md font-bold text-on-background truncate">
                  {singing.singer_name}
                </span>
                <span class="font-body-md text-[14px] text-on-surface-variant truncate">
                  {singing.song_title || singing.youtube_url}
                </span>
              </div>
              <Icon name="graphic_eq" class="text-on-surface-variant opacity-50" />
            </div>
          ) : (
            <div class="rounded-lg p-sm border border-dashed border-white/10 text-center text-on-surface-variant font-body-md text-body-md">
              Stage is open — DJ will start the next song soon.
            </div>
          )}

          {upNext.length > 0 && (
            <div class="pl-md border-l-2 border-white/10 flex flex-col gap-xs mt-xs">
              <span class="font-label-caps text-[10px] text-on-surface-variant uppercase">
                Up Next
              </span>
              {upNext.map((r, i) => (
                <div
                  key={r.id}
                  class={`flex justify-between items-center ${i > 0 ? "opacity-70" : ""}`}
                >
                  <span class="font-body-md text-[14px] text-on-surface truncate pr-2">
                    {r.singer_name} · {r.song_title || r.youtube_url}
                  </span>
                  <span class="font-label-caps text-[10px] text-on-surface-variant">
                    #{i + 1 + (singing ? 1 : 0)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <div class="flex justify-center mt-md">
        <button
          type="button"
          onClick={onCancel}
          class="bg-surface/40 hover:bg-surface-variant/60 border border-primary/50 text-primary font-label-caps text-label-caps px-md py-sm rounded-full flex items-center gap-xs transition-colors backdrop-blur-md"
        >
          <Icon name="cancel" class="text-[18px]" />
          Hide from my view
        </button>
      </div>

      <p class="text-center font-body-md text-sm text-on-surface-variant/70">
        Tip: this page updates live as the queue moves. Keep it open!
      </p>
      <p class="text-center font-body-md text-xs text-on-surface-variant/50">
        Event code: <span class="font-label-caps">{event.code}</span>
      </p>
    </>
  );
}
