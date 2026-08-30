"use client";

// agent/instructions.md — eve's system prompt — read beside the graph it
// shapes. One view, one editor; saving writes the file the same way Build
// chat would, so the manifest watcher picks it up either way.

import { useEffect, useRef, useState, type ReactNode } from "react";
import useSWR from "swr";
import { File } from "vercel-geist-icons";
import { Button } from "@/components/ui/button";
import { Md, warmMd } from "./md";
import LoadingState from "./loading-state";
import { ScrollFade, useScrollFade } from "./scroll-fade";
import { fetchJson, getJson as fetcher } from "@/lib/fetch";

const INLINE_MD =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\([^)]+\)|https?:\/\/[^\s)]+|[*_][^*_\n]+[*_])/g;

function highlightMarkdownLine(line: string, key: number): ReactNode {
  const heading = line.match(/^(#{1,6})(\s+)(.*)$/);
  if (heading) {
    return (
      <span key={key}>
        <span className="md-syntax">{heading[1]}</span>
        {heading[2]}
        <span className="md-heading">{heading[3]}</span>
      </span>
    );
  }

  const fence = line.match(/^(```|~~~)(.*)$/);
  if (fence) {
    return (
      <span key={key} className="md-fence">
        {line}
      </span>
    );
  }

  const parts: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  INLINE_MD.lastIndex = 0;
  while ((match = INLINE_MD.exec(line))) {
    if (match.index > cursor) parts.push(line.slice(cursor, match.index));
    const token = match[0];
    const kind =
      token.startsWith("[") || token.startsWith("http")
        ? "md-link"
        : token.startsWith("`")
          ? "md-code"
          : "md-emphasis";
    parts.push(
      <span className={kind} key={`${key}-${match.index}`}>
        {token}
      </span>,
    );
    cursor = match.index + token.length;
  }
  if (cursor < line.length) parts.push(line.slice(cursor));

  const marker = line.match(/^(\s*)(>|[-+*]|\d+\.)(\s+)/);
  if (marker) {
    const markerEnd = marker[0].length;
    return (
      <span key={key}>
        {marker[1]}
        <span className="md-syntax">{marker[2]}</span>
        {marker[3]}
        {highlightMarkdownLine(line.slice(markerEnd), key + 100000)}
      </span>
    );
  }

  return <span key={key}>{parts}</span>;
}

export default function InstructionsPane({ project }: { project: string }) {
  const { data, error, mutate } = useSWR<{ text: string; exists: boolean }>(
    `/api/instructions?project=${encodeURIComponent(project)}`,
    fetcher,
  );
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"saving" | "saved" | "failed" | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => warmMd(), []);

  // The editor's scroll state lives on the textarea, but the visible text is
  // the highlight layer behind it — so the fade mask goes on .inst-source
  // (via :has in globals.css), driven by data-scroll stamped here.
  useScrollFade(mode === "source", ".inst-ta");

  useEffect(() => {
    if (mode === "source") taRef.current?.focus();
  }, [mode]);

  useEffect(
    () => () => {
      if (statusTimer.current) clearTimeout(statusTimer.current);
    },
    [],
  );

  const save = async () => {
    if (draft === null) return;
    const submittedDraft = draft;
    if (statusTimer.current) clearTimeout(statusTimer.current);
    setSaving(true);
    setSaveStatus("saving");
    try {
      await fetchJson("/api/instructions", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, text: submittedDraft }),
      });
      // Typing remains available while the request is in flight. Clear only
      // the exact version that was submitted; newer edits stay as the draft.
      setDraft((current) => (current === submittedDraft ? null : current));
      await mutate();
      setSaveStatus("saved");
      statusTimer.current = setTimeout(() => setSaveStatus(null), 1600);
    } catch {
      // The draft stays up — losing typed instructions to a failed save is
      // worse than a second attempt.
      setSaveStatus("failed");
    } finally {
      setSaving(false);
    }
  };

  if (error) return <div className="empty bad">{(error as Error).message}</div>;
  if (!data)
    return (
      <div className="inst instructions-pane">
        <div className="pane-loading">
          <LoadingState label="Loading instructions" elapsed={false} />
        </div>
      </div>
    );

  const source = draft ?? data.text;
  const dirty = draft !== null && draft !== data.text;
  const highlightedSource = source.split("\n").map((line, index) => (
    <span className="inst-source-line" key={index}>
      {highlightMarkdownLine(line, index)}
      {"\n"}
    </span>
  ));

  const showSource = () => {
    if (draft === null) setDraft(data.text);
    setMode("source");
  };

  return (
    <div className={`inst instructions-pane ${mode === "source" ? "editing" : ""}`}>
      <div className="inst-head">
        <span className="inst-file mono dim2">
          <File /> agent/instructions.md
        </span>
        <span className="spacer" />
        {saveStatus && (
          <span className={`inst-save-status ${saveStatus}`} role="status" aria-live="polite">
            {saveStatus === "saving"
              ? "Saving…"
              : saveStatus === "saved"
                ? "Saved!"
                : "Save failed"}
          </span>
        )}
        {dirty && !saving && (
          <>
            <button className="inst-discard" disabled={saving} onClick={() => setDraft(null)}>
              Discard
            </button>
            <Button className="inst-save" size="xs" disabled={saving} onClick={save}>
              Save
            </Button>
          </>
        )}
        <div className="inst-modes" aria-label="Instructions view">
          <button
            data-on={mode === "preview" ? "1" : "0"}
            disabled={saving}
            onClick={() => setMode("preview")}
          >
            Preview
          </button>
          <button data-on={mode === "source" ? "1" : "0"} disabled={saving} onClick={showSource}>
            Source
          </button>
        </div>
      </div>
      {mode === "source" ? (
        <div className="inst-source">
          <pre ref={highlightRef} className="inst-highlight" aria-hidden="true">
            {highlightedSource}
          </pre>
          <textarea
            ref={taRef}
            className="inst-ta thinbar"
            value={source}
            onChange={(e) => setDraft(e.target.value)}
            onScroll={(e) => {
              if (!highlightRef.current) return;
              highlightRef.current.scrollTop = e.currentTarget.scrollTop;
              highlightRef.current.scrollLeft = e.currentTarget.scrollLeft;
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                void save();
              }
            }}
            spellCheck={false}
          />
        </div>
      ) : data.exists || source ? (
        <ScrollFade className="inst-scroll thinbar">
          <Md
            className="inst-md"
            fallback={
              <div className="pane-loading">
                <LoadingState label="Loading instructions" elapsed={false} />
              </div>
            }
          >
            {source}
          </Md>
        </ScrollFade>
      ) : (
        <div className="empty">
          No instructions yet — every word here becomes part of how the agent behaves.{" "}
          <button className="linklike" onClick={showSource}>
            Write the first version
          </button>{" "}
          or ask Build chat to draft it.
        </div>
      )}
    </div>
  );
}
