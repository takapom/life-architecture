"use client";

import Link from "next/link";
import type { DiagnosisSummary } from "@/types";

interface Props {
  diagnoses: DiagnosisSummary[];
}

export default function HistoryList({ diagnoses }: Props) {
  return (
    <main
      style={{
        minHeight: "100vh",
        backgroundColor: "var(--color-bg)",
        padding: "48px 24px",
      }}
    >
      <div style={{ maxWidth: "640px", margin: "0 auto" }}>
        <h1
          style={{
            fontFamily: "var(--font-heading)",
            fontSize: "1.75rem",
            color: "var(--color-text)",
            marginBottom: "32px",
          }}
        >
          診断履歴
        </h1>

        {diagnoses.length === 0 ? (
          <div
            style={{
              backgroundColor: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "8px",
              padding: "48px",
              textAlign: "center",
            }}
          >
            <p
              style={{
                color: "var(--color-text-muted)",
                fontFamily: "var(--font-body)",
              }}
            >
              まだ診断がありません
            </p>
            <Link
              href="/diagnosis"
              style={{
                display: "inline-block",
                marginTop: "16px",
                color: "var(--color-accent)",
                fontFamily: "var(--font-heading)",
                fontSize: "0.875rem",
                textDecoration: "none",
              }}
            >
              診断を始める →
            </Link>
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {diagnoses.map((diagnosis) => {
              const result = diagnosis.diagnosis_results;
              return (
                <li
                  key={diagnosis.id}
                  style={{
                    backgroundColor: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "8px",
                    padding: "20px 24px",
                    marginBottom: "12px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "16px",
                  }}
                >
                  <div>
                    <p
                      style={{
                        fontFamily: "var(--font-heading)",
                        fontSize: "0.7rem",
                        color:
                          diagnosis.phase_type === "current"
                            ? "var(--color-accent)"
                            : "var(--color-text-muted)",
                        letterSpacing: "0.08em",
                        marginBottom: "4px",
                      }}
                    >
                      {diagnosis.phase_label}
                    </p>
                    <p
                      style={{
                        fontFamily: "var(--font-heading)",
                        fontSize: "1rem",
                        color: "var(--color-text)",
                        fontWeight: 600,
                      }}
                    >
                      {result?.architecture_name ?? "—"}
                    </p>
                    <p
                      style={{
                        fontFamily: "var(--font-body)",
                        fontSize: "0.75rem",
                        color: "var(--color-text-muted)",
                        marginTop: "4px",
                      }}
                    >
                      {new Date(diagnosis.created_at).toLocaleDateString(
                        "ja-JP"
                      )}
                    </p>
                  </div>
                  {result && (
                    <div
                      style={{ display: "flex", gap: "8px", flexShrink: 0 }}
                    >
                      <Link
                        href={`/result/${result.id}`}
                        style={{
                          color: "var(--color-accent)",
                          fontFamily: "var(--font-heading)",
                          fontSize: "0.8rem",
                          textDecoration: "none",
                          padding: "6px 12px",
                          border: "1px solid var(--color-accent)",
                          borderRadius: "4px",
                        }}
                      >
                        結果
                      </Link>
                      {diagnosis.phase_type === "current" &&
                        diagnosis.paired_diagnosis_id && (
                          <Link
                            href={`/timeline/${diagnosis.id}`}
                            style={{
                              color: "var(--color-text-muted)",
                              fontFamily: "var(--font-heading)",
                              fontSize: "0.8rem",
                              textDecoration: "none",
                              padding: "6px 12px",
                              border: "1px solid var(--color-border)",
                              borderRadius: "4px",
                            }}
                          >
                            変遷図
                          </Link>
                        )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
