"use client";

// THE menu primitives. Every popover list in the app — dropdowns, the account
// menu, sessions, the project switcher — is built from these, so they share
// one rhythm: a --menu-pad ring of space around the list, rows flush inside it
// (their hover fill is the separation, so a gap would double it), and any
// scrolling list gets a hidden bar with faded edges.
//
// Change --menu-pad / --menu-row-h in globals.css and every menu moves.

import { useEffect, useRef, type ReactNode } from "react";
import { Check } from "vercel-geist-icons";

// The edge fade is state, not decoration: a permanent mask dims the first and
// last rows of a list that fits, which reads as clipped content. data-scroll
// says which edge actually continues — the same treatment the runs table and
// the chat transcript use.
//
// Exposed as a hook because not every menu body is a MenuList: the project
// switcher renders shadcn's CommandList, which needs the same behaviour on an
// element we don't own.
export function useScrollFade(enabled = true, selector?: string) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    // Resolve the scroller. With a selector we query the document rather than
    // the ref: neither cmdk's List nor Base UI's Popup forwards a ref, and the
    // content is portalled, so there is no element to hold onto until the menu
    // opens. A rAF covers that mount gap.
    let el: Element | null = selector ? document.querySelector(selector) : ref.current;
    let raf: number | undefined;
    if (!el && selector) {
      raf = requestAnimationFrame(() => {
        const late = document.querySelector(selector);
        if (late) attach(late as HTMLElement);
      });
    }

    let cleanup: (() => void) | undefined;
    // Written straight to the DOM rather than through React state — the
    // element isn't always ours to re-render, and this is presentation only.
    function attach(node: HTMLElement) {
      const update = () => {
        const room = node.scrollHeight - node.clientHeight;
        const next =
          room <= 1
            ? "none"
            : node.scrollTop <= 1
              ? "start"
              : node.scrollTop >= room - 1
                ? "end"
                : "middle";
        if (node.dataset.scroll !== next) node.dataset.scroll = next;
      };
      update();
      node.addEventListener("scroll", update, { passive: true });
      const ro = new ResizeObserver(update);
      ro.observe(node);
      // Menus filter as you type, so the list's height changes without a
      // scroll or a resize firing.
      const mo = new MutationObserver(update);
      mo.observe(node, { childList: true, subtree: true });
      cleanup = () => {
        node.removeEventListener("scroll", update);
        ro.disconnect();
        mo.disconnect();
      };
    }

    if (el) attach(el as HTMLElement);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      cleanup?.();
    };
  }, [enabled, selector]);

  return ref;
}

// The panel body. Use inside a PopoverContent that carries `menu-pop`.
export function MenuList({
  scroll = false,
  max = 320,
  className = "",
  children,
}: {
  scroll?: boolean;
  max?: number;
  className?: string;
  children?: ReactNode;
}) {
  const ref = useScrollFade(scroll);
  return (
    <div
      ref={ref}
      className={(scroll ? "menu-scroll " : "") + className}
      style={scroll ? { maxHeight: max } : undefined}
    >
      {children}
    </div>
  );
}

// A row. `on` marks the current choice with the plain check; `trail` is
// anything that rides the right edge (a timestamp, a port, an action).
export function MenuRow({
  on = false,
  onSelect,
  trail,
  className = "",
  children,
  render,
}: {
  on?: boolean;
  onSelect?: () => void;
  trail?: ReactNode;
  className?: string;
  children?: ReactNode;
  render?: boolean;
}) {
  const inner = (
    <>
      <span className="menu-row-label">{children}</span>
      {trail !== undefined && <span className="menu-row-trail">{trail}</span>}
      {on && (
        <span className="menu-check">
          <Check />
        </span>
      )}
    </>
  );
  const cls = "menu-row" + (on ? " on" : "") + (className ? " " + className : "");
  // Anchors and other elements go through `render` so a menu row can be a
  // link without duplicating the markup.
  if (render) return <span className={cls}>{inner}</span>;
  return (
    <button type="button" className={cls} onClick={onSelect}>
      {inner}
    </button>
  );
}

export function MenuLabel({ children }: { children?: ReactNode }) {
  return <div className="menu-label">{children}</div>;
}

export function MenuSeparator() {
  return <div className="menu-sep" />;
}
