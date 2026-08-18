"use client";

// Project switcher, built like Vercel's: a Popover holding a Command palette —
// search pinned on top, one scrolling list underneath with faded edges and no
// visible scrollbar, project tiles identical to the Agents grid, and the
// per-project dev controls (start / stop / connect a checkout) on each row.
// Lives in the persistent shell, so its SWR poll survives route changes.

import { useState } from "react";
import useSWR from "swr";
import { I } from "./icons.jsx";
import ProjectLogo from "./project-logo.jsx";
import { Badge } from "./badge.jsx";
import { ChevronUpSmall, ChevronDownSmall } from "vercel-geist-icons";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { useScrollFade } from "./menu.jsx";
import {
  Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem,
} from "@/components/ui/command";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";

const fetcher = (url) => fetch(url).then((r) => r.json());

export default function ProjectPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  // Same fade the shared MenuList uses. cmdk's List doesn't forward refs, so
  // the hook takes the popover container and finds the scroller itself —
  // keyed on `open`, because the content is portalled and doesn't exist until
  // the menu opens.
  const fadeRef = useScrollFade(open, ".pk-list");
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
    e.preventDefault();
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

  const Tip = ({ label, children }) => (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );

  const Row = (p) => {
    const state = busy[p.name];
    return (
      <CommandItem
        key={p.name + (p.localPort ?? "")}
        value={p.name}
        onSelect={() => { onChange(p); setOpen(false); }}
        className="pk-row"
      >
        {/* Dot + name only — the tile repeats what the trigger already shows,
            and the checkmark repeats the trigger's selection. */}
        <span className={"dot" + (p.live ? " on" : "")} />
        <span className="pk-name">{p.name}</span>
        {p.live && <Badge variant="green-subtle" size="sm" className="pk-port">:{p.localPort}</Badge>}
        {state ? (
          <Tip label={state}><span className="devbtn busy">{I.loader}</span></Tip>
        ) : p.live ? (
          <Tip label="Stop local server">
            <span className="devbtn stop" onClick={(e) => devAction(e, p, "stop")}>{I.stop}</span>
          </Tip>
        ) : p.localPath ? (
          <Tip label="Start local server">
            <span className="devbtn play" onClick={(e) => devAction(e, p, "start")}>{I.play}</span>
          </Tip>
        ) : (
          <Tip label="Choose local folder">
            <span className="devbtn locate" onClick={(e) => devAction(e, p, "locate")}>{I.folder}</span>
          </Tip>
        )}
      </CommandItem>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* With no project the trigger is just the words "All Projects" — and the
          narrow bar hides that label, leaving an empty box. data-none lets the
          stylesheet drop it at that width instead. With a project there is
          still the logo and live dot to show, so it stays. */}
      <PopoverTrigger className="pk-trigger" data-none={value && current ? undefined : "1"}>
        {value && current ? (
          <>
            <ProjectLogo p={current} size={20} />
            <span className={"dot" + (current.live ? " on" : "")} />
            <span className="pk-trigger-name">{current.name}</span>
          </>
        ) : (
          <span className="pk-trigger-name">All Projects</span>
        )}
        {/* Vercel's switcher glyph: the two small chevrons stacked. */}
        <span className="chev chev-ud"><ChevronUpSmall /><ChevronDownSmall /></span>
      </PopoverTrigger>
      <PopoverContent ref={fadeRef} align="start" className="pk-pop">
        <TooltipProvider delay={200}>
          <Command>
            <div className="pk-search">
              <CommandInput placeholder="Find project…" />
              <kbd className="kbd" onClick={() => setOpen(false)}>Esc</kbd>
            </div>
            <CommandList className="pk-list menu-scroll">
              <CommandEmpty>No project found.</CommandEmpty>
              {live.length > 0 && <CommandGroup heading="Running locally">{live.map(Row)}</CommandGroup>}
              {rest.length > 0 && <CommandGroup heading="Other agents">{rest.map(Row)}</CommandGroup>}
            </CommandList>
          </Command>
        </TooltipProvider>
      </PopoverContent>
    </Popover>
  );
}
