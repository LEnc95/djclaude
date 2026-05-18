import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import type { AppSettings, ImportBatch, Job, LyricsStyle, Song } from "../types";
import { useAdminAuth } from "../hooks/useAdminAuth";
import { useJobs } from "../hooks/useJobs";
import { AdminLogin } from "../components/AdminLogin";
import { JobBadge } from "../components/JobBadge";
import { BulkImportModal } from "../components/BulkImportModal";
import { LyricsStyleEditor } from "../components/LyricsStyleEditor";
import { DEFAULT_LYRICS_STYLE } from "../lyrics/presets";

type Tab = "library" | "queue" | "imports" | "player" | "settings" | "deploy";

export function Admin() {
  const auth = useAdminAuth();
  const [tab, setTab] = useState<Tab>("queue");

  if (auth.loading && !auth.user) {
    return <div class="admin-shell">Loading…</div>;
  }
  if (!auth.user) {
    return (
      <div class="admin-shell">
        <AdminLogin onLoggedIn={() => { /* useAdminAuth re-renders */ }} />
      </div>
    );
  }

  return (
    <div class="admin-shell">
      <header class="admin-header">
        <h1>Karaoke Forever Pro · Admin</h1>
        <div class="admin-header__user">
          <span>{auth.user.username}</span>
          <button onClick={() => auth.logout()}>Sign out</button>
        </div>
      </header>
      <nav class="admin-tabs">
        {(["queue", "library", "imports", "player", "settings", "deploy"] as Tab[]).map((t) => (
          <button
            key={t}
            class={`admin-tab ${tab === t ? "is-active" : ""}`}
            onClick={() => setTab(t)}
          >{t}</button>
        ))}
      </nav>
      <main class="admin-main">
        {tab === "queue" && <QueueTab adminToken={auth.token!} />}
        {tab === "library" && <LibraryTab adminToken={auth.token!} />}
        {tab === "imports" && <ImportsTab adminToken={auth.token!} />}
        {tab === "player" && <PlayerTab adminToken={auth.token!} />}
        {tab === "settings" && <SettingsTab adminToken={auth.token!} />}
        {tab === "deploy" && <DeployTab adminToken={auth.token!} />}
      </main>
    </div>
  );
}

// =========================================================================
// Queue tab — pending/running/failed jobs + quick "enqueue from URL"
// =========================================================================

function QueueTab({ adminToken }: { adminToken: string }) {
  const { jobs, error } = useJobs(adminToken);
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  async function enqueue(e: Event) {
    e.preventDefault();
    if (!url.trim()) return;
    setAdding(true);
    try {
      const res = await api.createJob({ youtube_url: url.trim() }, adminToken);
      if ("already_processed" in res) {
        setFlash(`Already in library (song ${res.song_id.slice(0, 8)}).`);
      } else {
        setFlash(`Queued job ${res.id.slice(0, 8)}.`);
      }
      setUrl("");
    } catch (err: any) {
      setFlash(`Error: ${err?.message ?? "failed"}`);
    } finally {
      setAdding(false);
    }
  }

  const running = jobs.filter((j) => j.status === "running");
  const queued = jobs.filter((j) => j.status === "queued");
  const failed = jobs.filter((j) => j.status === "failed");

  return (
    <div class="queue-tab">
      <section class="card">
        <h2>Add to queue</h2>
        <form onSubmit={enqueue}>
          <input
            value={url}
            placeholder="YouTube URL"
            onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
          />
          <button type="submit" disabled={adding || !url.trim()}>
            {adding ? "Queueing…" : "Queue"}
          </button>
          <button type="button" onClick={() => setShowImport(true)}>Bulk import…</button>
        </form>
        {flash && <div class="flash">{flash}</div>}
      </section>

      {showImport && (
        <BulkImportModal
          adminToken={adminToken}
          onClose={() => setShowImport(false)}
          onQueued={(r) => setFlash(`Queued ${r.queued}, skipped ${r.skipped} of ${r.total}.`)}
        />
      )}

      <section class="card">
        <h2>Now processing ({running.length})</h2>
        {running.length === 0 ? <p class="muted">Idle.</p> : (
          <ul class="job-list">
            {running.map((j) => <JobRow key={j.id} job={j} adminToken={adminToken} />)}
          </ul>
        )}
      </section>

      <section class="card">
        <h2>Queued ({queued.length})</h2>
        {queued.length === 0 ? <p class="muted">Empty.</p> : (
          <ul class="job-list">
            {queued.map((j) => <JobRow key={j.id} job={j} adminToken={adminToken} />)}
          </ul>
        )}
      </section>

      <section class="card">
        <h2>Failed ({failed.length})</h2>
        {failed.length === 0 ? <p class="muted">None.</p> : (
          <ul class="job-list">
            {failed.map((j) => <JobRow key={j.id} job={j} adminToken={adminToken} />)}
          </ul>
        )}
      </section>

      {error && <div class="error">Polling error: {error}</div>}
    </div>
  );
}

