"use client";

// Creating an agent, made visible. Name and folder up front, then the real
// commands in a real terminal — `eve init`, `vercel link`, `env pull` take
// about a minute between them, and the old version ran them inside one silent
// POST that was indistinguishable from a hang.
//
// Finishing starts `eve dev` in the background (the play button's own call)
// and hands you to the agent's Build screen — no sidebar, the graph goes
// live once the server answers.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FolderClosed } from "vercel-geist-icons";
import XtermView from "./xterm-view";
import { agentNameError } from "@/lib/agent-name";
const tilde = (p: string | null | undefined) => (p ?? "").replace(/^\/(?:Users|home)\/[^/]+/, "~");

export default function NewAgentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [dir, setDir] = useState<string | null>(null);
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
  const [error, setError] = useState<string | null>(null);
  // `dir/name` already on disk. Checked while you type — the server rejects
  // the collision anyway (lib/terminals.js), but that used to surface as a
  // dead terminal; a hint next to the name lets you pick another before
  // Create. Stored as the colliding path and derived below, so editing either
  // field clears the hint without a second setState.
  const [takenPath, setTakenPath] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !dir || !name || agentNameError(name)) return;
    let stale = false;
    const t = setTimeout(() => {
      fetch(`/api/agents?name=${encodeURIComponent(name)}&dir=${encodeURIComponent(dir)}`)
        .then((r) => r.json())
        .then((r) => !stale && setTakenPath(r.exists ? `${dir}/${name}` : null))
        .catch(() => {});
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [open, name, dir]);
  const taken = Boolean(dir && name) && takenPath === `${dir}/${name}`;
  const nameError = name
    ? (agentNameError(name) ??
      (taken ? `"${name}" already exists in that folder — pick another name or folder.` : null))
    : null;
  const valid = !agentNameError(name) && dir && !taken;

  const chooseDir = async () => {
    setError(null);
    const r = await fetch("/api/folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Where should the agent live?" }),
    })
      .then((x) => x.json())
      .catch(() => ({ error: "picker failed" }));
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
    })
      .then((x) => x.json())
      .catch(() => ({ error: "could not finish" }));
    if (!r.ok) {
      setError(r.error ?? "could not finish");
      return;
    }
    // Boot the agent's dev server in the background — same call as the play
    // button, detached, so the CLI sidebar stays closed. Not awaited: Build
    // is usable while it comes up, and the graph flips live on its own.
    void fetch("/api/dev", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: name, action: "start" }),
    }).catch(() => {});
    onOpenChange(false);
    // Land on Build: a fresh agent has no runs to look at, but it does have
    // instructions to write and a chat to start shaping it with.
    router.push(`/build?project=${encodeURIComponent(name)}`);
  };

  const reset = () => {
    setName("");
    setDir(null);
    setRunning(false);
    setError(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="set-dialog">
        <div className="set-body">
          <DialogHeader>
            <DialogTitle>New agent</DialogTitle>
            <DialogDescription>
              Initiates a local agent, creates a Vercel project, links the project and pulls env
              variables.
            </DialogDescription>
          </DialogHeader>

          <div className="na-form">
            <label className="na-label" htmlFor="na-name">
              Name
            </label>
            <Input
              id="na-name"
              placeholder="my-agent"
              value={name}
              autoFocus
              disabled={running}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
            />
            <span className={"na-hint" + (nameError ? " na-bad" : "")}>
              {nameError ?? "This will also be the Vercel project name."}
            </span>

            <label className="na-label" htmlFor="na-dir">
              Folder
            </label>
            <button id="na-dir" className="na-dir" onClick={chooseDir} disabled={running}>
              <span className="na-dir-ic">
                <FolderClosed />
              </span>
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
                // A start refusal (folder already exists, bad workspace) used
                // to strand the dialog on a dead terminal — land it back on
                // the form with the reason, so name/folder can change.
                onStatus={(info) => {
                  if (info.error) {
                    setError(info.error);
                    setRunning(false);
                  }
                }}
                onExit={onFinished}
              />
            </div>
          )}

          {error && <p className="na-error">{error}</p>}

          {!running && (
            <div className="set-footer">
              {/* Both from the same component so height, radius and font match —
                  a .chatbtn next to a shadcn Button is two button systems. */}
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setError(null);
                  setRunning(true);
                }}
                disabled={!valid}
              >
                Create agent
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
