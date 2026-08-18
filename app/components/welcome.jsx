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
import { Terminal, Copy, Check, ArrowRight, CheckCircleFill, Play } from "vercel-geist-icons";
import { Button } from "@/components/ui/button";
import XtermView from "./xterm-view.jsx";
import { motion } from "motion/react";
import { SPRING } from "./motion.js";

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
export function CliSignIn({ account, onContinue, demo = false, terminal = false }) {
  // Poll only while signed out; /api/account is cheap and cached, and this
  // stops the instant credentials exist.
  const [found, setFound] = useState(account?.loggedIn ? account : null);
  // The poll's REJECTED responses are worth keeping too: they carry
  // tokenSource, which decides whether we ask for `vercel login` at all. The
  // caller doesn't always have an account to hand (the reconnect dialog opens
  // straight off a failed runs request), so this is the only place that knows.
  const [latest, setLatest] = useState(account ?? null);

  // One immediate check, used both by the poll and by the terminal exiting.
  const check = async () => {
    try {
      const acc = await fetch("/api/account", { cache: "no-store" }).then((r) => r.json());
      setLatest(acc);
      if (acc.loggedIn) setFound(acc);
      return acc.loggedIn;
    } catch { return false; }
  };

  useEffect(() => {
    // `demo` is the dev override simulating a signed-out machine; without it
    // the poll would find the real credentials and flip straight back.
    if (found || demo) return;
    const t = setInterval(check, 1500);
    return () => clearInterval(t);
  }, [found, demo]);

  // Pressing play swaps the static box for a live pty seeded with the command.
  // Until then no shell exists, so nothing can authenticate on its own.
  const [ran, setRan] = useState(false);
  // node-pty is a native module (note the chmod in package.json's postinstall),
  // so "the terminal didn't start" is a real state, not a hypothetical.
  const [termFailed, setTermFailed] = useState(false);
  // The pty is sized from the box it mounts into, so it must not mount while
  // the box is still growing: at 400px mid-animation it spawned ~50 columns and
  // the device URL wrapped a character early. Mount once the box has settled.
  const [settled, setSettled] = useState(false);
  const runLogin = () => {
    // Always a FRESH login: startTerm re-attaches to a live pty, so without
    // this you'd get whatever a previous attempt left on screen instead of
    // watching the command run.
    fetch("/api/term", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "__login", variant: "login", action: "stop" }),
    }).finally(() => setRan(true));
  };

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

  // A credential from the environment can't be fixed by signing in: cliToken()
  // reads VERCEL_TOKEN first, so `vercel login` would succeed and change
  // nothing. Ask for the thing that actually applies.
  if ((latest ?? account)?.tokenSource === "VERCEL_TOKEN") {
    return (
      <>
        <p className="wc-body">
          evepad is using <span className="mono">VERCEL_TOKEN</span> from its environment,
          and Vercel rejected it.
        </p>
        <p className="wc-foot">
          Replace that token and restart evepad. Signing in with the CLI
          won&rsquo;t help while it&rsquo;s set — the variable takes priority.
        </p>
      </>
    );
  }

  // `terminal` runs the sign-in here so it doesn't mean leaving the page.
  // The copyable command below is the fallback when the pty can't start —
  // every caller passes `terminal`, so that branch is reached only through
  // termFailed.
  if (terminal && !termFailed) {
    return (
      <>
        {/* Two states, deliberately: a STATIC command box until you press play,
            then the real thing. Nothing spawns a pty — and nothing can run —
            just because this screen rendered. */}
        <motion.div
          className={"wc-term" + (ran ? " grown" : "")}
          initial={false}
          // Wider once it's running: the device URL is ~58 columns, and a box
          // sized for `vercel login` would wrap it however carefully the pty
          // is sized.
          animate={{ height: ran ? 200 : 50, width: ran ? 500 : 400 }}
          transition={SPRING}
          onAnimationComplete={() => ran && setSettled(true)}
        >
          {settled ? (
            <XtermView
              project="__login"
              variant="login"
              fontSize={12}
              className="wc-term-body"
              // `vercel login` exiting is the strongest signal there is —
              // stronger than a 1.5s poll, and it still fires when the poll is
              // off (the ?firstrun override disables it). Checked on exit
              // regardless of `demo`: if a real login just ran in OUR terminal,
              // its result is real too.
              onExit={check}
              onStatus={(info) => info?.error && setTermFailed(true)}
            />
          ) : ran ? null : (
            <div className="wc-term-fake">
              <span className="wc-term-prompt">▲</span>
              <code className="mono">vercel login</code>
              <button className="wc-term-play" onClick={runLogin} aria-label="Run vercel login">
                <Play />
              </button>
            </div>
          )}
        </motion.div>
        <p className="wc-foot">Run this command or paste it to your terminal.</p>
      </>
    );
  }

  return (
    <>
      <p className="wc-body">Sign in with the Vercel CLI:</p>
      <Command>vercel login</Command>
      <p className="wc-foot">Leave this open — it updates as soon as you&rsquo;re signed in.</p>
    </>
  );
}

export default function Welcome({ state, error, account, demo = false, localCount = 0, onRetry, onNew, onSkip }) {
  if (state === "signed-out") {
    return (
      <div className="wc">
        <b className="wc-title">Connect your Vercel account</b>
        <p className="wc-body">To get access to your remote agents and runs.</p>
        <CliSignIn account={account} onContinue={onRetry} demo={demo} terminal />
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
        This scope has no eve agents. Create one and evepad scaffolds it,
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
