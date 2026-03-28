"use client";

import type { DiagnosisWithResult } from "@/types";
import ArchitectureDiagram from "./ArchitectureDiagram";
import RadarChart from "./RadarChart";

interface Props {
  current: DiagnosisWithResult;
  past: DiagnosisWithResult;
}

export default function TimelineView({ current, past }: Props) {
  const currentResult = current.diagnosis_results;
  const pastResult = past.diagnosis_results;

  if (!currentResult || !pastResult) return null;

  return (
    <main
      style={{
        minHeight: "100vh",
        backgroundColor: "var(--color-bg)",
        padding: "48px 24px",
      }}
    >
      <div style={{ maxWidth: "1200px", margin: "0 auto" }}>
        <p
          style={{
            color: "var(--color-text-muted)",
            fontFamily: "var(--font-heading)",
            fontSize: "0.75rem",
            letterSpacing: "0.1em",
            marginBottom: "12px",
          }}
        >
          ARCHITECTURE EVOLUTION
        </p>
        <h1
          style={{
            fontFamily: "var(--font-heading)",
            fontSize: "clamp(1.25rem, 3vw, 2rem)",
            color: "var(--color-text)",
            marginBottom: "48px",
            lineHeight: 1.3,
          }}
        >
          <span style={{ color: "var(--color-text-muted)" }}>
            {past.phase_label}
          </span>
          <span style={{ color: "var(--color-text-muted)", margin: "0 12px" }}>→</span>
          <span style={{ color: "var(--color-accent)" }}>現在</span>
        </h1>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(480px, 1fr))",
            gap: "32px",
          }}
        >
          {/* Past */}
          <div>
            <p
              style={{
                fontFamily: "var(--font-heading)",
                fontSize: "0.75rem",
                color: "var(--color-text-muted)",
                letterSpacing: "0.1em",
                marginBottom: "8px",
              }}
            >
              {past.phase_label.toUpperCase()}
            </p>
            <h2
              style={{
                fontFamily: "var(--font-heading)",
                fontSize: "1.25rem",
                color: "var(--color-text)",
                marginBottom: "16px",
              }}
            >
              {pastResult.architecture_name}
            </h2>
            <div
              style={{
                backgroundColor: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                height: "480px",
                marginBottom: "24px",
                overflow: "hidden",
              }}
            >
              <ArchitectureDiagram diagramData={pastResult.diagram_data} />
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                backgroundColor: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                padding: "24px",
              }}
            >
              <RadarChart scores={pastResult.scores} />
            </div>
          </div>

          {/* Current */}
          <div>
            <p
              style={{
                fontFamily: "var(--font-heading)",
                fontSize: "0.75rem",
                color: "var(--color-accent)",
                letterSpacing: "0.1em",
                marginBottom: "8px",
              }}
            >
              現在
            </p>
            <h2
              style={{
                fontFamily: "var(--font-heading)",
                fontSize: "1.25rem",
                color: "var(--color-accent)",
                marginBottom: "16px",
              }}
            >
              {currentResult.architecture_name}
            </h2>
            <div
              style={{
                backgroundColor: "var(--color-surface)",
                border: "1px solid var(--color-accent)",
                borderRadius: "8px",
                height: "480px",
                marginBottom: "24px",
                overflow: "hidden",
              }}
            >
              <ArchitectureDiagram diagramData={currentResult.diagram_data} />
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                backgroundColor: "var(--color-surface)",
                border: "1px solid var(--color-accent)",
                borderRadius: "8px",
                padding: "24px",
              }}
            >
              <RadarChart scores={currentResult.scores} />
            </div>
          </div>
        </div>

        {/* Share button (mock) */}
        <div style={{ textAlign: "center", marginTop: "48px" }}>
          <button
            disabled
            style={{
              backgroundColor: "var(--color-border)",
              color: "var(--color-text-muted)",
              fontFamily: "var(--font-heading)",
              fontSize: "0.875rem",
              padding: "12px 28px",
              borderRadius: "6px",
              border: "none",
              cursor: "not-allowed",
            }}
          >
            シェア（準備中）
          </button>
        </div>
      </div>
    </main>
  );
}
