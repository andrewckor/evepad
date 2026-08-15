"use client";

// Generative ASCII loader (see .agents/skills/ascii-animation): a traveling
// sine field rendered through a shaded-block brightness ramp into a <pre>.
// Frames are written straight to textContent from rAF — React renders it once
// and never again, so it costs nothing while the rest of the page streams.

import { useEffect, useRef } from "react";

const RAMP = " ·░▒▓█"; // ' ·░▒▓█' dark -> light

export function AsciiLoader({ cols = 10, rows = 1, className = "" }) {
  const ref = useRef(null);
  useEffect(() => {
    let raf, last = 0;
    const tick = (t) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 50) return; // 20fps is plenty (skill: 12-24fps)
      last = t;
      let out = "";
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const v = Math.sin(x * 0.9 - t * 0.005 + y * 1.3) + Math.sin((x + y) * 0.5 - t * 0.0031);
          const lum = Math.min(1, Math.max(0, (v + 2) / 4));
          out += RAMP[Math.round(lum * (RAMP.length - 1))];
        }
        if (y < rows - 1) out += "\n";
      }
      if (ref.current) ref.current.textContent = out;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cols, rows]);
  return <pre ref={ref} className={"ascii-load " + className} aria-label="working" />;
}

export default AsciiLoader;
