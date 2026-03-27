"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const PRESETS = ["学生時代", "新卒", "転職前"];

interface Props {
  currentDiagnosisId: string;
}

export default function PastPhaseSelector({ currentDiagnosisId }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<string>("");
  const [custom, setCustom] = useState("");

  const phaseLabel = selected === "__custom__" ? custom.trim() : selected;
  const canProceed = phaseLabel.length > 0;

  const handleNext = () => {
    if (!canProceed) return;
    router.push(
      `/past/diagnosis?diagnosisId=${currentDiagnosisId}&phaseLabel=${encodeURIComponent(phaseLabel)}`
    );
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        backgroundColor: "var(--color-bg)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
      }}
    >
      <div style={{ width: "100%", maxWidth: "480px" }}>
        <p
          style={{
            color: "var(--color-text-muted)",
            fontFamily: "var(--font-heading)",
            fontSize: "0.75rem",
            letterSpacing: "0.1em",
            marginBottom: "12px",
          }}
        >
          PAST PHASE
        </p>
        <h1
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "1.5rem",
            color: "var(--color-text)",
            fontWeight: 500,
            marginBottom: "32px",
            lineHeight: 1.5,
          }}
        >
          過去のどの時期を振り返る？
        </h1>

        {/* Presets */}
        <div
          style={{
            display: "flex",
            gap: "12px",
            flexWrap: "wrap",
            marginBottom: "24px",
          }}
        >
          {PRESETS.map((preset) => (
            <button
              key={preset}
              onClick={() => {
                setSelected(preset);
                setCustom("");
              }}
              style={{
                backgroundColor:
                  selected === preset ? "var(--color-accent)" : "var(--color-surface)",
                color: selected === preset ? "#020617" : "var(--color-text)",
                border: `1px solid ${
                  selected === preset ? "var(--color-accent)" : "var(--color-border)"
                }`,
                borderRadius: "6px",
                fontFamily: "var(--font-heading)",
                fontSize: "0.875rem",
                padding: "10px 20px",
                cursor: "pointer",
                transition: "all 200ms ease",
              }}
            >
              {preset}
            </button>
          ))}
          <button
            onClick={() => setSelected("__custom__")}
            style={{
              backgroundColor:
                selected === "__custom__" ? "var(--color-accent)" : "var(--color-surface)",
              color: selected === "__custom__" ? "#020617" : "var(--color-text-muted)",
              border: `1px solid ${
                selected === "__custom__" ? "var(--color-accent)" : "var(--color-border)"
              }`,
              borderRadius: "6px",
              fontFamily: "var(--font-heading)",
              fontSize: "0.875rem",
              padding: "10px 20px",
              cursor: "pointer",
              transition: "all 200ms ease",
            }}
          >
            カスタム入力
          </button>
        </div>

        {/* Custom input */}
        {selected === "__custom__" && (
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="例：20代前半、初めての転職前 など"
            style={{
              width: "100%",
              backgroundColor: "var(--color-surface)",
              border: "1px solid var(--color-accent)",
              borderRadius: "6px",
              color: "var(--color-text)",
              fontFamily: "var(--font-body)",
              fontSize: "1rem",
              padding: "12px 16px",
              outline: "none",
              marginBottom: "24px",
              boxSizing: "border-box",
            }}
          />
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "16px" }}>
          <button
            onClick={handleNext}
            disabled={!canProceed}
            style={{
              backgroundColor: canProceed ? "var(--color-accent)" : "var(--color-border)",
              color: canProceed ? "#020617" : "var(--color-text-muted)",
              fontFamily: "var(--font-heading)",
              fontWeight: 600,
              fontSize: "0.9rem",
              padding: "12px 28px",
              borderRadius: "6px",
              border: "none",
              cursor: canProceed ? "pointer" : "not-allowed",
              transition: "all 200ms ease",
            }}
          >
            診断へ →
          </button>
        </div>
      </div>
    </main>
  );
}
