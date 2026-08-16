"use client";

// Vercel's theme switcher, measured on vercel.com/geist/theme-switcher: a
// 96x32 pill of three 32px radio targets — system, light, dark — with 16px
// icons, the inactive ones #8f8f8f and the active one filled and ringed.
//
// The preference lives in localStorage and is applied to <html> by the boot
// script in layout.jsx; this only writes it. "system" stays a real choice
// rather than a resolved value, so the app follows the OS when the OS changes.

import { useEffect, useState } from "react";
import { Display, Sun, Moon } from "vercel-geist-icons";

const KEY = "eve-cockpit:theme";
const OPTIONS = [
  ["system", "System", <Display key="s" />],
  ["light", "Light", <Sun key="l" />],
  ["dark", "Dark", <Moon key="d" />],
];

export function applyTheme(pref) {
  const dark = pref === "dark"
    || (pref === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themePref = pref;
  // Tailwind's dark: variant keys off the class, not the attribute.
  document.documentElement.classList.toggle("dark", dark);
}

export default function ThemeSwitcher() {
  // Read on mount, not during render: the server has no localStorage, and
  // guessing here would flip the control on hydration.
  const [pref, setPref] = useState(null);
  useEffect(() => {
    setPref(document.documentElement.dataset.themePref || "system");
  }, []);

  // Following the OS means listening to it — a stored "system" that resolved
  // once at boot would go stale the moment the Mac switches at sunset.
  useEffect(() => {
    if (pref !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  const pick = (next) => {
    setPref(next);
    try { localStorage.setItem(KEY, next); } catch {}
    applyTheme(next);
  };

  return (
    <div className="thsw" role="radiogroup" aria-label="Theme">
      {OPTIONS.map(([value, label, icon]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={pref === value}
          aria-label={label}
          title={label}
          className={"thsw-opt" + (pref === value ? " on" : "")}
          onClick={() => pick(value)}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}
