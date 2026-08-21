// Reliability figures for the runs charts, computed from the sessions the
// page already fetched. Median, not mean — one hung run shouldn't move it.

import type { RunSession } from "./types";

export type RunHealth = {
  failed: number;
  cancelled: number;
  completed: number;
  rate: number;
  medianMs: number | null;
};

export function runHealth(sessions: RunSession[]): RunHealth {
  const failed = sessions.filter((s) => s.status === "failed").length;
  const cancelled = sessions.filter((s) => s.status === "cancelled").length;
  const durations = sessions
    .map((s) => s.durationMs)
    .filter((d): d is number => typeof d === "number" && Number.isFinite(d) && d >= 0)
    .sort((a, b) => a - b);
  return {
    failed,
    cancelled,
    completed: sessions.length - failed - cancelled,
    rate: sessions.length ? Math.round((failed / sessions.length) * 100) : 0,
    medianMs: durations.length ? (durations[Math.floor(durations.length / 2)] ?? null) : null,
  };
}
