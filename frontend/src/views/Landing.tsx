import { useState } from "preact/hooks";
import { api } from "../api";
import type { KaraokeEvent } from "../types";
import { AuraBackground } from "../components/AuraBackground";
import { TopBar } from "../components/TopBar";
import { Icon } from "../components/Icon";
import { RequestQRCode } from "../components/RequestQRCode";
import { SEO } from "../components/SEO";

export function Landing() {
  const [name, setName] = useState("Friday Karaoke");
  const [venueName, setVenueName] = useState("Neon Lounge");
  const [limit, setLimit] = useState(2);
  const [autoAccept, setAutoAccept] = useState(true);
  const [created, setCreated] = useState<KaraokeEvent | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: Event) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const ev = await api.createEvent({
        name: name.trim(),
        venue_name: venueName.trim() || undefined,
        per_singer_limit: limit,
        auto_accept: autoAccept,
      });
      if (ev.host_token) localStorage.setItem(`host_token:${ev.code}`, ev.host_token);
      setCreated(ev);
    } catch (e: any) {
      setErr(e.message ?? "Failed to create event");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="min-h-screen flex flex-col">
      <SEO title="DJClaude - Karaoke Request App for Bar DJs" />
      <AuraBackground />
      <TopBar />
      <main class="flex-grow flex flex-col items-center px-margin-mobile md:px-margin-desktop py-lg relative z-10">
        <div class="w-full max-w-2xl flex flex-col gap-md">
          {created ? <CreatedPanel ev={created} /> : (
            <>
              <div class="text-center mb-md">
                <h1 class="font-display-lg text-display-lg text-on-surface mb-xs drop-shadow-md">
                  Karaoke request app for live DJ nights
                </h1>
                <p class="font-body-md text-body-md text-on-surface-variant">
                  Create an event, share a QR guest link, and manage the song queue from a live host dashboard.
                </p>
              </div>
              <form onSubmit={submit} class="glass-panel-strong rounded-xl p-md md:p-lg flex flex-col gap-md relative overflow-hidden">
                <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary via-tertiary to-secondary" />
                <div class="flex items-center gap-sm mb-sm border-b border-white/10 pb-sm">
                  <Icon name="add_circle" class="text-primary text-3xl drop-shadow-[0_0_8px_rgba(236,177,255,0.6)]" />
                  <h3 class="font-headline-md text-headline-md text-on-surface">New event</h3>
                </div>

                <Field label="Event name" accent="primary">
                  <input
                    class="neon-input"
                    type="text"
                    value={name}
                    onInput={(e) => setName((e.target as HTMLInputElement).value)}
                    placeholder="Friday Karaoke"
                    required
                  />
                </Field>

                <Field label="Venue name" accent="tertiary">
                  <input
                    class="neon-input tertiary"
                    type="text"
                    value={venueName}
                    onInput={(e) => setVenueName((e.target as HTMLInputElement).value)}
                    placeholder="Neon Lounge"
                  />
                </Field>

                <Field label="Per-singer active limit" accent="secondary">
                  <input
                    class="neon-input secondary"
                    type="text"
                    inputMode="numeric"
                    value={String(limit)}
                    onInput={(e) =>
                      setLimit(Math.max(1, Number((e.target as HTMLInputElement).value) || 1))
                    }
                  />
                </Field>

                <label class="flex items-center gap-3 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={autoAccept}
                    onChange={(e) =>
                      setAutoAccept((e.target as HTMLInputElement).checked)
                    }
                    class="w-5 h-5 rounded border-outline-variant bg-surface-container-lowest text-primary-container focus:ring-primary"
                  />
                  <span class="font-body-md text-body-md text-on-surface-variant">
                    Auto-accept new requests (otherwise they wait for your approval)
                  </span>
                </label>

                {err && (
                  <div class="rounded-lg bg-error-container/30 border border-error/40 text-error px-3 py-2 font-body-md text-body-md">
                    {err}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={busy}
                  class="btn-primary mt-sm relative w-full h-14 rounded-lg flex items-center justify-center gap-2 font-headline-md text-headline-md font-bold"
                >
                  <span class="relative z-10 flex items-center gap-2">
                    {busy ? "Creating…" : "Create karaoke night"}
                    <Icon name="bolt" />
                  </span>
                </button>
              </form>

              <p class="text-center font-body-md text-sm text-on-surface-variant/70">
                After you create an event you'll get a guest link to print on the QR
                and a host link for the dashboard.
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Field(props: {
  label: string;
  accent: "primary" | "tertiary" | "secondary";
  children: any;
}) {
  const accentColor =
    props.accent === "primary"
      ? "text-primary drop-shadow-[0_0_4px_rgba(236,177,255,0.4)]"
      : props.accent === "tertiary"
      ? "text-tertiary drop-shadow-[0_0_4px_rgba(0,220,229,0.4)]"
      : "text-secondary drop-shadow-[0_0_4px_rgba(255,177,196,0.4)]";
  return (
    <div class="flex flex-col gap-xs">
      <span class={`font-label-caps text-label-caps uppercase ${accentColor}`}>
        {props.label}
      </span>
      {props.children}
    </div>
  );
}

function CreatedPanel({ ev }: { ev: KaraokeEvent }) {
  const base = location.origin;
  const guestURL = `${base}/r/${ev.code}`;
  const hostURL = `${base}/host/${ev.code}?token=${ev.host_token}`;

  return (
    <div class="glass-panel-strong rounded-xl p-md md:p-lg flex flex-col gap-md relative overflow-hidden">
      <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary via-tertiary to-secondary" />
      <div class="text-center">
        <span class="font-label-caps text-label-caps text-tertiary uppercase">
          You're live
        </span>
        <h2 class="font-display-lg text-display-lg text-on-surface mt-xs neon-text-glow">
          {ev.name}
        </h2>
        <p class="font-body-md text-body-md text-on-surface-variant flex items-center justify-center gap-2 mt-2">
          <Icon name="location_on" fill class="text-tertiary" />
          {ev.venue_name}
        </p>
      </div>

      <div class="flex items-center justify-center gap-2 mt-2">
        <span class="font-label-caps text-label-caps text-on-surface-variant">CODE</span>
        <span class="font-label-caps text-2xl tracking-[0.3em] text-primary px-4 py-2 rounded-lg bg-surface-container-lowest/80 border border-primary/30 neon-glow-primary">
          {ev.code}
        </span>
      </div>

      <RequestQRCode
        guestURL={guestURL}
        eventName={ev.name}
        venueName={ev.venue_name}
        code={ev.code}
      />

      <UrlField label="Guest link" url={guestURL} accent="tertiary" />
      <UrlField label="Host link · keep this secret" url={hostURL} accent="primary" />

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-sm mt-sm">
        <a
          href={hostURL}
          class="btn-primary h-12 rounded-lg flex items-center justify-center gap-2 font-label-caps text-label-caps font-bold"
        >
          <Icon name="dashboard_customize" />
          Open host dashboard
        </a>
        <a
          href={guestURL}
          target="_blank"
          rel="noreferrer"
          class="h-12 rounded-lg flex items-center justify-center gap-2 font-label-caps text-label-caps font-bold bg-transparent border-2 border-tertiary text-tertiary hover:bg-tertiary/10 transition-colors"
        >
          <Icon name="visibility" />
          Preview guest view
        </a>
      </div>
    </div>
  );
}

function UrlField({
  label,
  url,
  accent,
}: {
  label: string;
  url: string;
  accent: "tertiary" | "primary";
}) {
  const accentCls =
    accent === "tertiary"
      ? "text-tertiary drop-shadow-[0_0_4px_rgba(0,220,229,0.4)]"
      : "text-primary drop-shadow-[0_0_4px_rgba(236,177,255,0.4)]";
  return (
    <div class="flex flex-col gap-xs">
      <span class={`font-label-caps text-label-caps uppercase ${accentCls}`}>{label}</span>
      <input
        type="text"
        readOnly
        value={url}
        onFocus={(e) => (e.currentTarget as HTMLInputElement).select()}
        class="neon-input"
      />
    </div>
  );
}
