import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import type { Job, JobStatus } from "../types";

// useJobs: polls /api/jobs every `intervalMs`. Cheap; admin page only.
export function useJobs(adminToken: string | null, statuses?: JobStatus[], intervalMs = 2000) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!adminToken) return;
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const j = await api.listJobs({ status: statuses, limit: 200 }, adminToken);
        if (alive) {
          setJobs(j);
          setError(null);
        }
      } catch (e: any) {
        if (alive) setError(e?.message ?? "failed");
      }
      if (alive) timer = window.setTimeout(tick, intervalMs);
    };
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [adminToken, statuses?.join(","), intervalMs]);

  return { jobs, error };
}
