"use client";

import { useEffect, useState } from "react";

const LOG_LINES = [
  "> Parsing input vectors...",
  "> Detecting architecture patterns...",
  "> Analyzing coupling coefficients...",
  "> Calculating fault tolerance score...",
  "> Measuring deployment frequency...",
  "> Evaluating technical debt surface...",
  "> Running observability audit...",
  "> Generating architecture label...",
  "> Compiling diagnosis report...",
];

export default function LoadingScreen() {
  const [visibleLines, setVisibleLines] = useState<string[]>([]);
  const [dots, setDots] = useState(".");

  useEffect(() => {
    let lineIndex = 0;
    const interval = setInterval(() => {
      if (lineIndex < LOG_LINES.length) {
        setVisibleLines((prev) => [...prev, LOG_LINES[lineIndex]]);
        lineIndex++;
      } else {
        clearInterval(interval);
      }
    }, 600);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((d) => (d.length >= 3 ? "." : d + "."));
    }, 500);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
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
      <div
        style={{
          width: "100%",
          maxWidth: "560px",
          backgroundColor: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "8px",
          padding: "32px",
          fontFamily: "var(--font-heading)",
          fontSize: "0.85rem",
          lineHeight: "1.8",
        }}
      >
        <p
          style={{
            color: "var(--color-accent)",
            marginBottom: "16px",
            fontSize: "0.75rem",
            letterSpacing: "0.1em",
          }}
        >
          ANALYZING{dots}
        </p>
        {visibleLines.map((line, i) => (
          <p
            key={i}
            style={{
              color:
                i === visibleLines.length - 1
                  ? "var(--color-text)"
                  : "var(--color-text-muted)",
              transition: "color 300ms ease",
            }}
          >
            {line}
          </p>
        ))}
        {visibleLines.length === LOG_LINES.length && (
          <p
            style={{
              color: "var(--color-accent)",
              marginTop: "16px",
              fontWeight: 600,
            }}
          >
            &gt; Architecture matched ✓
          </p>
        )}
      </div>
    </div>
  );
}
