"use client";

// A file's changes, rendered from OpenCode's structured hunks.
//
// Used in two places, which is why it's its own component: the composer's
// "N files changed" chip (session-wide) and the patch card inside a message
// (what that message touched). Both fetch the same endpoint lazily — a diff
// nobody expanded costs nothing.

import { useEffect, useState } from "react";
import { ChevronRight } from "vercel-geist-icons";

// Hunk lines carry their own marker as the first character: the git convention
// the API passes straight through.
const kindOf = (line: string) => (line[0] === "+" ? "add" : line[0] === "-" ? "del" : "ctx");

type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

function Hunks({ hunks }: { hunks: Hunk[] }) {
  if (!hunks.length) return <div className="fd-empty">No changes recorded for this file.</div>;
  return (
    <div className="fd-hunks mono thinbar">
      {hunks.map((h, i) => {
        // Line numbers are reconstructed as we walk: the API gives the hunk's
        // starting points, and each side advances only on lines that belong
        // to it.
        let oldN = h.oldStart;
        let newN = h.newStart;
        return (
          <div key={i} className="fd-hunk">
            <div className="fd-hunk-head">
              @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
            </div>
            {h.lines.map((line, j) => {
              const kind = kindOf(line);
              const o = kind === "add" ? "" : oldN++;
              const n = kind === "del" ? "" : newN++;
              return (
                <div key={j} className={"fd-line " + kind}>
                  <span className="fd-n">{o}</span>
                  <span className="fd-n">{n}</span>
                  <span className="fd-t">{line}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export default function FileDiff({
  project,
  file,
  additions,
  deletions,
  defaultOpen = false,
}: {
  project: string;
  file: string;
  additions?: number | null;
  deletions?: number | null;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [hunks, setHunks] = useState<Hunk[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || hunks || error) return;
    let cancelled = false;
    fetch(`/api/oc/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(file)}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) setError(d.error);
        else {
          setNote(d.note ?? null);
          setHunks(d.hunks ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Could not read the file.");
      });
    return () => {
      cancelled = true;
    };
  }, [open, project, file, hunks, error]);

  return (
    <div className={"fd" + (open ? " open" : "")}>
      <button className="fd-head" onClick={() => setOpen((o) => !o)}>
        <span className="fd-chev">
          <ChevronRight />
        </span>
        <span className="fd-file mono" title={file}>
          {file.split("/").slice(-2).join("/")}
        </span>
        {additions != null && <span className="fd-add">+{additions}</span>}
        {deletions != null && <span className="fd-del">−{deletions}</span>}
      </button>
      {open &&
        (error ? (
          <div className="fd-empty">{error}</div>
        ) : note ? (
          <div className="fd-empty">{note}</div>
        ) : hunks ? (
          <Hunks hunks={hunks} />
        ) : (
          <div className="fd-empty">Reading…</div>
        ))}
    </div>
  );
}
