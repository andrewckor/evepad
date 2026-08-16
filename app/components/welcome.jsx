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

import { useEffect, useState } from "react";
import { Terminal, Copy, Check, ArrowRight, CheckCircleFill } from "vercel-geist-icons";
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

// The CLI owns signing in. We watch for the credentials it writes and, the
// moment they appear, confirm who turned up — a silent jump into the app
// leaves you unsure which account you landed in.
function CliSignIn({ account, onContinue, demo = false }) {
  // Poll only while signed out; /api/account is cheap and cached, and this
  // stops the instant credentials exist.
  const [found, setFound] = useState(account?.loggedIn ? account : null);
  useEffect(() => {
    // `demo` is the dev override simulating a signed-out machine; without it
    // the poll would find the real credentials and flip straight back.
    if (found || demo) return;
    const t = setInterval(async () => {
      try {
        const acc = await fetch("/api/account").then((r) => r.json());
        if (acc.loggedIn) setFound(acc);
      } catch {}
    }, 1500);
    return () => clearInterval(t);
  }, [found, demo]);

  if (found) {
    return (
      <>
        <div className="wc-found">
          <span className="wc-found-ic"><CheckCircleFill /></span>
          <span className="wc-found-text">
            <b>{found.user.name}</b>
            <i>{found.user.email} · {found.scope?.name}</i>
          </span>
        </div>
        <div className="wc-actions">
          <Button onClick={onContinue}>Continue <ArrowRight /></Button>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="wc-body">Sign in with the Vercel CLI:</p>
      <Command>vercel login</Command>
      <p className="wc-foot">
        This page picks it up on its own — no need to come back and click
        anything. Using a token instead? Set <span className="mono">VERCEL_TOKEN</span> where
        you started the cockpit.
      </p>
    </>
  );
}

export default function Welcome({ state, error, account, demo = false, localCount = 0, onRetry, onNew, onSkip }) {
  if (state === "signed-out") {
    return (
      <div className="wc">
        <b className="wc-title">Connect your Vercel account</b>
        <p className="wc-body">
          The cockpit shows the eve agents in your Vercel scope and the runs
          they&rsquo;ve had.
        </p>
        <CliSignIn account={account} onContinue={onRetry} demo={demo} />
        {/* Local dev servers work without Vercel, so don't pretend the app is
            unusable — just don't let it look signed in either. */}
        {localCount > 0 && (
          <button className="wc-skip" onClick={onSkip}>
            Skip for now — {localCount} agent{localCount === 1 ? "" : "s"} running on this Mac
          </button>
        )}
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
