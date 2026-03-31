"use client";

import type { DiagramData, DiagramNode, NodeType } from "@/types";

// AWS-inspired color palette
const NODE_COLORS: Record<NodeType, string> = {
  external:  "#FF9900", // AWS orange  — Entry/User
  component: "#3F8624", // AWS green   — Compute/Core
  service:   "#527FFF", // AWS blue    — Service/API
  database:  "#A855F7", // Purple      — Data Store
};

const NODE_LABELS: Record<NodeType, string> = {
  external:  "Entry Point",
  component: "Core Component",
  service:   "Service Layer",
  database:  "Data Store",
};

const CANVAS_WIDTH  = 960;
const CANVAS_HEIGHT = 720;
const NODE_WIDTH    = 204;
const NODE_HEIGHT   = 96;
const CANVAS_PADDING = 40;
const ICON_BAR = 46; // width of left colored icon section

interface Props {
  diagramData: DiagramData;
  activeFlowId?: string | null;
}

function sortByPosition(a: DiagramNode, b: DiagramNode) {
  if (a.position.y !== b.position.y) return a.position.y - b.position.y;
  return a.position.x - b.position.x;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function wrapText(text: string, maxChars: number, maxLines: number) {
  const normalized = text.trim();
  if (!normalized) return [];

  const tokens = normalized.includes(" ")
    ? normalized.split(" ")
    : Array.from(normalized);
  const lines: string[] = [];
  let current = "";

  for (const token of tokens) {
    const candidate = current
      ? normalized.includes(" ")
        ? `${current} ${token}`
        : `${current}${token}`
      : token;

    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
      current = token;
    } else {
      lines.push(token.slice(0, maxChars));
      current = token.slice(maxChars);
    }

    if (lines.length === maxLines) {
      return lines.map((line, index) => index === maxLines - 1 ? `${line.slice(0, maxChars - 1)}…` : line);
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  if (lines.length > maxLines) {
    return lines.slice(0, maxLines - 1).concat(`${lines[maxLines - 1].slice(0, maxChars - 1)}…`);
  }

  return lines;
}

// AWS-style type-specific icon symbols (rendered inside the colored icon bar)
function NodeIcon({ type, cx, cy }: { type: NodeType; cx: number; cy: number }) {
  switch (type) {
    case "external":
      return (
        <g>
          <circle cx={cx} cy={cy - 8} r="7" fill="white" />
          <path
            d={`M ${cx - 11} ${cy + 13} Q ${cx - 11} ${cy + 2} ${cx} ${cy + 2} Q ${cx + 11} ${cy + 2} ${cx + 11} ${cy + 13}`}
            fill="white"
          />
        </g>
      );
    case "component":
      return (
        <g>
          <rect x={cx - 11} y={cy - 11} width="10" height="10" rx="2" fill="white" />
          <rect x={cx + 1}  y={cy - 11} width="10" height="10" rx="2" fill="white" />
          <rect x={cx - 11} y={cy + 1}  width="10" height="10" rx="2" fill="white" />
          <rect x={cx + 1}  y={cy + 1}  width="10" height="10" rx="2" fill="white" />
        </g>
      );
    case "service":
      return (
        <g>
          <line x1={cx - 11} y1={cy - 8} x2={cx + 11} y2={cy - 8} stroke="white" strokeWidth="2.5" strokeLinecap="round" />
          <line x1={cx - 11} y1={cy}     x2={cx + 11} y2={cy}     stroke="white" strokeWidth="2.5" strokeLinecap="round" />
          <line x1={cx - 11} y1={cy + 8} x2={cx + 11} y2={cy + 8} stroke="white" strokeWidth="2.5" strokeLinecap="round" />
        </g>
      );
    case "database":
      return (
        <g>
          <rect   x={cx - 10} y={cy - 7} width="20" height="14" fill="rgba(255,255,255,0.9)" />
          <ellipse cx={cx} cy={cy + 7}  rx="10" ry="4" fill="white" />
          <ellipse cx={cx} cy={cy - 7}  rx="10" ry="4" fill="white" />
          <ellipse cx={cx} cy={cy - 7}  rx="10" ry="4" fill="rgba(255,255,255,0.75)" />
        </g>
      );
  }
}

// Orthogonal (right-angle) edge routing — AWS diagram style
function getOrthogonalPath(
  srcX: number, srcY: number,
  tgtX: number, tgtY: number,
): { path: string; labelX: number; labelY: number } {
  const sw = NODE_WIDTH, sh = NODE_HEIGHT;

  const srcCX = srcX + sw / 2, srcCY = srcY + sh / 2;
  const tgtCX = tgtX + sw / 2, tgtCY = tgtY + sh / 2;
  const dx = tgtCX - srcCX;
  const dy = tgtCY - srcCY;

  // Horizontal overlap of the two boxes
  const hOverlap = Math.max(0, Math.min(srcX + sw, tgtX + sw) - Math.max(srcX, tgtX));
  const useVerticalExit = hOverlap > 30 || Math.abs(dx) < 40;

  let startX: number, startY: number, endX: number, endY: number;

  if (useVerticalExit) {
    if (dy >= 0) {
      startX = srcCX; startY = srcY + sh;
      endX   = tgtCX; endY   = tgtY;
    } else {
      startX = srcCX; startY = srcY;
      endX   = tgtCX; endY   = tgtY + sh;
    }
    if (Math.abs(startX - endX) < 10) {
      return {
        path: `M ${startX} ${startY} L ${endX} ${endY}`,
        labelX: startX + 10,
        labelY: (startY + endY) / 2,
      };
    }
    const midY = (startY + endY) / 2;
    return {
      path: `M ${startX} ${startY} L ${startX} ${midY} L ${endX} ${midY} L ${endX} ${endY}`,
      labelX: (startX + endX) / 2,
      labelY: midY - 12,
    };
  } else {
    if (dx > 0) {
      startX = srcX + sw; startY = srcCY;
      endX   = tgtX;      endY   = tgtCY;
    } else {
      startX = srcX;      startY = srcCY;
      endX   = tgtX + sw; endY   = tgtCY;
    }
    if (Math.abs(startY - endY) < 10) {
      return {
        path: `M ${startX} ${startY} L ${endX} ${endY}`,
        labelX: (startX + endX) / 2,
        labelY: startY - 12,
      };
    }
    const midX = (startX + endX) / 2;
    return {
      path: `M ${startX} ${startY} L ${midX} ${startY} L ${midX} ${endY} L ${endX} ${endY}`,
      labelX: midX + 6,
      labelY: (startY + endY) / 2 - 10,
    };
  }
}

export default function ArchitectureDiagram({ diagramData, activeFlowId }: Props) {
  const nodesById = new Map(diagramData.nodes.map((node) => [node.id, node]));
  const activeFlow = activeFlowId
    ? diagramData.flows?.find((flow) => flow.id === activeFlowId) ?? null
    : diagramData.flows?.[0] ?? null;
  const activeEdgeStepByKey = new Map<string, number>();
  const activeNodeStepById = new Map<string, number>();

  if (activeFlow) {
    activeFlow.steps.forEach((step, index) => {
      activeNodeStepById.set(step.node_id, index + 1);
      const nextStep = activeFlow.steps[index + 1];
      if (nextStep) {
        activeEdgeStepByKey.set(`${step.node_id}->${nextStep.node_id}`, index + 1);
      }
    });
  }

  const flowNodeIds = new Set(activeFlow?.steps.map((step) => step.node_id) ?? []);
  const supportNodes = diagramData.nodes
    .filter((node) => !flowNodeIds.has(node.id))
    .sort(sortByPosition);
  const layoutPositions = new Map<string, { x: number; y: number }>();

  if (activeFlow) {
    const mainNodes = activeFlow.steps
      .map((step) => nodesById.get(step.node_id))
      .filter((node): node is DiagramNode => Boolean(node));
    const centerX = (CANVAS_WIDTH - NODE_WIDTH) / 2;
    const topY = CANVAS_PADDING + 20;
    const mainGap = mainNodes.length > 1
      ? Math.max(44, (CANVAS_HEIGHT - (topY * 2) - mainNodes.length * NODE_HEIGHT) / (mainNodes.length - 1))
      : 0;

    mainNodes.forEach((node, index) => {
      layoutPositions.set(node.id, {
        x: centerX,
        y: topY + index * (NODE_HEIGHT + mainGap),
      });
    });

    const anchorYs = mainNodes.length >= 3
      ? mainNodes.slice(1, -1).map((node, index) => {
          const current = layoutPositions.get(node.id)!;
          const next = layoutPositions.get(mainNodes[index + 2].id)!;
          return Math.round((current.y + next.y) / 2);
        })
      : [];
    const fallbackAnchor = mainNodes.length >= 2
      ? Math.round((layoutPositions.get(mainNodes[0].id)!.y + layoutPositions.get(mainNodes[1].id)!.y) / 2)
      : Math.round(CANVAS_HEIGHT / 2 - NODE_HEIGHT / 2);
    const supportAnchors = anchorYs.length > 0 ? anchorYs : [fallbackAnchor];
    const mainAverageX = mainNodes.reduce((sum, node) => sum + node.position.x, 0) / Math.max(1, mainNodes.length);
    const leftSupport = supportNodes.filter((node) => node.position.x < mainAverageX);
    const rightSupport = supportNodes.filter((node) => node.position.x >= mainAverageX);

    const assignSupportPositions = (nodes: DiagramNode[], x: number) => {
      nodes.forEach((node, index) => {
        const baseAnchor = supportAnchors[Math.min(index, supportAnchors.length - 1)];
        const overflow = Math.max(0, index - supportAnchors.length + 1);
        layoutPositions.set(node.id, {
          x,
          y: baseAnchor + overflow * (NODE_HEIGHT + 42),
        });
      });
    };

    assignSupportPositions(leftSupport, 48);
    assignSupportPositions(rightSupport, CANVAS_WIDTH - NODE_WIDTH - 48);
  } else {
    const rows: DiagramNode[][] = [];

    diagramData.nodes
      .slice()
      .sort(sortByPosition)
      .forEach((node) => {
        const currentRow = rows[rows.length - 1];
        if (!currentRow || Math.abs(currentRow[0].position.y - node.position.y) > 90) {
          rows.push([node]);
          return;
        }
        currentRow.push(node);
      });

    const rowGap = rows.length > 1
      ? Math.max(40, (CANVAS_HEIGHT - 2 * CANVAS_PADDING - rows.length * NODE_HEIGHT) / (rows.length - 1))
      : 0;

    rows.forEach((row, rowIndex) => {
      const y = CANVAS_PADDING + rowIndex * (NODE_HEIGHT + rowGap);

      if (row.length === 1) {
        layoutPositions.set(row[0].id, {
          x: (CANVAS_WIDTH - NODE_WIDTH) / 2,
          y,
        });
        return;
      }

      const freeWidth = CANVAS_WIDTH - 2 * CANVAS_PADDING - row.length * NODE_WIDTH;
      const gap = freeWidth / (row.length + 1);

      row.forEach((node, index) => {
        layoutPositions.set(node.id, {
          x: CANVAS_PADDING + gap + index * (NODE_WIDTH + gap),
          y,
        });
      });
    });
  }

  return (
    <div
      style={{
        padding: "20px",
        display: "grid",
        gap: "18px",
      }}
    >
      {activeFlow && (
        <div
          style={{
            border: "1px solid var(--color-border)",
            borderRadius: "10px",
            padding: "14px 16px",
            backgroundColor: "rgba(15, 23, 42, 0.8)",
          }}
        >
          <p
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: "0.62rem",
              color: "var(--color-text-muted)",
              letterSpacing: "0.14em",
              marginBottom: "6px",
            }}
          >
            ACTIVE FLOW
          </p>
          <p
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: "0.95rem",
              color: "#DCFCE7",
              marginBottom: "8px",
            }}
          >
            {activeFlow.access}
          </p>
          <p
            style={{
              fontFamily: "var(--font-body)",
              fontSize: "0.82rem",
              color: "var(--color-text-muted)",
              lineHeight: 1.7,
            }}
          >
            {activeFlow.summary}
          </p>
        </div>
      )}

      <div
        style={{
          border: "1px solid var(--color-border)",
          borderRadius: "10px",
          padding: "14px 16px 18px",
          backgroundColor: "rgba(15, 23, 42, 0.8)",
        }}
      >
        <p
          style={{
            fontFamily: "var(--font-heading)",
            fontSize: "0.62rem",
            color: "var(--color-text-muted)",
            letterSpacing: "0.12em",
            marginBottom: "12px",
          }}
        >
          ARCHITECTURE DIAGRAM
        </p>
        <div
          style={{
            position: "relative",
            width: "100%",
            aspectRatio: `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}`,
            borderRadius: "8px",
            overflow: "hidden",
            background: "#0A1525",
          }}
        >
          <svg
            viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
            style={{ width: "100%", height: "100%", display: "block" }}
            aria-label="architecture diagram"
          >
            <defs>
              {/* Subtle dot-grid — AWS style */}
              <pattern id="diagram-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                <circle cx="0.5" cy="0.5" r="0.8" fill="rgba(71, 85, 105, 0.35)" />
              </pattern>
              {/* Default arrow */}
              <marker id="diagram-arrow" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1 L 9 5 L 0 9 L 2 5 z" fill="#64748B" />
              </marker>
              {/* Active flow arrow */}
              <marker id="diagram-arrow-active" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1 L 9 5 L 0 9 L 2 5 z" fill="#FF9900" />
              </marker>
            </defs>

            {/* Background dot grid */}
            <rect x="0" y="0" width={CANVAS_WIDTH} height={CANVAS_HEIGHT} fill="url(#diagram-grid)" />

            {/* ── Edges (orthogonal routing) ── */}
            {diagramData.edges.map((edge) => {
              const source = nodesById.get(edge.source);
              const target = nodesById.get(edge.target);
              if (!source || !target) return null;

              const srcPos = layoutPositions.get(source.id) ?? source.position;
              const tgtPos = layoutPositions.get(target.id) ?? target.position;
              const sx = clamp(srcPos.x, CANVAS_PADDING, CANVAS_WIDTH  - NODE_WIDTH  - CANVAS_PADDING);
              const sy = clamp(srcPos.y, CANVAS_PADDING, CANVAS_HEIGHT - NODE_HEIGHT - CANVAS_PADDING);
              const tx = clamp(tgtPos.x, CANVAS_PADDING, CANVAS_WIDTH  - NODE_WIDTH  - CANVAS_PADDING);
              const ty = clamp(tgtPos.y, CANVAS_PADDING, CANVAS_HEIGHT - NODE_HEIGHT - CANVAS_PADDING);

              const activeStep = activeEdgeStepByKey.get(`${edge.source}->${edge.target}`);
              const { path, labelX, labelY } = getOrthogonalPath(sx, sy, tx, ty);
              const edgeLabel = activeStep ? `${activeStep}. ${edge.label}` : edge.label;
              const labelW = Math.max(52, (edgeLabel?.length ?? 0) * 6.4 + 16);

              return (
                <g key={edge.id}>
                  <path
                    d={path}
                    fill="none"
                    stroke={activeStep ? "#FF9900" : "#334155"}
                    strokeWidth={activeStep ? 2 : 1.5}
                    strokeDasharray={activeStep ? undefined : "6 3"}
                    markerEnd={activeStep ? "url(#diagram-arrow-active)" : "url(#diagram-arrow)"}
                  />
                  {edge.label && (
                    <>
                      <rect
                        x={labelX - labelW / 2}
                        y={labelY - 10}
                        width={labelW}
                        height="16"
                        rx="3"
                        fill="#0A1525"
                        stroke={activeStep ? "rgba(255,153,0,0.5)" : "rgba(51, 65, 85, 0.9)"}
                        strokeWidth="1"
                      />
                      <text
                        x={labelX}
                        y={labelY + 2}
                        textAnchor="middle"
                        style={{
                          fill: activeStep ? "#FF9900" : "#64748B",
                          fontFamily: "var(--font-heading)",
                          fontSize: "9.5px",
                          letterSpacing: "0.04em",
                        }}
                      >
                        {edgeLabel}
                      </text>
                    </>
                  )}
                </g>
              );
            })}

            {/* ── Nodes (AWS-style left icon bar cards) ── */}
            {diagramData.nodes.map((node) => {
              const layoutPos = layoutPositions.get(node.id) ?? node.position;
              const x = clamp(layoutPos.x, CANVAS_PADDING, CANVAS_WIDTH  - NODE_WIDTH  - CANVAS_PADDING);
              const y = clamp(layoutPos.y, CANVAS_PADDING, CANVAS_HEIGHT - NODE_HEIGHT - CANVAS_PADDING);
              const color      = NODE_COLORS[node.type];
              const stepIndex  = activeNodeStepById.get(node.id);
              const dimmed     = activeFlow ? !activeNodeStepById.has(node.id) : false;
              // content area starts after icon bar + padding
              const cx = x + ICON_BAR / 2;
              const cy = y + NODE_HEIGHT / 2;
              const textX = x + ICON_BAR + 10;
              const labelLines = wrapText(node.data.label,       19, 2);
              const descLines  = wrapText(node.data.description ?? "", 22, 2);
              const labelStartY = y + 32;
              const descStartY  = labelStartY + labelLines.length * 15 + 6;

              return (
                <g key={node.id} opacity={dimmed ? 0.3 : 1}>
                  {/* Drop shadow */}
                  <rect
                    x={x + 3} y={y + 3}
                    width={NODE_WIDTH} height={NODE_HEIGHT}
                    rx="5" fill="rgba(0,0,0,0.45)"
                  />
                  {/* Card background */}
                  <rect
                    x={x} y={y}
                    width={NODE_WIDTH} height={NODE_HEIGHT}
                    rx="5"
                    fill="#0D1B2E"
                    stroke={stepIndex ? color : "rgba(255,255,255,0.08)"}
                    strokeWidth={stepIndex ? 1.5 : 1}
                  />
                  {/* Left icon bar — colored section */}
                  <rect x={x} y={y} width={ICON_BAR} height={NODE_HEIGHT} rx="5" fill={color} />
                  {/* Square right edge of icon bar (cancel right-side rounding) */}
                  <rect x={x + ICON_BAR - 6} y={y} width="6" height={NODE_HEIGHT} fill={color} />

                  {/* Type-specific icon */}
                  <NodeIcon type={node.type} cx={cx} cy={cy} />

                  {/* Category label */}
                  <text
                    x={textX}
                    y={y + 18}
                    style={{
                      fill: "rgba(255,255,255,0.38)",
                      fontFamily: "var(--font-heading)",
                      fontSize: "8px",
                      letterSpacing: "0.12em",
                    }}
                  >
                    {NODE_LABELS[node.type].toUpperCase()}
                  </text>

                  {/* Step badge (top-right corner) */}
                  {stepIndex && (
                    <>
                      <circle cx={x + NODE_WIDTH - 14} cy={y + 14} r="11" fill={color} />
                      <text
                        x={x + NODE_WIDTH - 14}
                        y={y + 18.5}
                        textAnchor="middle"
                        style={{
                          fill: "white",
                          fontFamily: "var(--font-heading)",
                          fontSize: "10px",
                          fontWeight: "700",
                        }}
                      >
                        {stepIndex}
                      </text>
                    </>
                  )}

                  {/* Node label */}
                  <text
                    x={textX}
                    y={labelStartY}
                    style={{
                      fill: "white",
                      fontFamily: "var(--font-heading)",
                      fontSize: "12px",
                      fontWeight: "600",
                    }}
                  >
                    {labelLines.map((line, i) => (
                      <tspan key={`${node.id}-l${i}`} x={textX} dy={i === 0 ? 0 : 15}>
                        {line}
                      </tspan>
                    ))}
                  </text>

                  {/* Description */}
                  {descLines.length > 0 && (
                    <text
                      x={textX}
                      y={descStartY}
                      style={{
                        fill: "rgba(255,255,255,0.45)",
                        fontFamily: "var(--font-body)",
                        fontSize: "9.5px",
                      }}
                    >
                      {descLines.map((line, i) => (
                        <tspan key={`${node.id}-d${i}`} x={textX} dy={i === 0 ? 0 : 13}>
                          {line}
                        </tspan>
                      ))}
                    </text>
                  )}
                </g>
              );
            })}

            {/* ── Legend ── */}
            <g transform={`translate(16, ${CANVAS_HEIGHT - 28})`}>
              {(Object.entries(NODE_COLORS) as [NodeType, string][]).map(([type, color], i) => (
                <g key={type} transform={`translate(${i * 132}, 0)`}>
                  <rect x="0" y="-9" width="12" height="12" rx="2" fill={color} />
                  <text
                    x="16"
                    y="1"
                    style={{
                      fill: "rgba(255,255,255,0.38)",
                      fontFamily: "var(--font-heading)",
                      fontSize: "9px",
                    }}
                  >
                    {NODE_LABELS[type]}
                  </text>
                </g>
              ))}
            </g>
          </svg>
        </div>
      </div>

      {activeFlow ? (
        <div style={{ display: "grid", gap: "14px" }}>
          {activeFlow.steps.map((step, index) => {
            const node = nodesById.get(step.node_id);
            const nodeType = node?.type ?? "component";
            const color = NODE_COLORS[nodeType];
            const isLast = index === activeFlow.steps.length - 1;

            return (
              <div
                key={`${activeFlow.id}-${step.node_id}-${index}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "40px minmax(0, 1fr)",
                  gap: "12px",
                  alignItems: "stretch",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                  <div
                    style={{
                      width: "32px",
                      height: "32px",
                      borderRadius: "999px",
                      border: `1px solid ${color}`,
                      color: color,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontFamily: "var(--font-heading)",
                      fontSize: "0.76rem",
                      backgroundColor: "rgba(15, 23, 42, 0.85)",
                    }}
                  >
                    {index + 1}
                  </div>
                  {!isLast && (
                    <div
                      style={{
                        width: "2px",
                        flex: 1,
                        marginTop: "8px",
                        background: `linear-gradient(180deg, ${color}, rgba(148, 163, 184, 0.35))`,
                        minHeight: "24px",
                      }}
                    />
                  )}
                </div>

                <div
                  style={{
                    border: `1px solid ${color}`,
                    borderRadius: "10px",
                    padding: "14px 16px",
                    backgroundColor: "rgba(15, 23, 42, 0.85)",
                    boxShadow: `0 0 12px ${color}22`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: "12px",
                      alignItems: "center",
                      marginBottom: "10px",
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-heading)",
                        fontSize: "0.62rem",
                        color: color,
                        letterSpacing: "0.08em",
                      }}
                    >
                      {NODE_LABELS[nodeType]}
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--font-heading)",
                        fontSize: "0.62rem",
                        color: "var(--color-text-muted)",
                        letterSpacing: "0.08em",
                      }}
                    >
                      {step.title}
                    </span>
                  </div>
                  <p
                    style={{
                      fontFamily: "var(--font-heading)",
                      fontSize: "1rem",
                      color: color,
                      marginBottom: "8px",
                    }}
                  >
                    {node?.data.label ?? step.node_id}
                  </p>
                  {node?.data.description && (
                    <p
                      style={{
                        fontFamily: "var(--font-body)",
                        fontSize: "0.8rem",
                        color: "var(--color-text)",
                        lineHeight: 1.7,
                        marginBottom: "8px",
                      }}
                    >
                      {node.data.description}
                    </p>
                  )}
                  <p
                    style={{
                      fontFamily: "var(--font-body)",
                      fontSize: "0.78rem",
                      color: "var(--color-text-muted)",
                      lineHeight: 1.7,
                    }}
                  >
                    {step.detail}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "12px",
          }}
        >
          {diagramData.nodes.sort(sortByPosition).map((node) => (
            <div
              key={node.id}
              style={{
                border: `1px solid ${NODE_COLORS[node.type]}`,
                borderRadius: "10px",
                padding: "14px 16px",
                backgroundColor: "rgba(15, 23, 42, 0.85)",
              }}
            >
              <p
                style={{
                  fontFamily: "var(--font-heading)",
                  fontSize: "0.62rem",
                  color: NODE_COLORS[node.type],
                  letterSpacing: "0.08em",
                  marginBottom: "8px",
                }}
              >
                {NODE_LABELS[node.type]}
              </p>
              <p
                style={{
                  fontFamily: "var(--font-heading)",
                  fontSize: "0.95rem",
                  color: NODE_COLORS[node.type],
                  marginBottom: "8px",
                }}
              >
                {node.data.label}
              </p>
              {node.data.description && (
                <p
                  style={{
                    fontFamily: "var(--font-body)",
                    fontSize: "0.78rem",
                    color: "var(--color-text-muted)",
                    lineHeight: 1.7,
                  }}
                >
                  {node.data.description}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {supportNodes.length > 0 && (
        <div
          style={{
            border: "1px solid var(--color-border)",
            borderRadius: "10px",
            padding: "14px 16px",
            backgroundColor: "rgba(15, 23, 42, 0.65)",
          }}
        >
          <p
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: "0.62rem",
              color: "var(--color-text-muted)",
              letterSpacing: "0.12em",
              marginBottom: "12px",
            }}
          >
            SUPPORTING NODES
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "10px",
            }}
          >
            {supportNodes.map((node) => (
              <div
                key={node.id}
                style={{
                  border: `1px solid ${NODE_COLORS[node.type]}`,
                  borderRadius: "8px",
                  padding: "12px 14px",
                  backgroundColor: "rgba(2, 6, 23, 0.45)",
                }}
              >
                <p
                  style={{
                    fontFamily: "var(--font-heading)",
                    fontSize: "0.62rem",
                    color: NODE_COLORS[node.type],
                    letterSpacing: "0.08em",
                    marginBottom: "6px",
                  }}
                >
                  {NODE_LABELS[node.type]}
                </p>
                <p
                  style={{
                    fontFamily: "var(--font-heading)",
                    fontSize: "0.82rem",
                    color: "var(--color-text)",
                    marginBottom: "6px",
                  }}
                >
                  {node.data.label}
                </p>
                {node.data.description && (
                  <p
                    style={{
                      fontFamily: "var(--font-body)",
                      fontSize: "0.74rem",
                      color: "var(--color-text-muted)",
                      lineHeight: 1.7,
                    }}
                  >
                    {node.data.description}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}