function JobRow({ job, adminToken }: { job: Job; adminToken: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <li class="job-row">
      <div class="job-row__main">
        <div class="job-row__title">
          {job.artist_hint || job.title_hint ? (
            <>
              <strong>{job.title_hint || "(unknown)"}</strong>
              {job.artist_hint && <span> — {job.artist_hint}</span>}
            </>
          ) : (
            <code>{job.youtube_url}</code>
          )}
        </div>
        <JobBadge job={job} />
      </div>
      {job.error && <div class="job-row__error">{job.error}</div>}
      <div class="job-row__actions">
        {(job.status === "failed" || job.status === "canceled") && (
          <button disabled={busy} onClick={async () => {
            setBusy(true);
            await api.retryJob(job.id, adminToken).catch(() => {});
            setBusy(false);
          }}>Retry</button>
        )}
        {(job.status === "queued" || job.status === "running") && (
          <button disabled={busy} onClick={async () => {
            setBusy(true);
            await api.cancelJob(job.id, adminToken).catch(() => {});
            setBusy(false);
          }}>Cancel</button>
        )}
        {job.status === "queued" && (
          <button disabled={busy} onClick={async () => {
            setBusy(true);
            await api.setJobPriority(job.id, job.priority + 10, adminToken).catch(() => {});
            setBusy(false);
          }}>↑ Priority</button>
        )}
      </div>
    </li>
  );
}

// =========================================================================
// Library tab — searchable list of processed songs
// =========================================================================

