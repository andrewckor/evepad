"use client";

// Settings — everything the cockpit holds that isn't a project's own code.
// Deliberately honest about what it can change: the Vercel account and the
// local checkouts are owned by the CLI and the registry, so they're shown with
// the command that changes them rather than faked into editable fields.

import { useState } from "react";
import useSWR, { mutate as mutateGlobal } from "swr";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";

const fetcher = (url) => fetch(url).then((r) => r.json());
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

export default function SettingsDialog({ open, onOpenChange, account, onSignedOut }) {
  // Two-step, because this signs the Vercel CLI out of the whole machine —
  // the cockpit has no session of its own to end, so a stray click would sign
  // you out of your terminal too.
  const [confirmOut, setConfirmOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "logout" }),
      });
    } finally {
      setSigningOut(false);
      setConfirmOut(false);
      onOpenChange(false);
      // Every screen keys off the account, so one revalidation flips the whole
      // app to its signed-out first run.
      onSignedOut?.();
      mutateGlobal("/api/projects");
    }
  };

  // Only fetched while the dialog is open — settings shouldn't cost a poll on
  // every page for a panel nobody has opened.
  const { data: projects, mutate } = useSWR(open ? "/api/projects" : null, fetcher);
  const linked = (projects?.projects ?? []).filter((p) => p.localPath);

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
        <TooltipProvider delay={200}>
        {/* Geist puts the content on pure black inside the panel; the panel's
            own #0a0a0a only shows through its footer strip. */}
        <div className="set-body">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
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
          <div className="set-section-title">
            Local folders
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
              {/* Native title never fired here: the browser suppresses it on
                  a disabled control, and moving it to the wrapper only helped
                  in theory — our own tooltip is a real element, so it shows
                  and can be tested. */}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="set-link-act">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="set-unlink"
                        disabled={p.live}
                        onClick={() => unlink(p)}
                      >Remove</Button>
                    </span>
                  }
                />
                <TooltipContent>
                  {p.live
                    ? "Stop the server before removing"
                    : "Remove this agent from the cockpit, folder remains on Mac"}
                </TooltipContent>
              </Tooltip>
            </div>
          )) : (
            <div className="set-empty">No agent has a folder on this Mac yet — open Build on one and choose its folder.</div>
          )}
        </div>

        {account?.loggedIn && (
          <div className="set-signout">
            {confirmOut ? (
              <>
                <span className="set-signout-q">Sign the Vercel CLI out on this Mac?</span>
                <span className="set-signout-row">
                  <Button variant="ghost" size="sm" className="set-danger" onClick={signOut} disabled={signingOut}>
                    {signingOut ? "Signing out…" : "Sign out"}
                  </Button>
                  <Button variant="ghost" size="sm" className="set-cancel" onClick={() => setConfirmOut(false)}>Cancel</Button>
                </span>
              </>
            ) : (
              <>
                <span className="set-signout-who">Signed in as {account.user.email}</span>
                <Button variant="ghost" size="sm" className="set-cancel" onClick={() => setConfirmOut(true)}>Sign out</Button>
              </>
            )}
          </div>
        )}
        </div>
        </TooltipProvider>
      </DialogContent>
    </Dialog>
  );
}
