"use client";

// Streamdown and its markdown pipeline are the app's single biggest client
// chunk (~430KB) — behind this wrapper no route pays for it at first load.
// The Suspense fallback renders the raw text, so a streaming reply stays
// readable in the frames before the chunk arrives.

import { lazy, Suspense } from "react";

type MdProps = { className?: string; children: string };

const Stream = lazy(async () => {
  const [{ Streamdown }, { MD_COMPONENTS }] = await Promise.all([
    import("streamdown"),
    import("./markdown"),
  ]);
  return {
    default: ({ className, children }: MdProps) => (
      <Streamdown className={className} components={MD_COMPONENTS}>
        {children}
      </Streamdown>
    ),
  };
});

export function Md({ className, children }: MdProps) {
  return (
    <Suspense fallback={<div className={className}>{children}</div>}>
      <Stream className={className}>{children}</Stream>
    </Suspense>
  );
}

export const warmMd = () => {
  import("streamdown");
  import("./markdown");
};
