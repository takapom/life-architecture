"use client";

import { createClient } from "@/lib/supabase/client";

export default function LandingPage() {
  const handleLogin = async () => {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "github",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
  };

  return (
    <main
      style={{ minHeight: "100vh", backgroundColor: "var(--color-bg)" }}
      className="flex flex-col items-center justify-center px-4"
    >
      <div className="max-w-2xl w-full text-center space-y-8">
        {/* Architecture preview */}
        <div
          style={{
            backgroundColor: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "8px",
            padding: "24px",
            fontFamily: "var(--font-heading)",
            fontSize: "12px",
            color: "var(--color-text-muted)",
            textAlign: "left",
            lineHeight: "1.6",
          }}
        >
          <pre>{`┌─────────────────────────────────┐
│  Tennis-Centric Monolith        │
│─────────────────────────────────│
│  [Core System]  ──▶  [Social]   │
│       │                  │      │
│       ▼                  ▼      │
│  [Tech Debt]       [Coupling]   │
│  fault_tolerance: 72            │
│  deploy_freq:     45            │
└─────────────────────────────────┘`}</pre>
        </div>

        {/* Hero text */}
        <div className="space-y-3">
          <h1
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: "clamp(1.5rem, 4vw, 2.5rem)",
              color: "var(--color-accent)",
              fontWeight: 700,
            }}
          >
            人生アーキテクチャ診断
          </h1>
          <p
            style={{
              color: "var(--color-text-muted)",
              fontFamily: "var(--font-body)",
              fontSize: "1rem",
              lineHeight: "1.7",
            }}
          >
            8つの質問に答えるだけ。
            <br />
            あなたの人生をソフトウェアアーキテクチャとして診断します。
          </p>
        </div>

        {/* CTA */}
        <button
          onClick={handleLogin}
          style={{
            backgroundColor: "var(--color-accent)",
            color: "#020617",
            fontFamily: "var(--font-heading)",
            fontWeight: 600,
            fontSize: "1rem",
            padding: "14px 32px",
            borderRadius: "6px",
            border: "none",
            cursor: "pointer",
            transition: "background-color 200ms ease",
          }}
          onMouseEnter={(e) =>
            ((e.target as HTMLElement).style.backgroundColor =
              "var(--color-accent-muted)")
          }
          onMouseLeave={(e) =>
            ((e.target as HTMLElement).style.backgroundColor =
              "var(--color-accent)")
          }
        >
          GitHub でログイン
        </button>

        <p
          style={{
            color: "var(--color-text-muted)",
            fontSize: "0.75rem",
            fontFamily: "var(--font-body)",
          }}
        >
          診断は無料・所要時間約5分
        </p>
      </div>
    </main>
  );
}
