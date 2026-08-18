"use client";

// Creating an agent, made visible. Name and folder up front, then the real
// commands in a real terminal — `eve init`, `vercel link`, `env pull` take
// about a minute between them, and the old version ran them inside one silent
// POST that was indistinguishable from a hang.
//
// The dev server is NOT started here: finishing hands you to the agent with
// the terminal sidebar open, so `eve dev` starts where you can watch it too.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FolderClosed } from "vercel-geist-icons";
import XtermView from "./xterm-view.jsx";
import { agentNameError } from "@/lib/agent-name.js";
const tilde = (p) => (p ?? "").replace(/^\/(?:Users|home)\/[^/]+/, "~");

export default function NewAgentDialog({ open, onOpenChange }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [dir, setDir] = useState(null);
  // Prefilled from the workspace setting so the common case is zero clicks;
  // the row stays a button, so changing it is still one.
  useEffect(() => {
    if (!open) return;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => setDir((d) => d ?? s.workspace))
      .catch(() => {});
  }, [open]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const nameError = name ? agentNameError(name) : null;
  const valid = !agentNameError(name) && dir;

  const chooseDir = async () => {
    setError(null);
    const r = await fetch("/api/folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Where should the agent live?" }),
    }).then((x) => x.json()).catch(() => ({ error: "picker failed" }));
    if (r.path) setDir(r.path);
    else if (r.error) setError(r.error);
  };

  // The terminal exiting only means bash finished — it says nothing about
  // whether the scaffold is actually on disk. finalize checks that.
  const onFinished = async () => {
    const r = await fetch("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, dir }),
    }).then((x) => x.json()).catch(() => ({ error: "could not finish" }));
    if (!r.ok) { setError(r.error ?? "could not finish"); return; }
    onOpenChange(false);
    // panel=terminal starts eve dev in the sidebar — visible, not detached.
    router.push(`/runs?project=${encodeURIComponent(name)}&environment=local&panel=terminal`);
  };

  const reset = () => { setName(""); setDir(null); setRunning(false); setError(null); };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="set-dialog">
        <div className="set-body">
          <DialogHeader>
            <DialogTitle>New agent</DialogTitle>
            <DialogDescription>
              Initiates a local agent, creates a Vercel project, links the project and pulls env variables.
            </DialogDescription>
          </DialogHeader>

          <div className="na-form">
            <label className="na-label" htmlFor="na-name">Name</label>
            <Input
              id="na-name"
              placeholder="my-agent"
              value={name}
              autoFocus
              disabled={running}
              onChange={(e) => { setName(e.target.value); setError(null); }}
            />
            <span className={"na-hint" + (nameError ? " na-bad" : "")}>
              {nameError ?? "This will also be the Vercel project name."}
            </span>

            <label className="na-label" htmlFor="na-dir">Folder</label>
            <button id="na-dir" className="na-dir" onClick={chooseDir} disabled={running}>
              <span className="na-dir-ic"><FolderClosed /></span>
              <span className={"na-dir-path" + (dir ? "" : " na-unset")}>
                {dir ? `${tilde(dir)}/${name || "…"}` : "Choose a folder…"}
              </span>
              {!running && <span className="na-dir-action">{dir ? "Change" : "Choose"}</span>}
            </button>
          </div>

          {running && (
            <div className="na-term">
              <XtermView
                project={name}
                variant="create"
                extra={{ dir }}
                fontSize={12}
                className="na-term-body"
                onExit={onFinished}
              />
            </div>
          )}

          {error && <p className="na-error">{error}</p>}

          {!running && (
            <div className="set-footer">
              {/* Both from the same component so height, radius and font match —
                  a .chatbtn next to a shadcn Button is two button systems. */}
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => { setError(null); setRunning(true); }} disabled={!valid}>
                Create agent
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
