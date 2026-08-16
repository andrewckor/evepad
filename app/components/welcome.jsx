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
import { Terminal, Copy, Check, ArrowRight, ArrowUpRight } from "vercel-geist-icons";
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

// The CLI's device flow, driven from here: we ask the server to run
// `vercel login`, show the code it prints, and poll until credentials exist.
// The CLI remains the only thing that ever holds a token.
function SignIn({ onDone }) {
  const [login, setLogin] = useState(null);
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState(null);

  const begin = async () => {
    setStarting(true);
    setFailed(null);
    try {
      const r = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "login" }),
      });
      const body = await r.json();
      if (body.login?.url) {
        setLogin(body.login);
        window.open(body.login.url, "_blank", "noopener");
      } else {
        setFailed(body.login?.error ?? body.error ?? "Couldn't start the Vercel CLI.");
      }
    } catch (e) {
      setFailed(String(e.message ?? e));
    } finally {
      setStarting(false);
    }
  };

  // Poll the credentials themselves, not the CLI's exit code: the moment
  // auth.json exists the rest of the app works, and that's the thing every
  // other route reads.
  useEffect(() => {
    if (!login?.url) return;
    const t = setInterval(async () => {
      try {
        const acc = await fetch("/api/account").then((r) => r.json());
        if (acc.loggedIn) { clearInterval(t); onDone(); }
      } catch {}
    }, 1200);
    return () => clearInterval(t);
  }, [login?.url, onDone]);

  if (!login) {
    return (
      <>
        <div className="wc-actions">
          <Button onClick={begin} disabled={starting}>
            {starting ? "Starting…" : "Sign in with Vercel"}
          </Button>
        </div>
        {failed && <p className="wc-foot wc-err">{failed}</p>}
        <p className="wc-foot">Or from a terminal:</p>
        <Command>vercel login</Command>
      </>
    );
  }

  return (
    <>
      <p className="wc-body">
        Confirm this code on Vercel. This page continues by itself once you do.
      </p>
      <div className="wc-code mono">{login.code}</div>
      <div className="wc-actions">
        {/* A plain anchor, not Button render={<a/>}: Base UI's button sets
            nativeButton and warns that a non-<button> drops its semantics. */}
        <a className="wc-link-btn" href={login.url} target="_blank" rel="noreferrer">
          Open Vercel <ArrowUpRight />
        </a>
      </div>
      <p className="wc-foot">Waiting for confirmation…</p>
    </>
  );
}

export default function Welcome({ state, error, localCount = 0, onRetry, onNew, onSkip }) {
  if (state === "signed-out") {
    return (
      <div className="wc">
        <b className="wc-title">Connect your Vercel account</b>
        <p className="wc-body">
          The cockpit shows the eve agents in your Vercel scope and the runs
          they&rsquo;ve had.
        </p>
        <SignIn onDone={onRetry} />
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
