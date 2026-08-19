"use client";

// The one markdown config for chat surfaces. Both the Build editor and the
// side Chat panel render agent output through Streamdown with THIS components
// map — the code block is ours (see code-block.jsx for why Streamdown's own
// never worked here), and inline code keeps the default treatment.

import type React from "react";
import { useIsCodeFenceIncomplete } from "streamdown";
import CodeBlock from "./code-block";

function MdCode({
  node: _node,
  className,
  children,
  ...props
}: { node?: unknown; className?: string; children?: React.ReactNode } & Record<string, unknown>) {
  const incomplete = useIsCodeFenceIncomplete();
  if (!("data-block" in props))
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  const language = /language-([\w-]+)/.exec(className ?? "")?.[1] ?? "";
  const code =
    typeof children === "string"
      ? children
      : ((children as { props?: { children?: unknown } } | null | undefined)?.props?.children ??
        "");
  return (
    <CodeBlock
      code={String(code)}
      language={language}
      meta={(_node as { properties?: { metastring?: string } } | undefined)?.properties?.metastring}
      isIncomplete={incomplete}
    />
  );
}

// Streamdown's Components type wants react-markdown's exact prop shapes; ours
// is the narrowed subset this app actually renders, so one cast at the source.
export const MD_COMPONENTS = { code: MdCode } as import("streamdown").StreamdownProps["components"];
