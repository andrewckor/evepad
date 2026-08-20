"use client";

// The Vercel account evepad is reading from, in the top bar's scope
// slot — left of the project switcher, the way the dashboard reads
// "team / project". No sidebar: the account is not a place you go, it's the
// scope everything else is inside.
//
// Read-only by design. `vercel login` and `vercel switch` own the account and
// team; a switcher here would be a second source of truth for state the CLI
// already holds, and the two would drift.

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { SettingsGear, Check, ChevronUpSmall, ChevronDownSmall } from "vercel-geist-icons";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import SettingsDialog from "./settings-dialog";
import ThemeSwitcher from "./theme-switcher";
import { MenuLabel, MenuSeparator } from "./menu";

import { getJson as fetcher } from "@/lib/fetch";

function Avatar({
  src,
  name,
  size = 20,
}: {
  src?: string | null;
  name?: string | null;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const initial = (name ?? "?").trim().slice(0, 1).toUpperCase();
  return (
    <span
      className="acc-avatar"
      style={{ width: size, height: size, fontSize: size < 24 ? 9 : 12 }}
    >
      {src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : initial}
    </span>
  );
}

export default function AccountMenu() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  // Identity changes about never; the route caches for a minute and this
  // refreshes on focus, which covers a `vercel switch` in another window.
  const { data, mutate } = useSWR("/api/account", fetcher, { revalidateOnFocus: true });

  const scope = data?.scope;
  // Before the first response there is no answer yet — "Not signed in" would
  // be a claim, and it flashed on every cold load.
  const label = !data ? "…" : data.loggedIn ? (scope?.name ?? "Vercel") : "Not signed in";

  return (
    <>
      <span className="acc-cluster">
        <Popover open={open} onOpenChange={setOpen}>
          {/* Two jobs, two targets: the avatar goes home, the chevron opens
            the account menu. */}
          <Link className="acc-home" href="/" title="All agents" aria-label="All agents">
            <Avatar src={scope?.avatarUrl} name={label} size={22} />
          </Link>
          <PopoverTrigger
            className="acc-chev"
            title={data?.loggedIn ? `${label} — Vercel account` : "Vercel account"}
          >
            {/* The same stacked switcher glyph the project picker uses. */}
            <span className="chev chev-ud">
              <ChevronUpSmall />
              <ChevronDownSmall />
            </span>
          </PopoverTrigger>
          {/* Aligned to the avatar's left edge, not the chevron's: the offset is
            the avatar (32px) plus the 1px gap between them. */}
          <PopoverContent align="start" alignOffset={-33} className="acc-pop menu-pop">
            {data?.loggedIn ? (
              <>
                <MenuLabel>Team</MenuLabel>
                {/* Every team the token can reach, active one checked.
                  Switching is `vercel switch` — shown, not offered. */}
                {[scope, ...(data.teams ?? []).filter((t: { id?: string }) => t.id !== scope?.id)]
                  .filter(Boolean)
                  .map(
                    (t: {
                      id?: string;
                      slug?: string;
                      name?: string;
                      avatarUrl?: string | null;
                    }) => (
                      <div
                        key={t.id ?? t.slug}
                        className={"menu-row acc-team" + (t.slug === scope?.slug ? " on" : "")}
                      >
                        <Avatar src={t.avatarUrl} name={t.name} size={18} />
                        <span className="menu-row-label">{t.name}</span>
                        {t.slug === scope?.slug && (
                          <span className="menu-check">
                            <Check />
                          </span>
                        )}
                      </div>
                    ),
                  )}
                <MenuSeparator />
                {/* One row, like Vercel's: who you are, and the gear that opens
                  everything about it. */}
                <div className="menu-row acc-row">
                  <span className="acc-row-label">Theme</span>
                  <ThemeSwitcher />
                </div>
                <MenuSeparator />
                <button
                  className="acc-me"
                  onClick={() => {
                    setOpen(false);
                    setSettings(true);
                  }}
                >
                  <span className="acc-head-text">
                    <b>{data.user.name}</b>
                    <i>{data.user.email}</i>
                  </span>
                  <span className="acc-me-gear">
                    <SettingsGear />
                  </span>
                </button>
              </>
            ) : (
              <>
                <div className="acc-out">
                  <b>Not signed in to Vercel</b>
                  <p>
                    {data?.hint ?? data?.error ?? "Run `vercel login` to see your deployed agents."}
                  </p>
                </div>
                <MenuSeparator />
                <div className="acc-row">
                  <span className="acc-row-label">Theme</span>
                  <ThemeSwitcher />
                </div>
                <MenuSeparator />
                <button
                  className="menu-row acc-item"
                  onClick={() => {
                    setOpen(false);
                    setSettings(true);
                  }}
                >
                  <SettingsGear /> Settings
                </button>
              </>
            )}
          </PopoverContent>
        </Popover>
      </span>
      <SettingsDialog
        open={settings}
        onOpenChange={setSettings}
        account={data}
        onSignedOut={() => mutate()}
      />
    </>
  );
}
