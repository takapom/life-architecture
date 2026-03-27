"use client";

import ReactFlow, { Background, Controls } from "reactflow";
import "reactflow/dist/style.css";
import type { DiagramData, NodeType } from "@/types";

const NODE_COLORS: Record<NodeType, string> = {
  component: "#22C55E",
  service:   "#3B82F6",
  database:  "#F59E0B",
  external:  "#8B5CF6",
};

function CustomNode({ data, type }: { data: { label: string; description?: string }; type: string }) {
  const color = NODE_COLORS[(type as NodeType) ?? "component"] ?? "#22C55E";
  return (
    <div
      style={{
        backgroundColor: "#0F172A",
        border: `1px solid ${color}`,
        borderRadius: "6px",
        padding: "10px 16px",
        minWidth: "120px",
        textAlign: "center",
      }}
    >
      <p
        style={{
          fontFamily: "var(--font-heading)",
          fontSize: "0.75rem",
          color: color,
          fontWeight: 600,
        }}
      >
        {data.label}
      </p>
      {data.description && (
        <p
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "0.65rem",
            color: "#94A3B8",
            marginTop: "4px",
          }}
        >
          {data.description}
        </p>
      )}
    </div>
  );
}

const nodeTypes = {
  component: CustomNode,
  service:   CustomNode,
  database:  CustomNode,
  external:  CustomNode,
};

interface Props {
  diagramData: DiagramData;
}

export default function ArchitectureDiagram({ diagramData }: Props) {
  const nodes = diagramData.nodes.map((n) => ({
    id:       n.id,
    type:     n.type,
    position: n.position,
    data:     n.data,
  }));

  const edges = diagramData.edges.map((e) => ({
    id:     e.id,
    source: e.source,
    target: e.target,
    label:  e.label,
    style:  { stroke: "#1E293B" },
    labelStyle: { fill: "#94A3B8", fontSize: 10 },
  }));

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      panOnDrag={false}
      zoomOnScroll={false}
      style={{ background: "#0F172A" }}
    >
      <Background color="#1E293B" gap={16} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
