"use client";

// First run. The cockpit reads agents from Vercel and edits them from folders
// on this Mac, so a new user can be stuck in exactly two places: not signed in
// to Vercel, or signed in with nothing to show. Both used to render as
// "Looking for agents…" forever — a spinner for a state that will never
// resolve on its own.
//
// Everything here is a real check against a real API, never a stored
// "onboarded" flag: the flag would lie the moment someone runs `vercel logout`
// or clones the repo onto a second machine.

import { useState } from "react";
import { Terminal, Copy, Check, ArrowRight } from "vercel-geist-icons";
import { Button } from "@/components/ui/button";

function Command({ children }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(children);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = children;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.append(ta);
      ta.select();
      try { document.execCommand("copy"); } finally { ta.remove(); }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="wc-cmd">
      <span className="wc-cmd-ic"><Terminal /></span>
      <code className="mono">{children}</code>
      <button className={"wc-cmd-copy" + (copied ? " done" : "")} onClick={copy} aria-label="Copy command">
        {copied ? <Check /> : <Copy />}
      </button>
    </div>
  );
}

export default function Welcome({ state, error, onRetry, onNew }) {
  if (state === "signed-out") {
    return (
      <div className="wc">
        <b className="wc-title">Connect your Vercel account</b>
        <p className="wc-body">
          The cockpit shows the eve agents in your Vercel scope and the runs
          they&rsquo;ve had. Sign in with the Vercel CLI, then come back.
        </p>
        <Command>vercel login</Command>
        <div className="wc-actions">
          <Button onClick={onRetry}>I&rsquo;ve signed in</Button>
        </div>
        <p className="wc-foot">
          Already using a token? Set <span className="mono">VERCEL_TOKEN</span> in the
          environment you started the cockpit from.
        </p>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="wc">
        <b className="wc-title">Couldn&rsquo;t reach Vercel</b>
        <p className="wc-body mono wc-err">{error}</p>
        <div className="wc-actions">
          <Button onClick={onRetry}>Try again</Button>
        </div>
      </div>
    );
  }

  // Signed in, scope resolved, and no eve agents in it. Nothing is broken —
  // there is simply nothing here yet.
  return (
    <div className="wc">
      <b className="wc-title">No agents here yet</b>
      <p className="wc-body">
        This scope has no eve agents. Create one and the cockpit scaffolds it,
        makes its Vercel project, and starts it locally — then Build, Runs and
        the terminal all point at it.
      </p>
      <div className="wc-actions">
        <Button onClick={onNew}>Create your first agent <ArrowRight /></Button>
      </div>
      <p className="wc-foot">
        Already have one on this Mac? Run <span className="mono">eve dev</span> in its
        folder once and it shows up here.
      </p>
    </div>
  );
}
