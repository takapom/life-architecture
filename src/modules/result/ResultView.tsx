"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import type { DiagnosisResult, Diagnosis } from "@/types";
import dynamic from "next/dynamic";

const ArchitectureDiagram = dynamic(
  () => import("@/modules/visualization/ArchitectureDiagram"),
  { ssr: false }
);
import RadarChart from "@/modules/visualization/RadarChart";

interface Props {
  result: DiagnosisResult;
  diagnosis: Diagnosis;
  isOwner: boolean;
  isLoggedIn: boolean;
}

function joinLabels(labels: string[]) {
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} と ${labels[1]}`;
  return `${labels.slice(0, -1).join("、")} と ${labels[labels.length - 1]}`;
}

function buildOverviewFallback(result: DiagnosisResult) {
  const nodes = result.diagram_data.nodes;
  const targetIds = new Set(result.diagram_data.edges.map((edge) => edge.target));
  const entryNodes = nodes.filter((node) => !targetIds.has(node.id));
  const coreNodes = nodes.filter((node) => node.type === "component");
  const serviceNodes = nodes.filter((node) => node.type === "service");
  const storeNodes = nodes.filter((node) => node.type === "database");
  const entryLabel = joinLabels(entryNodes.map((node) => node.data.label)) || "入口";
  const coreLabel = joinLabels(coreNodes.map((node) => node.data.label)) || result.architecture_name;
  const serviceLabel = joinLabels(serviceNodes.map((node) => node.data.label));
  const storeLabel = joinLabels(storeNodes.map((node) => node.data.label));

  return {
    headline: `${result.architecture_name}。${entryLabel} から ${coreLabel} に入力が集まり、全体を回している構成。`,
    composition: serviceLabel || storeLabel
      ? `${coreLabel} を中核に、${joinLabels([serviceLabel, storeLabel].filter(Boolean))} が結びついて支えている。`
      : `${coreLabel} が単一の中心として全体を担っている。`,
  };
}

export default function ResultView({ result, diagnosis, isOwner, isLoggedIn }: Props) {
  const [step, setStep] = useState(0);
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(
    result.diagram_data.flows?.[0]?.id ?? null
  );
  const flows = result.diagram_data.flows ?? [];
  const selectedFlow = flows.find((flow) => flow.id === selectedFlowId) ?? flows[0] ?? null;
  const nodeLabelById = Object.fromEntries(
    result.diagram_data.nodes.map((node) => [node.id, node.data.label])
  );
  const overview = result.diagram_data.overview ?? buildOverviewFallback(result);

  useEffect(() => {
    const timers = [
      setTimeout(() => setStep(1), 300),
      setTimeout(() => setStep(2), 800),
      setTimeout(() => setStep(3), 1400),
      setTimeout(() => setStep(4), 2000),
      setTimeout(() => setStep(5), 2600),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    setSelectedFlowId(result.diagram_data.flows?.[0]?.id ?? null);
  }, [result.id, result.diagram_data.flows]);

  return (
    <main
      style={{
        minHeight: "100vh",
        backgroundColor: "var(--color-bg)",
        padding: "48px 24px",
      }}
    >
      <div style={{ maxWidth: "1100px", margin: "0 auto" }}>
        {/* Unauthenticated banner */}
        {!isLoggedIn && (
          <div
            style={{
              backgroundColor: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "6px",
              padding: "12px 16px",
              marginBottom: "32px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "8px",
            }}
          >
            <p style={{ color: "var(--color-text-muted)", fontFamily: "var(--font-body)", fontSize: "0.875rem" }}>
              GitHubログインで自分の診断を保存できます
            </p>
            <Link
              href="/"
              style={{
                color: "var(--color-accent)",
                fontFamily: "var(--font-heading)",
                fontSize: "0.8rem",
                textDecoration: "none",
              }}
            >
              ログイン →
            </Link>
          </div>
        )}

        {/* Architecture name */}
        <div
          style={{
            opacity: step >= 1 ? 1 : 0,
            transform: step >= 1 ? "translateY(0)" : "translateY(16px)",
            transition: "opacity 500ms ease, transform 500ms ease",
            marginBottom: "48px",
          }}
        >
          <p
            style={{
              color: "var(--color-text-muted)",
              fontFamily: "var(--font-heading)",
              fontSize: "0.75rem",
              letterSpacing: "0.06em",
              marginBottom: "12px",
            }}
          >
            {diagnosis.phase_label} / {diagnosis.phase_type === "current" ? "現在" : "過去"}
          </p>
          <h1
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: "clamp(1.5rem, 4vw, 2.5rem)",
              color: "var(--color-accent)",
              fontWeight: 700,
              lineHeight: 1.2,
              marginBottom: "16px",
            }}
          >
            {result.architecture_name}アーキテクチャ
          </h1>
          <p
            style={{
              fontFamily: "var(--font-body)",
              fontSize: "1rem",
              color: "var(--color-text-muted)",
              lineHeight: 1.8,
              maxWidth: "640px",
            }}
          >
            {overview.headline}
            {overview.composition && (
              <> {overview.composition}</>
            )}
          </p>
        </div>

        {/* Architecture diagram */}
        <div
          style={{
            opacity: step >= 2 ? 1 : 0,
            transition: "opacity 600ms ease",
            marginBottom: "48px",
          }}
        >
          <h2
            style={{
              fontFamily: "var(--font-body)",
              fontSize: "0.875rem",
              fontWeight: 600,
              color: "var(--color-text-muted)",
              marginBottom: "16px",
            }}
          >
            アーキテクチャ図
          </h2>
          {flows.length > 0 && (
            <p
              style={{
                fontFamily: "var(--font-body)",
                fontSize: "0.85rem",
                color: "var(--color-text-muted)",
                lineHeight: 1.7,
                marginBottom: "16px",
              }}
            >
              `ENTRY POINT` が入口。下のアクセスを選ぶと、図の中でその処理経路を順番付きで追える。
            </p>
          )}
          <div
            style={{
              backgroundColor: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "8px",
            }}
          >
            <ArchitectureDiagram
              diagramData={result.diagram_data}
              activeFlowId={selectedFlow?.id ?? null}
            />
          </div>
          {flows.length > 0 && selectedFlow && (
            <div
              style={{
                marginTop: "20px",
                backgroundColor: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                padding: "20px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "10px",
                  marginBottom: "16px",
                }}
              >
                {flows.map((flow) => {
                  const isActive = flow.id === selectedFlow.id;

                  return (
                    <button
                      key={flow.id}
                      type="button"
                      onClick={() => setSelectedFlowId(flow.id)}
                      style={{
                        border: `1px solid ${isActive ? "var(--color-accent)" : "var(--color-border)"}`,
                        backgroundColor: isActive ? "rgba(34, 197, 94, 0.12)" : "transparent",
                        color: isActive ? "#DCFCE7" : "var(--color-text-muted)",
                        borderRadius: "999px",
                        padding: "8px 14px",
                        fontFamily: "var(--font-heading)",
                        fontSize: "0.72rem",
                        letterSpacing: "0.04em",
                        cursor: "pointer",
                      }}
                    >
                      {flow.access}
                    </button>
                  );
                })}
              </div>

              <p
                style={{
                  fontFamily: "var(--font-body)",
                  fontSize: "0.92rem",
                  color: "var(--color-text)",
                  lineHeight: 1.8,
                  marginBottom: "18px",
                }}
              >
                {selectedFlow.summary}
              </p>

              <div style={{ display: "grid", gap: "12px" }}>
                {selectedFlow.steps.map((flowStep, flowIndex) => (
                  <div
                    key={`${selectedFlow.id}-${flowStep.node_id}-${flowIndex}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "36px minmax(0, 1fr)",
                      gap: "12px",
                      alignItems: "start",
                      paddingTop: flowIndex === 0 ? "0" : "12px",
                      borderTop: flowIndex === 0 ? "none" : "1px solid var(--color-border)",
                    }}
                  >
                    <div
                      style={{
                        width: "32px",
                        height: "32px",
                        borderRadius: "999px",
                        border: "1px solid var(--color-accent)",
                        color: "var(--color-accent)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontFamily: "var(--font-heading)",
                        fontSize: "0.76rem",
                      }}
                    >
                      {flowIndex + 1}
                    </div>
                    <div>
                      <p
                        style={{
                          fontFamily: "var(--font-heading)",
                          fontSize: "0.78rem",
                          color: "var(--color-accent)",
                          marginBottom: "4px",
                        }}
                      >
                        {nodeLabelById[flowStep.node_id] ?? flowStep.node_id}
                      </p>
                      <p
                        style={{
                          fontFamily: "var(--font-body)",
                          fontSize: "0.92rem",
                          color: "var(--color-text)",
                          marginBottom: "4px",
                        }}
                      >
                        {flowStep.title}
                      </p>
                      <p
                        style={{
                          fontFamily: "var(--font-body)",
                          fontSize: "0.84rem",
                          color: "var(--color-text-muted)",
                          lineHeight: 1.7,
                        }}
                      >
                        {flowStep.detail}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Radar chart */}
        <div
          style={{
            opacity: step >= 3 ? 1 : 0,
            transition: "opacity 600ms ease",
            marginBottom: "48px",
          }}
        >
          <h2
            style={{
              fontFamily: "var(--font-body)",
              fontSize: "0.875rem",
              fontWeight: 600,
              color: "var(--color-text-muted)",
              marginBottom: "16px",
            }}
          >
            特性スコア
          </h2>
          <div
            style={{
              backgroundColor: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "8px",
              padding: "32px",
              display: "flex",
              justifyContent: "center",
            }}
          >
            <RadarChart scores={result.scores} />
          </div>
        </div>

        {/* AI description */}
        <div
          style={{
            opacity: step >= 4 ? 1 : 0,
            transition: "opacity 600ms ease",
            marginBottom: "48px",
          }}
        >
          <h2
            style={{
              fontFamily: "var(--font-body)",
              fontSize: "0.875rem",
              fontWeight: 600,
              color: "var(--color-text-muted)",
              marginBottom: "16px",
            }}
          >
            診断レポート
          </h2>
          <div
            style={{
              backgroundColor: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "8px",
              padding: "32px",
            }}
          >
            <p
              style={{
                fontFamily: "var(--font-body)",
                fontSize: "1rem",
                color: "var(--color-text)",
                lineHeight: "1.8",
                whiteSpace: "pre-wrap",
              }}
            >
              {result.description}
            </p>
          </div>
        </div>

        {/* Past diagnosis CTA (only for current phase, owner, no past yet) */}
        {step >= 5 && diagnosis.phase_type === "current" && isOwner && !diagnosis.paired_diagnosis_id && (
          <div
            style={{
              opacity: 1,
              transition: "opacity 600ms ease",
              textAlign: "center",
              paddingBottom: "48px",
            }}
          >
            <div
              style={{
                backgroundColor: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                padding: "32px",
              }}
            >
              <p
                style={{
                  fontFamily: "var(--font-body)",
                  color: "var(--color-text-muted)",
                  marginBottom: "16px",
                  fontSize: "0.9rem",
                }}
              >
                過去の自分はどんなアーキテクチャだった？
              </p>
              <a
                href={`/past?diagnosisId=${diagnosis.id}`}
                style={{
                  display: "inline-block",
                  backgroundColor: "var(--color-accent)",
                  color: "#020617",
                  fontFamily: "var(--font-heading)",
                  fontWeight: 600,
                  fontSize: "0.9rem",
                  padding: "12px 28px",
                  borderRadius: "6px",
                  textDecoration: "none",
                }}
              >
                過去も診断する
              </a>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
