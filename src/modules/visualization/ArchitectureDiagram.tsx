"use client";

import type { DiagramData, DiagramNode, NodeType } from "@/types";

const NODE_COLORS: Record<NodeType, string> = {
  component: "#22C55E",
  service:   "#3B82F6",
  database:  "#F59E0B",
  external:  "#8B5CF6",
};

const NODE_LABELS: Record<NodeType, string> = {
  external:  "ENTRY / EXTERNAL",
  component: "CORE COMPONENT",
  service:   "SERVICE",
  database:  "DATA STORE",
};

const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 760;
const NODE_WIDTH = 196;
const NODE_HEIGHT = 104;
const CANVAS_PADDING = 40;

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
        height: "100%",
        overflowY: "auto",
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
            borderRadius: "10px",
            overflow: "hidden",
            background:
              "radial-gradient(circle at top, rgba(30, 41, 59, 0.35), rgba(2, 6, 23, 0.92) 60%)",
          }}
        >
          <svg
            viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
            style={{ width: "100%", height: "100%", display: "block" }}
            aria-label="architecture diagram"
          >
            <defs>
              <pattern id="diagram-grid" width="28" height="28" patternUnits="userSpaceOnUse">
                <path d="M 28 0 L 0 0 0 28" fill="none" stroke="rgba(51, 65, 85, 0.28)" strokeWidth="1" />
              </pattern>
              <marker
                id="diagram-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748B" />
              </marker>
              <marker
                id="diagram-arrow-active"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#22C55E" />
              </marker>
            </defs>

            <rect x="0" y="0" width={CANVAS_WIDTH} height={CANVAS_HEIGHT} fill="url(#diagram-grid)" />

            {diagramData.edges.map((edge) => {
              const source = nodesById.get(edge.source);
              const target = nodesById.get(edge.target);
              if (!source || !target) return null;

              const sourcePos = layoutPositions.get(source.id) ?? { x: source.position.x, y: source.position.y };
              const targetPos = layoutPositions.get(target.id) ?? { x: target.position.x, y: target.position.y };
              const sourceX = clamp(sourcePos.x, CANVAS_PADDING, CANVAS_WIDTH - NODE_WIDTH - CANVAS_PADDING);
              const sourceY = clamp(sourcePos.y, CANVAS_PADDING, CANVAS_HEIGHT - NODE_HEIGHT - CANVAS_PADDING);
              const targetX = clamp(targetPos.x, CANVAS_PADDING, CANVAS_WIDTH - NODE_WIDTH - CANVAS_PADDING);
              const targetY = clamp(targetPos.y, CANVAS_PADDING, CANVAS_HEIGHT - NODE_HEIGHT - CANVAS_PADDING);
              const activeStep = activeEdgeStepByKey.get(`${edge.source}->${edge.target}`);
              const edgeLabel = activeStep ? `${activeStep}. ${edge.label}` : edge.label;
              const labelWidth = Math.max(68, (edgeLabel?.length ?? 0) * 7 + 22);
              const targetOnRight = targetX > sourceX + NODE_WIDTH / 2;
              const targetOnLeft = sourceX > targetX + NODE_WIDTH / 2;
              const isSideRoute = targetOnRight || targetOnLeft;
              const startX = isSideRoute
                ? targetOnRight ? sourceX + NODE_WIDTH : sourceX
                : sourceX + NODE_WIDTH / 2;
              const startY = isSideRoute ? sourceY + NODE_HEIGHT / 2 : sourceY + NODE_HEIGHT;
              const endX = isSideRoute
                ? targetOnRight ? targetX : targetX + NODE_WIDTH
                : targetX + NODE_WIDTH / 2;
              const endY = isSideRoute ? targetY + NODE_HEIGHT / 2 : targetY;
              const controlOffset = isSideRoute
                ? Math.max(56, Math.abs(endX - startX) * 0.45)
                : Math.max(42, Math.abs(endY - startY) * 0.55);
              const path = isSideRoute
                ? targetOnRight
                  ? `M ${startX} ${startY} C ${startX + controlOffset} ${startY}, ${endX - controlOffset} ${endY}, ${endX} ${endY}`
                  : `M ${startX} ${startY} C ${startX - controlOffset} ${startY}, ${endX + controlOffset} ${endY}, ${endX} ${endY}`
                : `M ${startX} ${startY} C ${startX} ${startY + controlOffset}, ${endX} ${endY - controlOffset}, ${endX} ${endY}`;
              const labelX = isSideRoute ? (startX + endX) / 2 : startX;
              const labelY = isSideRoute ? (startY + endY) / 2 - 14 : (startY + endY) / 2;

              return (
                <g key={edge.id}>
                  <path
                    d={path}
                    fill="none"
                    stroke={activeStep ? "#22C55E" : "#475569"}
                    strokeWidth={activeStep ? 3 : 2}
                    strokeOpacity={activeStep ? 1 : 0.78}
                    markerEnd={activeStep ? "url(#diagram-arrow-active)" : "url(#diagram-arrow)"}
                  />
                  {edge.label && (
                    <>
                      <rect
                        x={labelX - labelWidth / 2}
                        y={labelY - 12}
                        width={labelWidth}
                        height="18"
                        rx="9"
                        fill="rgba(15, 23, 42, 0.92)"
                        stroke={activeStep ? "rgba(34, 197, 94, 0.45)" : "rgba(51, 65, 85, 0.8)"}
                      />
                      <text
                        x={labelX}
                        y={labelY + 1}
                        textAnchor="middle"
                        style={{
                          fill: activeStep ? "#DCFCE7" : "#94A3B8",
                          fontFamily: "var(--font-heading)",
                          fontSize: "10px",
                          letterSpacing: "0.06em",
                        }}
                      >
                        {edgeLabel}
                      </text>
                    </>
                  )}
                </g>
              );
            })}

            {diagramData.nodes.map((node) => {
              const layoutPos = layoutPositions.get(node.id) ?? { x: node.position.x, y: node.position.y };
              const x = clamp(layoutPos.x, CANVAS_PADDING, CANVAS_WIDTH - NODE_WIDTH - CANVAS_PADDING);
              const y = clamp(layoutPos.y, CANVAS_PADDING, CANVAS_HEIGHT - NODE_HEIGHT - CANVAS_PADDING);
              const color = NODE_COLORS[node.type];
              const stepIndex = activeNodeStepById.get(node.id);
              const labelLines = wrapText(node.data.label, 18, 2);
              const descLines = wrapText(node.data.description ?? "", 20, 3);
              const dimmed = activeFlow ? !activeNodeStepById.has(node.id) : false;

              return (
                <g key={node.id} opacity={dimmed ? 0.42 : 1}>
                  <rect
                    x={x}
                    y={y}
                    width={NODE_WIDTH}
                    height={NODE_HEIGHT}
                    rx="14"
                    fill="rgba(15, 23, 42, 0.9)"
                    stroke={color}
                    strokeWidth={stepIndex ? 2.4 : 1.5}
                  />
                  {stepIndex && (
                    <text
                      x={x + NODE_WIDTH / 2}
                      y={y + 20}
                      textAnchor="middle"
                      style={{
                        fill: "#DCFCE7",
                        fontFamily: "var(--font-heading)",
                        fontSize: "10px",
                        letterSpacing: "0.16em",
                      }}
                    >
                      {`STEP ${stepIndex}`}
                    </text>
                  )}
                  {!stepIndex && node.type === "external" && (
                    <text
                      x={x + NODE_WIDTH / 2}
                      y={y + 20}
                      textAnchor="middle"
                      style={{
                        fill: "#C4B5FD",
                        fontFamily: "var(--font-heading)",
                        fontSize: "10px",
                        letterSpacing: "0.14em",
                      }}
                    >
                      ENTRY POINT
                    </text>
                  )}
                  <text
                    x={x + NODE_WIDTH / 2}
                    y={y + (stepIndex ? 44 : 38)}
                    textAnchor="middle"
                    style={{
                      fill: color,
                      fontFamily: "var(--font-heading)",
                      fontSize: "13px",
                      letterSpacing: "0.04em",
                    }}
                  >
                    {labelLines.map((line, index) => (
                      <tspan key={`${node.id}-label-${index}`} x={x + NODE_WIDTH / 2} dy={index === 0 ? 0 : 16}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                  {descLines.length > 0 && (
                    <text
                      x={x + NODE_WIDTH / 2}
                      y={y + 74}
                      textAnchor="middle"
                      style={{
                        fill: "#CBD5E1",
                        fontFamily: "var(--font-body)",
                        fontSize: "11px",
                      }}
                    >
                      {descLines.map((line, index) => (
                        <tspan key={`${node.id}-desc-${index}`} x={x + NODE_WIDTH / 2} dy={index === 0 ? 0 : 14}>
                          {line}
                        </tspan>
                      ))}
                    </text>
                  )}
                </g>
              );
            })}
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
