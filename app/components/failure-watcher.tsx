"use client";

// Watches production runs of the agent in view and raises a toast — plus an
// optional webhook relay — when one fails. Mounted once in the layout, outside
// the Shell, reading the project from the URL like every other route-adaptive
// piece. One 60s poll for the page you're on; a local dashboard watching every
// project forever would be a hosted service, not a dev tool.

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { toast } from "@/components/ui/toast";
import { getJson } from "@/lib/fetch";
import { freshFailures } from "@/lib/alerts";
import type { RunSession } from "@/lib/types";

export default function FailureWatcher() {
  const pathname = usePathname();
  const q = useSearchParams();
  const project = q.get("project") ?? "";
  // Run details are about one run; nothing to watch there.
  const active = project && !pathname.startsWith("/run/");

  // First load only seeds the seen-set — everything already failed before the
  // page opened is history, not news.
  const seen = useRef<Set<string> | null>(null);
  const webhook = useRef<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => {
        webhook.current =
          typeof s?.alertWebhook === "string" && s.alertWebhook ? s.alertWebhook : null;
      })
      .catch(() => {});
  }, []);

  useSWR(
    active
      ? `/api/runs?project=${encodeURIComponent(project)}&environment=production&period=1h`
      : null,
    async (url: string): Promise<{ sessions?: RunSession[] }> => {
      const d: { sessions?: RunSession[] } = await getJson(url);
      const fresh = freshFailures(d.sessions ?? [], seen.current ?? new Set());
      if (seen.current === null) {
        seen.current = new Set((d.sessions ?? []).map((s) => s.runId));
        return d;
      }
      for (const s of fresh) {
        seen.current.add(s.runId);
        toast.add({
          title: `${project} failed on production`,
          description: s.title,
          actionProps: {
            children: "View run",
            onClick: () =>
              window.location.assign(
                `/run/${s.runId}?environment=production&project=${encodeURIComponent(project)}`,
              ),
          },
        });
        if (webhook.current)
          fetch("/api/alert", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ runId: s.runId, title: s.title }),
          }).catch(() => {});
      }
      return d;
    },
    { refreshInterval: 60_000, revalidateOnFocus: false },
  );

  return null;
}
