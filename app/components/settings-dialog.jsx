"use client";

// Settings — everything the cockpit holds that isn't a project's own code.
// Deliberately honest about what it can change: the Vercel account and the
// local checkouts are owned by the CLI and the registry, so they're shown with
// the command that changes them rather than faked into editable fields.

import useSWR from "swr";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const fetcher = (url) => fetch(url).then((r) => r.json());
const ENV_KEY = "eve-cockpit:env2";
const ENVS = ["local", "preview", "production"];
const cap = (s) => s[0].toUpperCase() + s.slice(1);
// Home-relative paths fit without truncation, which beats any clever
// ellipsis: the RTL trick that keeps a path's tail visible also drags its
// leading slash to the far end, so "/Users/andrew/x" renders "Users/andrew/x/".
const tilde = (p) => (p ?? "").replace(/^\/(?:Users|home)\/[^/]+\//, "~/");

function Row({ label, children, hint }) {
  return (
    <div className="set-row">
      <div className="set-row-main">
        <span className="set-label">{label}</span>
        <span className="set-value">{children}</span>
      </div>
      {hint && <span className="set-hint mono">{hint}</span>}
    </div>
  );
}

export default function SettingsDialog({ open, onOpenChange, account }) {
  // Only fetched while the dialog is open — settings shouldn't cost a poll on
  // every page for a panel nobody has opened.
  const { data: projects, mutate } = useSWR(open ? "/api/projects" : null, fetcher);
  const linked = (projects?.projects ?? []).filter((p) => p.localPath);
  const env = typeof window === "undefined" ? null : localStorage.getItem(ENV_KEY);

  const unlink = async (p) => {
    await fetch("/api/registry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: p.name, action: "forget" }),
    });
    mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="set-dialog">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>How this cockpit is wired up.</DialogDescription>
        </DialogHeader>

        <div className="set-section">
          <div className="set-section-title">Vercel</div>
          <Row label="Account" hint={account?.loggedIn ? "vercel login" : null}>
            {account?.loggedIn ? account.user.email : "not signed in"}
          </Row>
          <Row label="Scope" hint="vercel switch">
            {account?.scope?.name ?? "—"}
          </Row>
          <Row label="Credentials" hint={account?.tokenSource === "VERCEL_TOKEN" ? "from the environment" : "~/Library/Application Support/com.vercel.cli"}>
            {account?.tokenSource ?? "none"}
          </Row>
        </div>

        <div className="set-section">
          <div className="set-section-title">Preferences</div>
          <Row label="Environments" hint="changed from the Runs page">
            {(env ?? ENVS.join(",")).split(",").map(cap).join(" + ")}
          </Row>
        </div>

        <div className="set-section">
          <div className="set-section-title">
            Local checkouts
            <span className="set-count">{linked.length}</span>
          </div>
          {/* The registry: which agent maps to which folder on this machine.
              This is the one thing here worth editing, because a moved or
              renamed folder is exactly what breaks Build. */}
          {linked.length ? linked.map((p) => (
            <div key={p.name} className="set-link">
              <span className={"dot" + (p.live ? " on" : "")} />
              <span className="set-link-name">{p.name}</span>
              <span className="set-link-path mono" title={p.localPath}>{tilde(p.localPath)}</span>
              {/* A running dev server is rediscovered on the next probe and
                  re-registers its own folder, so unlinking it can't stick —
                  say that instead of offering a button that undoes itself. */}
              <Button
                variant="ghost"
                size="sm"
                className="set-unlink"
                disabled={p.live}
                title={p.live ? "Stop the local server first — while it runs, its folder is detected live" : `Forget ${p.localPath}`}
                onClick={() => unlink(p)}
              >Unlink</Button>
            </div>
          )) : (
            <div className="set-empty">No agents linked yet — open Build on one and point it at its folder.</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
