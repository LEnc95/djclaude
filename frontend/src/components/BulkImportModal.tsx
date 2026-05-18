import { useEffect, useState } from "preact/hooks";
import { api } from "../api";

interface Props {
  adminToken: string;
  onClose: () => void;
  onQueued: (info: { queued: number; skipped: number; total: number }) => void;
}

type Mode = "artist" | "year" | "search";

export function BulkImportModal(props: Props) {
  const [mode, setMode] = useState<Mode>("artist");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(25);
  const [priority, setPriority] = useState(0);
  const [source, setSource] = useState<string>("musicbrainz");
  const [sources, setSources] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listImportSources(props.adminToken)
      .then((r) => setSources(r.sources))
      .catch(() => {});
  }, []);

  async function onSubmit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let result: { queued: number; skipped: number; total: number };
      if (mode === "artist") {
        result = await api.importArtist({ query, limit, priority }, props.adminToken);
      } else if (mode === "year") {
        result = await api.importYear({ query, source: source || undefined, limit, priority }, props.adminToken);
      } else {
        result = await api.importGeneric({ source, query, limit, priority }, props.adminToken);
      }
      props.onQueued(result);
      props.onClose();
    } catch (err: any) {
      setError(err?.message ?? "import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <form class="modal" onClick={(e) => e.stopPropagation()} onSubmit={onSubmit}>
        <h2>Bulk import</h2>
        <div class="modal__tabs">
          {(["artist", "year", "search"] as Mode[]).map((m) => (
            <button
              type="button"
              key={m}
              class={`modal__tab ${mode === m ? "modal__tab--active" : ""}`}
              onClick={() => setMode(m)}
            >{m}</button>
          ))}
        </div>

        {mode === "artist" && (
          <label>
            Artist
            <input
              value={query}
              placeholder="Fleetwood Mac"
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              autoFocus
            />
            <small>Uses MusicBrainz to fetch the artist's discography.</small>
          </label>
        )}
        {mode === "year" && (
          <>
            <label>
              Year
              <input
                value={query}
                placeholder="1985"
                onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
                autoFocus
              />
              <small>Pulls the Billboard Year-End Hot 100 from Wikipedia.</small>
            </label>
            {sources.includes("spotify") && (
              <label>
                Source
                <select value={source} onChange={(e) => setSource((e.target as HTMLSelectElement).value)}>
                  <option value="wikipedia">Wikipedia (Billboard year-end)</option>
                  <option value="spotify">Spotify (year:N search)</option>
                </select>
              </label>
            )}
          </>
        )}
        {mode === "search" && (
          <>
            <label>
              Source
              <select value={source} onChange={(e) => setSource((e.target as HTMLSelectElement).value)}>
                {sources.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label>
              Query
              <input
                value={query}
                placeholder="80s rock anthems"
                onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              />
            </label>
          </>
        )}

        <div class="modal__row">
          <label>
            Limit
            <input
              type="number" min={1} max={100} value={limit}
              onInput={(e) => setLimit(Number((e.target as HTMLInputElement).value))}
            />
          </label>
          <label>
            Priority
            <input
              type="number" value={priority}
              onInput={(e) => setPriority(Number((e.target as HTMLInputElement).value))}
            />
          </label>
        </div>

        {error && <div class="modal__error">{error}</div>}
        <div class="modal__actions">
          <button type="button" onClick={props.onClose} disabled={busy}>Cancel</button>
          <button type="submit" disabled={busy || !query.trim()}>
            {busy ? "Queueing…" : "Queue import"}
          </button>
        </div>
      </form>
    </div>
  );
}
