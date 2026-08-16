"use client";

// The Vercel account this cockpit is reading from, in the top bar's scope
// slot — left of the project switcher, the way the dashboard reads
// "team / project". No sidebar: the account is not a place you go, it's the
// scope everything else is inside.
//
// Read-only by design. `vercel login` and `vercel switch` own the account and
// team; a switcher here would be a second source of truth for state the CLI
// already holds, and the two would drift.

import { useState } from "react";
import useSWR, { mutate as mutateGlobal } from "swr";
import { SettingsGear, CheckCircleFill, Logout } from "vercel-geist-icons";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import SettingsDialog from "./settings-dialog.jsx";

const fetcher = (url) => fetch(url).then((r) => r.json());

function Avatar({ src, name, size = 20 }) {
  const [failed, setFailed] = useState(false);
  const initial = (name ?? "?").trim().slice(0, 1).toUpperCase();
  return (
    <span className="acc-avatar" style={{ width: size, height: size, fontSize: size < 24 ? 9 : 12 }}>
      {src && !failed
        ? <img src={src} alt="" onError={() => setFailed(true)} />
        : initial}
    </span>
  );
}

export default function AccountMenu() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  // Two-step, because this signs the Vercel CLI out of the whole machine —
  // the cockpit has no session of its own to end, so a stray click would log
  // you out of your terminal too.
  const [confirmOut, setConfirmOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  // Identity changes about never; the route caches for a minute and this
  // refreshes on focus, which covers a `vercel switch` in another window.
  const { data, mutate } = useSWR("/api/account", fetcher, { revalidateOnFocus: true });

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
      setOpen(false);
      // Everything downstream keys off the account, so one revalidation flips
      // the whole app to its signed-out first run.
      mutate();
      mutateGlobal("/api/projects");
    }
  };

  const scope = data?.scope;
  // Before the first response there is no answer yet — "Not signed in" would
  // be a claim, and it flashed on every cold load.
  const label = !data ? "…" : data.loggedIn ? scope?.name ?? "Vercel" : "Not signed in";

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger className="acc-trigger" title={data?.loggedIn ? `${label} — Vercel account` : "Vercel account"}>
          <Avatar src={scope?.avatarUrl} name={label} />
          <span className="acc-name">{label}</span>
        </PopoverTrigger>
        <PopoverContent align="start" className="acc-pop">
          {data?.loggedIn ? (
            <>
              <div className="acc-head">
                <Avatar src={data.user.avatarUrl} name={data.user.name} size={32} />
                <span className="acc-head-text">
                  <b>{data.user.name}</b>
                  <i>{data.user.email}</i>
                </span>
              </div>
              <div className="acc-sep" />
              <div className="acc-label">Scope</div>
              {/* Every team the token can reach, with the active one marked.
                  Switching is `vercel switch` — shown, not offered. */}
              {[scope, ...(data.teams ?? []).filter((t) => t.id !== scope?.id)].filter(Boolean).map((t) => (
                <div key={t.id ?? t.slug} className={"acc-scope" + (t.slug === scope?.slug ? " on" : "")}>
                  <Avatar src={t.avatarUrl} name={t.name} size={18} />
                  <span className="acc-scope-name">{t.name}</span>
                  {t.slug === scope?.slug && <span className="acc-check"><CheckCircleFill /></span>}
                </div>
              ))}
              <div className="acc-hint mono">vercel switch — to change scope</div>
            </>
          ) : (
            <div className="acc-out">
              <b>Not signed in to Vercel</b>
              <p>{data?.hint ?? data?.error ?? "Run `vercel login` to see your deployed agents."}</p>
            </div>
          )}
          <div className="acc-sep" />
          <button className="acc-item" onClick={() => { setOpen(false); setSettings(true); }}>
            <SettingsGear /> Settings
          </button>
          {data?.loggedIn && (
            confirmOut ? (
              <div className="acc-confirm">
                <span>Sign the Vercel CLI out on this Mac?</span>
                <div className="acc-confirm-row">
                  <button className="acc-danger" onClick={signOut} disabled={signingOut}>
                    {signingOut ? "Signing out…" : "Sign out"}
                  </button>
                  <button className="acc-cancel" onClick={() => setConfirmOut(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="acc-item" onClick={() => setConfirmOut(true)}>
                <Logout /> Sign out
              </button>
            )
          )}
        </PopoverContent>
      </Popover>
      <SettingsDialog open={settings} onOpenChange={setSettings} account={data} />
    </>
  );
}
