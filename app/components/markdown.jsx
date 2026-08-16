"use client";

// The one markdown config for chat surfaces. Both the Build editor and the
// side Chat panel render agent output through Streamdown with THIS components
// map — the code block is ours (see code-block.jsx for why Streamdown's own
// never worked here), and inline code keeps the default treatment.

import { useIsCodeFenceIncomplete } from "streamdown";
import CodeBlock from "./code-block.jsx";

function MdCode({ node, className, children, ...props }) {
  const incomplete = useIsCodeFenceIncomplete();
  if (!("data-block" in props)) return <code className={className} {...props}>{children}</code>;
  const language = /language-([\w-]+)/.exec(className ?? "")?.[1] ?? "";
  const code = typeof children === "string"
    ? children
    : (children?.props?.children ?? "");
  return (
    <CodeBlock
      code={String(code)}
      language={language}
      meta={node?.properties?.metastring}
      isIncomplete={incomplete}
    />
  );
}

export const MD_COMPONENTS = { code: MdCode };
