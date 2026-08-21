"use client";

// agent/instructions.md — eve's system prompt — read beside the graph it
// shapes. One view, one editor; saving writes the file the same way Build
// chat would, so the manifest watcher picks it up either way.

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Pencil } from "vercel-geist-icons";
import { Button } from "@/components/ui/button";
import { Md } from "./md";
import { fetchJson, getJson as fetcher } from "@/lib/fetch";

export default function InstructionsPane({ project }: { project: string }) {
  const { data, error, mutate } = useSWR<{ text: string; exists: boolean }>(
    `/api/instructions?project=${encodeURIComponent(project)}`,
    fetcher,
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // A refetch (returning to the tab after Build chat edited the file) must not
  // clobber an in-progress draft.
  useEffect(() => {
    if (!editing && draft !== null) setDraft(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    try {
      await fetchJson("/api/instructions", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, text: draft }),
      });
      setEditing(false);
      setDraft(null);
      await mutate();
    } catch {
      // The draft stays up — losing typed instructions to a failed save is
      // worse than a second attempt.
    } finally {
      setSaving(false);
    }
  };

  if (error) return <div className="empty bad">{(error as Error).message}</div>;
  if (!data) return <div className="empty">Reading agent/instructions.md…</div>;

  if (editing && draft !== null)
    return (
      <div className="inst">
        <div className="inst-head">
          <span className="mono dim2">agent/instructions.md</span>
          <span className="spacer" />
          <Button variant="ghost" size="sm" disabled={saving} onClick={() => setEditing(false)}>
            Discard
          </Button>
          <Button variant="outline" size="sm" disabled={saving} onClick={save}>
            Save
          </Button>
        </div>
        <textarea
          ref={taRef}
          className="inst-ta"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
        />
      </div>
    );

  return (
    <div className="inst">
      <div className="inst-head">
        <span className="mono dim2">agent/instructions.md</span>
        <span className="spacer" />
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setDraft(data.text);
            setEditing(true);
          }}
        >
          <Pencil /> Edit
        </Button>
      </div>
      {data.exists ? (
        <Md className="inst-md">{data.text}</Md>
      ) : (
        <div className="empty">
          No instructions yet — every word here becomes part of how the agent behaves.{" "}
          <button
            className="linklike"
            onClick={() => {
              setDraft("");
              setEditing(true);
            }}
          >
            Write the first version
          </button>{" "}
          or ask Build chat to draft it.
        </div>
      )}
    </div>
  );
}
