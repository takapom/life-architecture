"use client";

import { useState, useEffect } from "react";
import type { DiagnosisResult, Diagnosis } from "@/types";
import ArchitectureDiagram from "@/modules/visualization/ArchitectureDiagram";
import RadarChart from "@/modules/visualization/RadarChart";

interface Props {
  result: DiagnosisResult;
  diagnosis: Diagnosis;
  isOwner: boolean;
  isLoggedIn: boolean;
}

export default function ResultView({ result, diagnosis, isOwner, isLoggedIn }: Props) {
  const [step, setStep] = useState(0);

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

  return (
    <main
      style={{
        minHeight: "100vh",
        backgroundColor: "var(--color-bg)",
        padding: "48px 24px",
      }}
    >
      <div style={{ maxWidth: "800px", margin: "0 auto" }}>
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
            <a
              href="/"
              style={{
                color: "var(--color-accent)",
                fontFamily: "var(--font-heading)",
                fontSize: "0.8rem",
                textDecoration: "none",
              }}
            >
              ログイン →
            </a>
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
              letterSpacing: "0.1em",
              marginBottom: "8px",
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
            }}
          >
            {result.architecture_name}
          </h1>
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
              fontFamily: "var(--font-heading)",
              fontSize: "0.8rem",
              color: "var(--color-text-muted)",
              letterSpacing: "0.1em",
              marginBottom: "16px",
            }}
          >
            ARCHITECTURE DIAGRAM
          </h2>
          <div
            style={{
              backgroundColor: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "8px",
              height: "400px",
              overflow: "hidden",
            }}
          >
            <ArchitectureDiagram diagramData={result.diagram_data} />
          </div>
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
              fontFamily: "var(--font-heading)",
              fontSize: "0.8rem",
              color: "var(--color-text-muted)",
              letterSpacing: "0.1em",
              marginBottom: "16px",
            }}
          >
            PERFORMANCE METRICS
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
              fontFamily: "var(--font-heading)",
              fontSize: "0.8rem",
              color: "var(--color-text-muted)",
              letterSpacing: "0.1em",
              marginBottom: "16px",
            }}
          >
            DIAGNOSIS REPORT
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
