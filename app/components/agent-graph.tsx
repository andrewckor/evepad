"use client";

// React Flow canvas, split out so the Build route can lazy-load it. Importing
// @xyflow/react statically made it part of the route's critical chunk: the
// page couldn't paint (and the main thread stayed busy, swallowing the next
// click) until it downloaded. Now the shell paints instantly and the graph
// arrives behind the manifest loader.

import { useEffect, useState } from "react";
import { ReactFlow, Background, Controls } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

// React Flow paints its own chrome (controls, attribution, handles) from a
// colorMode prop, so it has to be told the theme rather than inheriting it.
function useThemeMode() {
  const [mode, setMode] = useState("dark");
  useEffect(() => {
    const read = () =>
      setMode(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return mode;
}

import type { Node, Edge, ColorMode } from "@xyflow/react";

// Fitting must never zoom IN past natural size: on a sparse graph the default
// fit blows a handful of nodes up to fill the pane, so recentering looked
// like a zoom bug. Capped at 1x, fit only ever pulls back to show everything.
const FIT = { maxZoom: 1 };

export default function AgentGraph({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) {
  const mode = useThemeMode();
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      fitView
      fitViewOptions={FIT}
      proOptions={{ hideAttribution: true }}
      nodesDraggable
      nodesConnectable={false}
      colorMode={mode as ColorMode}
    >
      <Background color="var(--line2)" gap={22} />
      {/* The fit button reads its own options, not the canvas's. */}
      <Controls showInteractive={false} fitViewOptions={FIT} />
    </ReactFlow>
  );
}
