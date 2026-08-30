"use client";

// LOADING STATE — pixel-grid loader for long-running work, cloned from
// beautifului.dev. Replaces the ASCII wave, which drew a <pre> whose line box
// overflowed its 26px strip and collided with the transcript above it.
//
// Variants:
//   Drive  — square cells, chevron wavefront driving right; the 650ms cycle is
//            shorter than the sweep, so two fronts are always in flight
//   Dots   — same wavefront, circular cells
//   Orbit  — a comet lapping the grid perimeter
//
// Paired with a shimmering label and a live elapsed timer in mono tabular
// figures. Reduced motion freezes the grid to its dim state; the timer ticks.

import { useEffect, useRef, useState } from "react";

const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3),
    c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

const PATTERNS = {
  Drive: { delays: chevron, dur: 650, round: false },
  Dots: { delays: chevron, dur: 650, round: true },
  Orbit: { delays: orbit, dur: 950, round: false },
};

// Clock off a start timestamp rather than a counter: a setInterval that adds
// 100ms per tick drifts badly on a busy main thread, and this timer is on
// screen for whole minutes.
//
// Impure by design: an elapsed clock exists to read the current time during
// render, and the interval above is what schedules each re-read.
function useElapsed(active: boolean): string {
  // oxlint-disable-next-line react/purity
  const start = useRef(Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, [active]);
  // oxlint-disable-next-line react/purity, react/refs
  const total = (Date.now() - start.current) / 1000;
  if (total < 60) return `${total.toFixed(1)}s`;
  // Past a minute, tenths are noise — whole seconds read cleaner.
  return `${Math.floor(total / 60)}m ${Math.floor(total % 60)}s`;
}

// The grid alone — for inline slots (a running tool row) where a label and a
// timer would be noise.
export function PixelGrid({
  variant = "Drive",
  className = "",
}: {
  variant?: string;
  className?: string;
}) {
  const { delays, dur, round } = PATTERNS[variant as keyof typeof PATTERNS] ?? PATTERNS.Drive;
  return (
    <span
      aria-hidden
      className={"pixgrid" + (round ? " round" : "") + (className ? " " + className : "")}
    >
      {delays.map((d: number | null, i: number) => (
        <span
          key={i}
          style={{
            opacity: d === null ? 0.07 : 0.15,
            animation: d === null ? "none" : `pixel-on ${dur}ms ease-in-out ${d}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

export default function LoadingState({ label = "Churning", variant = "Drive", elapsed = true }) {
  const time = useElapsed(elapsed);
  return (
    <span className="loadstate">
      <PixelGrid variant={variant} />
      <span className="loadstate-label">{label}</span>
      {elapsed && <span className="loadstate-time mono">{time}</span>}
    </span>
  );
}
