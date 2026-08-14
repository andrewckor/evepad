"use client";

// Project switcher with per-project dev-server controls (start ■ / stop ▶ / 📁
// connect a checkout). Lives in the persistent shell, so its SWR poll and open
// state survive route changes.

import { useState } from "react";
import useSWR from "swr";
import { I } from "./icons.jsx";

const fetcher = (url) => fetch(url).then((r) => r.json());

export default function ProjectPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState({});
  const { data, mutate } = useSWR("/api/projects", fetcher, {
    refreshInterval: 5000,
    keepPreviousData: true,
  });

  const projects = data?.projects ?? [];
  const current = projects.find((p) => p.name === value) ?? projects.find((p) => p.live) ?? projects[0];
  const live = projects.filter((p) => p.live);
  const rest = projects.filter((p) => !p.live);

  const devAction = async (e, p, action) => {
    e.stopPropagation();
    const label = { start: "starting", stop: "stopping", locate: "picking folder" }[action];
    setBusy((b) => ({ ...b, [p.name]: label }));
    try {
      const r = await fetch("/api/dev", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: p.name, action }),
      });
      const body = await r.json();
      if (!r.ok) alert(body.error ?? "failed");
    } finally {
      setBusy((b) => ({ ...b, [p.name]: undefined }));
      mutate();
    }
  };

  const Row = (p) => {
    const state = busy[p.name];
    return (
      <button key={p.name + p.localPort} onClick={() => { onChange(p); setOpen(false); }}>
        <span className={"dot" + (p.live ? " on" : "")} />
        <span>{p.name}</span>
        <span className="sub">{p.live ? `:${p.localPort}` : p.source === "vercel" ? "remote" : ""}</span>
        {state ? (
          <span className="devbtn busy" title={state}>…</span>
        ) : p.live ? (
          <span className="devbtn stop" title="Stop local server" onClick={(e) => devAction(e, p, "stop")}>■</span>
        ) : p.localPath ? (
          <span className="devbtn play" title={`Start eve dev in ${p.localPath}`} onClick={(e) => devAction(e, p, "start")}>▶</span>
        ) : (
          <span className="devbtn locate" title="Connect a local checkout — opens a folder picker" onClick={(e) => devAction(e, p, "locate")}>📁</span>
        )}
      </button>
    );
  };

  return (
    <div className="picker">
      <button onClick={() => setOpen((o) => !o)}>
        <span className={"dot" + (current?.live ? " on" : "")} />
        <span>{current?.name ?? "select project"}</span>
        <span className="chev">{I.chevDown}</span>
      </button>
      {open && (
        <div className="menu" onMouseLeave={() => setOpen(false)}>
          {live.length > 0 && <div className="hd">running locally</div>}
          {live.map(Row)}
          {rest.length > 0 && <div className="hd">vercel projects</div>}
          {rest.map(Row)}
          {!projects.length && <div className="hd">no projects found</div>}
        </div>
      )}
    </div>
  );
}
