import type { Job, JobStatus } from "../types";

const LABEL: Record<JobStatus, string> = {
  queued:   "Queued",
  running:  "Processing",
  done:     "Ready",
  failed:   "Failed",
  canceled: "Canceled",
  paused:   "Paused",
};

const COLOR: Record<JobStatus, string> = {
  queued:   "#94a3b8",
  running:  "#38bdf8",
  done:     "#22c55e",
  failed:   "#ef4444",
  canceled: "#71717a",
  paused:   "#a78bfa",
};

export function JobBadge({ job }: { job: Job }) {
  const pct = Math.round((job.progress || 0) * 100);
  return (
    <span class="job-badge" style={{ color: COLOR[job.status] }}>
      <span class="job-badge__dot" style={{ background: COLOR[job.status] }} />
      {LABEL[job.status]}
      {job.status === "running" && <span class="job-badge__pct"> · {job.stage} {pct}%</span>}
    </span>
  );
}
