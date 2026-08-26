"use client";

import { useEffect, useRef, type HTMLAttributes } from "react";

export function useScrollFade(enabled = true, selector?: string) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let el: Element | null = selector ? document.querySelector(selector) : ref.current;
    let raf: number | undefined;
    let cleanup: (() => void) | undefined;

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
      const mo = new MutationObserver(update);
      mo.observe(node, { childList: true, subtree: true });
      cleanup = () => {
        node.removeEventListener("scroll", update);
        ro.disconnect();
        mo.disconnect();
      };
    }

    if (!el && selector) {
      raf = requestAnimationFrame(() => {
        el = document.querySelector(selector);
        if (el) attach(el as HTMLElement);
      });
    } else if (el) {
      attach(el as HTMLElement);
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      cleanup?.();
    };
  }, [enabled, selector]);

  return ref;
}

export function ScrollFade({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  const ref = useScrollFade();
  return <div ref={ref} className={`scroll-fade-y ${className}`} {...props} />;
}
