"use client";

// The project tile Vercel's dashboard shows: its stored avatar (their
// deploy-detected favicon), then the live site's favicon, then framework art —
// the eve dot-grid for eve projects, a monogram otherwise. Shared by the
// Agents grid and the project switcher so both read identically.

import { useState } from "react";

function EveMark() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
      {[
        [3, 3],
        [8, 2.5],
        [13, 3],
        [2.5, 8],
        [8, 8],
        [13.5, 8],
        [3, 13],
        [8, 13.5],
        [13, 13],
      ].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i % 2 ? 1.1 : 1.5} fill="currentColor" />
      ))}
    </svg>
  );
}

// A project with no deployments has no favicon for the icon service to
// detect, so Vercel's dashboard falls back to the FRAMEWORK logo — served
// from its own CDN. Same here: the eve mark carries its own black tile, so
// one asset is right in both themes (it's exactly what deployed eve
// favicons look like anyway).
const EVE_FRAMEWORK_LOGO = "https://api-frameworks.vercel.sh/framework-logos/eve.svg";

import type { Project } from "@/lib/types";

export default function ProjectLogo({
  p,
  size = 32,
}: {
  p: Partial<Project> & { name: string };
  size?: number;
}) {
  const sources = [
    p.iconUrl,
    p.avatarUrl,
    p.productionUrl ? `${p.productionUrl}/favicon.ico` : null,
    p.framework === "eve" ? EVE_FRAMEWORK_LOGO : null,
  ].filter(Boolean);
  const [idx, setIdx] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const src = sources[idx] ?? null;
  const mark =
    p.framework === "eve" ? (
      <EveMark />
    ) : (
      <span className="mono" style={{ fontSize: size < 24 ? 10 : 13 }}>
        {(p.name ?? "?").slice(0, 1).toUpperCase()}
      </span>
    );
  return (
    <span
      className="agentlogo"
      style={{ width: size, height: size, borderRadius: size < 24 ? 6 : 8 }}
    >
      {src && (
        <img
          src={src}
          alt=""
          style={loaded ? {} : { display: "none" }}
          onLoad={() => setLoaded(true)}
          onError={() => {
            setLoaded(false);
            setIdx((i) => i + 1);
          }}
        />
      )}
      {!loaded && mark}
    </span>
  );
}
