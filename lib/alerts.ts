// Which failures are NEWS. The watcher seeds its seen-set on first load —
// failures older than the page are history, not news — and only recent,
// unseen, failed sessions alert afterwards.

import type { RunSession } from "./types";

export const ALERT_RECENCY_MS = 10 * 60_000;

export function freshFailures(
  sessions: RunSession[],
  seen: Set<string>,
  now = Date.now(),
): RunSession[] {
  return sessions.filter(
    (s) =>
      s.status === "failed" &&
      !seen.has(s.runId) &&
      now - new Date(s.createdAt).getTime() < ALERT_RECENCY_MS,
  );
}