function LibraryTab({ adminToken }: { adminToken: string }) {
  const [q, setQ] = useState("");
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const list = await api.listLibrary({ q, limit: 200 });
      setSongs(list);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { refresh(); }, [q]);

  async function del(id: string) {
    if (!confirm("Delete this song from the library? Files will be removed.")) return;
    await api.deleteLibrarySong(id, adminToken);
    refresh();
  }

  return (
    <div>
      <section class="card">
        <input
          placeholder="Search title or artist…"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        />
        {loading && <span class="muted"> Loading…</span>}
      </section>
      <section class="card">
        <table class="library-table">
          <thead>
            <tr><th>Title</th><th>Artist</th><th>Year</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {songs.map((s) => (
              <tr key={s.id}>
                <td>{s.title}</td>
                <td>{s.artist}</td>
                <td>{s.year ?? ""}</td>
                <td><span class={`song-status song-status--${s.status}`}>{s.status}</span></td>
                <td><button onClick={() => del(s.id)}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {songs.length === 0 && !loading && <p class="muted">No songs yet.</p>}
      </section>
    </div>
  );
}

// =========================================================================
// Imports tab — recent batches with completion progress
// =========================================================================

function ImportsTab({ adminToken }: { adminToken: string }) {
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const b = await api.listBatches(adminToken).catch(() => []);
      if (alive) setBatches(b);
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <section class="card">
      <h2>Recent imports</h2>
      {batches.length === 0 ? <p class="muted">No bulk imports yet.</p> : (
        <table class="library-table">
          <thead>
            <tr><th>Source</th><th>Query</th><th>Progress</th><th>Created</th></tr>
          </thead>
          <tbody>
            {batches.map((b) => {
              const done = b.completed + b.failed;
              const pct = b.total === 0 ? 0 : Math.round((done / b.total) * 100);
              return (
                <tr key={b.id}>
                  <td>{b.kind}</td>
                  <td>{b.query}</td>
                  <td>
                    {done}/{b.total} ({pct}%)
                    {b.failed > 0 && <span class="error"> · {b.failed} failed</span>}
                  </td>
                  <td>{new Date(b.created_at).toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

// =========================================================================
// Player tab — live lyrics style editor with preview
// =========================================================================

function PlayerTab({ adminToken }: { adminToken: string }) {
  const [style, setStyle] = useState<LyricsStyle | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getSettings(adminToken).then((s) => {
      setStyle(s.player_lyrics_style ?? DEFAULT_LYRICS_STYLE);
    });
  }, []);

  async function save() {
    if (!style) return;
    setSaving(true);
    try {
      await api.updateSettings({ player_lyrics_style: style }, adminToken);
    } finally {
      setSaving(false);
    }
  }

  if (!style) return <p>Loading…</p>;

  return (
    <section class="card">
      <h2>Lyrics style</h2>
      <LyricsStyleEditor value={style} onChange={setStyle} />
      <div class="lyrics-preview" style={{
        background: "#1a1a2a",
        height: 220,
        marginTop: 16,
        display: "flex",
        alignItems: "center",
        justifyContent: style.textAlign === "left" ? "flex-start" : style.textAlign === "right" ? "flex-end" : "center",
        padding: "0 32px",
      }}>
        <span style={{
          fontFamily: style.fontFamily,
          fontSize: style.fontSize * 0.6,
          fontWeight: style.fontWeight,
          fontStyle: style.fontStyle,
          textTransform: style.uppercase ? "uppercase" : "none",
          letterSpacing: `${style.letterSpacing}px`,
          color: style.textColor,
          textShadow: style.shadowEnabled
            ? `0 0 ${style.shadowBlur}px rgba(0,0,0,${style.shadowOpacity})`
            : "none",
        }}>
          The quick brown fox{" "}
          <span style={{ color: style.activeColor }}>jumps</span>
          {" "}over the lazy dog
        </span>
      </div>
      <button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
    </section>
  );
}

// =========================================================================
// Settings tab — VPS, notifications, auto-enqueue
// =========================================================================

function SettingsTab({ adminToken }: { adminToken: string }) {
  const [s, setS] = useState<AppSettings | null>(null);
  const [vpsKey, setVpsKey] = useState("");
  const [slack, setSlack] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { api.getSettings(adminToken).then(setS); }, []);
  if (!s) return <p>Loading…</p>;

  async function save() {
    setSaving(true);
    try {
      const u = await api.updateSettings({
        ...s,
        vps_ssh_key: vpsKey || undefined,
        notify_slack_webhook: slack || undefined,
      }, adminToken);
      setS(u);
      setVpsKey(""); setSlack("");
    } finally { setSaving(false); }
  }

  function up<K extends keyof AppSettings>(k: K, v: AppSettings[K]) {
    setS({ ...s!, [k]: v });
  }

  return (
    <section class="card">
      <h2>VPS deploy</h2>
      <label>Host <input value={s.vps_host} onInput={(e) => up("vps_host", (e.target as HTMLInputElement).value)} /></label>
      <label>User <input value={s.vps_user} onInput={(e) => up("vps_user", (e.target as HTMLInputElement).value)} /></label>
      <label>Target path <input value={s.vps_path} onInput={(e) => up("vps_path", (e.target as HTMLInputElement).value)} /></label>
      <label>rsync options <input value={s.vps_rsync_opts} onInput={(e) => up("vps_rsync_opts", (e.target as HTMLInputElement).value)} /></label>
      <label>SSH private key {s.vps_ssh_key_set ? "(set)" : "(unset)"}
        <textarea rows={4} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          value={vpsKey} onInput={(e) => setVpsKey((e.target as HTMLTextAreaElement).value)} />
        <small>Leave empty to keep the existing key.</small>
      </label>

      <h2>Notifications</h2>
      <label>Email <input value={s.notify_email} onInput={(e) => up("notify_email", (e.target as HTMLInputElement).value)} /></label>
      <label>Slack webhook {s.notify_slack_set ? "(set)" : "(unset)"}
        <input placeholder="https://hooks.slack.com/services/..." value={slack}
          onInput={(e) => setSlack((e.target as HTMLInputElement).value)} />
      </label>

      <h2>Processing</h2>
      <label class="lyrics-editor__check">
        <input type="checkbox" checked={s.auto_enqueue_on_fallback}
          onChange={(e) => up("auto_enqueue_on_fallback", (e.target as HTMLInputElement).checked)} />
        Auto-enqueue songs played via YouTube fallback
      </label>
      <label>Worker concurrency
        <input type="number" min={1} max={8} value={s.worker_concurrency}
          onInput={(e) => up("worker_concurrency", Number((e.target as HTMLInputElement).value))} />
      </label>

      <button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
    </section>
  );
}

// =========================================================================
// Deploy tab — triggers the rsync script via /api/deploy (TODO server-side)
// =========================================================================

function DeployTab({ adminToken }: { adminToken: string }) {
  const [s, setS] = useState<AppSettings | null>(null);
  useEffect(() => { api.getSettings(adminToken).then(setS); }, []);
  return (
    <section class="card">
      <h2>Deploy to VPS</h2>
      {!s ? <p>Loading…</p> : (
        !s.vps_host ? <p class="muted">Set VPS host in Settings tab first.</p> : (
          <>
            <p>Target: <code>{s.vps_user}@{s.vps_host}:{s.vps_path}</code></p>
            <p class="muted">
              Use <code>./scripts/deploy-to-vps.sh</code> on the host running this app.
              The script rsyncs <code>media/</code> + <code>karaoke.db</code> and
              restarts the remote Docker Compose stack.
            </p>
          </>
        )
      )}
    </section>
  );
}
