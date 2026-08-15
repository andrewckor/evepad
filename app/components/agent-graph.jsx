"use client";

// React Flow canvas, split out so the Build route can lazy-load it. Importing
// @xyflow/react statically made it part of the route's critical chunk: the
// page couldn't paint (and the main thread stayed busy, swallowing the next
// click) until it downloaded. Now the shell paints instantly and the graph
// arrives behind the manifest loader.

import { ReactFlow, Background, Controls } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

export default function AgentGraph({ nodes, edges }) {
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      fitView
      proOptions={{ hideAttribution: true }}
      nodesDraggable
      nodesConnectable={false}
      colorMode="dark"
    >
      <Background color="#1f1f1f" gap={22} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
