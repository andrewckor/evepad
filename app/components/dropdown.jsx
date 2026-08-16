"use client";

// THE dropdown. Every menu in the app hangs off a trigger like this one, but
// the Runs pickers grew their own hover-to-close <div className="menu"> while
// newer surfaces used the shadcn Popover — two behaviours, two paint jobs.
// This wraps the Popover (so positioning, dismissal, focus and the panel
// surface are identical everywhere) and exposes the two row shapes we
// actually use: a selectable row with a check, and a checkbox row.
//
// New menus should compose these pieces rather than introducing a third look.

import { useState } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Check, ChevronDownSmall } from "vercel-geist-icons";

export function Dropdown({ label, align = "start", width, className = "", children }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={"dd-trigger " + className}>
        {label}
        <span className="dd-chev"><ChevronDownSmall /></span>
      </PopoverTrigger>
      <PopoverContent align={align} className="dd-pop" style={width ? { width } : undefined}>
        {typeof children === "function" ? children(close) : children}
      </PopoverContent>
    </Popover>
  );
}

// A selectable row. `on` marks the current choice with the plain white check —
// the same mark the team menu uses, never a green circle.
export function DropdownItem({ on = false, onSelect, children }) {
  return (
    <button type="button" className={"dd-item" + (on ? " on" : "")} onClick={onSelect}>
      <span className="dd-item-label">{children}</span>
      {on && <span className="dd-check"><Check /></span>}
    </button>
  );
}

// A checkbox row, for multi-selects like the environment filter.
export function DropdownCheckItem({ checked, onToggle, children }) {
  return (
    <button type="button" className="dd-item" role="checkbox" aria-checked={checked} onClick={onToggle}>
      <span className={"cbx" + (checked ? " on" : "")}>
        {checked && (
          <svg viewBox="0 0 16 16" width="10" height="10">
            <path fill="none" stroke="currentColor" strokeWidth="2.2" d="M3 8.5l3.2 3L13 4.5" />
          </svg>
        )}
      </span>
      <span className="dd-item-label">{children}</span>
    </button>
  );
}
