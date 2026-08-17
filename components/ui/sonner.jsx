"use client"

// shadcn's sonner toaster, with two changes from the generated file.
//
// 1. Theme. The generated version reads next-themes, which this app doesn't
//    use — the theme is resolved before first paint into data-theme on <html>
//    (see app/layout.jsx). Left as-is, useTheme() returns "system" and sonner
//    follows the OS instead of the switcher: pick Light while the Mac is dark
//    and the toasts stay dark. Same problem xterm has, and the same fix —
//    watch the attribute (see app/terminal-panel.jsx).
// 2. Icons. The generated file imports five lucide icons, which AGENTS.md
//    forbids. They only render for toast.success/.error/etc; this app raises
//    plain toasts, so the set is dropped rather than swapped one-for-one for
//    Geist icons nothing calls.

import { useEffect, useState } from "react";
import { Toaster as Sonner } from "sonner";

const Toaster = ({
  ...props
}) => {
  // Resolved on the client only: the server has no <html> to read, and
  // guessing here would flip the toaster on hydration.
  const [theme, setTheme] = useState("dark");

  useEffect(() => {
    const read = () => setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      style={
        {
          // Our tokens, not the shadcn semantic ones the generator picked:
          // --popover is the flat page ground, and a toast has to read as
          // lifted off it. Set here rather than overridden in CSS because
          // sonner derives from these internally (the action button's fill is
          // var(--normal-text), which is why it comes out correctly inverted).
          // Inline, not in globals.css: sonner defines --width on the same
          // element at the same specificity and its sheet lands later, so a
          // stylesheet rule loses. At 356px the description wrapped to two
          // lines beside the action button.
          "--width": "420px",
          "--normal-bg": "var(--panel)",
          "--normal-text": "var(--fg)",
          "--normal-border": "var(--line2)",
          "--border-radius": "var(--r)"
        }
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props} />
  );
}

export { Toaster }
