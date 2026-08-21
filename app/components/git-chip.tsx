"use client";

// Branch state for the selected checkout, in the topbar. Loads on open —
// never polled, a git call is a subprocess and those don't belong on timers.
// The popover is the whole feature: what changed, one message field, push.

import { useState } from "react";
import useSWR from "swr";
import { GitBranch } from "vercel-geist-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { toast } from "@/components/ui/toast";
import { fetchJson, getJson as fetcher } from "@/lib/fetch";

type GitState = {
  repo?: boolean;
  branch?: string | null;
  upstream?: boolean;
  ahead?: number;
  changed?: number;
};

export default function GitChip({ project }: { project: string }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Keyed on open so each open re-reads state; no interval, ever.
  const { data, error, mutate } = useSWR<GitState>(
    open ? `/api/git?project=${encodeURIComponent(project)}` : null,
    fetcher,
    { revalidateOnFocus: false },
  );

  if (!open || error || !data?.repo) return null;
  const dirty = data.changed ?? 0;

  const sync = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await fetchJson<{ pushed: boolean; committed: boolean; note?: string }>(
        "/api/git",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project, message }),
        },
      );
      setMessage("");
      if (r.pushed) {
        toast.add({ title: `Pushed ${data.branch}`, description: "On origin." });
        setOpen(false);
      } else setNote(r.note ?? "Committed locally.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      mutate();
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="navtabs gitchip">
        <span className="tab git-tab">
          <GitBranch />
          <span className="mono">{data.branch}</span>
          {dirty > 0 && <span className="git-dirty">{dirty}</span>}
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="menu-pop git-pop">
        <div className="git-pop-row">
          <span className="dim2">Working tree</span>
          <span>
            {dirty ? `${dirty} file${dirty === 1 ? "" : "s"} changed` : "clean"}
            {(data.ahead ?? 0) > 0 && <span className="dim2"> · {data.ahead} unpushed</span>}
          </span>
        </div>
        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message"
          onKeyDown={(e) => e.key === "Enter" && !busy && message.trim() && sync()}
          disabled={busy}
        />
        <Button variant="outline" size="sm" disabled={busy || !message.trim()} onClick={sync}>
          {busy ? "Pushing…" : "Commit & push"}
        </Button>
        {note && <div className="git-note">{note}</div>}
      </PopoverContent>
    </Popover>
  );
}
