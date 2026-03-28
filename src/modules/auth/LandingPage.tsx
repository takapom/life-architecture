// Server Component — no "use client"
// Auth flow: form GET /auth/login → Supabase OAuth redirect

interface Props {
  errorCode?: string | null;
}

function getErrorMessage(errorCode?: string | null) {
  switch (errorCode) {
    case "auth":
      return "GitHubログイン後のセッション確立に失敗しました。もう一度試してください。";
    case "auth-start":
      return "GitHubログインを開始できませんでした。Supabaseが起動しているか確認してください。";
    default:
      return null;
  }
}

// ── Inline SVG icons (no emoji, no external deps) ──────────
function IconGitHub() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0 0 22 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

// ── Static data ────────────────────────────────────────────
const STEPS = [
  {
    num: "01",
    code: "auth.signIn({ provider: 'github' })",
    label: "GitHub でログイン",
    desc: "OAuth 認証。メールアドレス不要。",
  },
  {
    num: "02",
    code: "diagnose.run({ questions: 8 })",
    label: "8 問に回答",
    desc: "生活・仕事・趣味を構造的に自問。約 5 分。",
  },
  {
    num: "03",
    code: "result.export({ format: 'diagram' })",
    label: "結果を受け取る",
    desc: "アーキテクチャ図・レーダー・レポートを即時生成。",
  },
];

const FEATURES = [
  {
    label: "Architecture Diagram",
    tag: "react-flow",
    desc: "React Flow で描画されたインタラクティブな構成図。あなたの人生のコンポーネントと依存関係を可視化。",
    // path data for a grid/table icon
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 9h18M9 21V9" />
      </svg>
    ),
  },
  {
    label: "Radar Chart",
    tag: "recharts",
    desc: "8 次元の人生スペックをレーダーチャートで分析。強みと bottleneck を一目で把握。",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polygon points="12 2 2 7 12 12 22 7 12 2" />
        <polyline points="2 17 12 22 22 17" />
        <polyline points="2 12 12 17 22 12" />
      </svg>
    ),
  },
  {
    label: "Pattern Report",
    tag: "gemini-2.0-flash",
    desc: "Gemini 2.0 Flash による詳細なパターン分析。リファクタリング提案付きのレポートを生成。",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
      </svg>
    ),
  },
];

const TERMINAL_LINES: { text: string; color: string }[] = [
  { text: "$ life-arch diagnose --interactive", color: "#3EA8FF" },
  { text: "> Analyzing life patterns...", color: "#94A3B8" },
  { text: "> Processing 8 dimensions...", color: "#94A3B8" },
  { text: "", color: "transparent" },
  { text: "┌──────────────────────────────┐", color: "#CBD5E1" },
  { text: "│  Tennis-Centric Monolith     │", color: "#CBD5E1" },
  { text: "│──────────────────────────────│", color: "#CBD5E1" },
  { text: "│  [Core]  ──▶  [Social]       │", color: "#CBD5E1" },
  { text: "│     │             │           │", color: "#CBD5E1" },
  { text: "│     ▼             ▼           │", color: "#CBD5E1" },
  { text: "│  [TechDebt]  [Coupling]      │", color: "#CBD5E1" },
  { text: "│                              │", color: "#CBD5E1" },
  { text: "│  fault_tolerance:  72 ▓▓▓░░  │", color: "#CBD5E1" },
  { text: "│  deploy_freq:      45 ▓▓░░░  │", color: "#CBD5E1" },
  { text: "│  cohesion:         88 ▓▓▓▓░  │", color: "#CBD5E1" },
  { text: "└──────────────────────────────┘", color: "#CBD5E1" },
  { text: "", color: "transparent" },
  { text: "> Pattern: Tightly-Coupled Monolith", color: "#38BDF8" },
  { text: "> Bottleneck: Passion ⟶ Distraction", color: "#38BDF8" },
  { text: "> Recommendation: Extract services", color: "#38BDF8" },
  { text: "", color: "transparent" },
  { text: "✓ Diagnosis complete in 0.42s", color: "#3EA8FF" },
];

// ── CTA button (reused in hero + footer) ──────────────────
// Server Component safe: hover handled via CSS class, no event handlers
function CtaButton({ label }: { label: string }) {
  return (
    <form action="/auth/login" method="get">
      <button type="submit" className="cta-btn">
        <IconGitHub />
        {label}
      </button>
    </form>
  );
}

// ── Main ───────────────────────────────────────────────────
export default function LandingPage({ errorCode }: Props) {
  const authError = getErrorMessage(errorCode);

  return (
    <>
      <style>{`
        .cta-btn {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          background-color: var(--color-accent);
          color: #020617;
          font-family: var(--font-heading);
          font-weight: 600;
          font-size: 0.95rem;
          padding: 14px 28px;
          border-radius: 8px;
          border: none;
          cursor: pointer;
          transition: background-color 200ms, transform 150ms, box-shadow 200ms;
          letter-spacing: 0.01em;
        }
        .cta-btn:hover {
          background-color: var(--color-accent-muted);
          transform: translateY(-1px);
          box-shadow: 0 4px 20px rgba(62,168,255,0.35);
        }
        .cta-btn:active {
          transform: translateY(0);
        }
        .cta-btn:focus-visible {
          outline: 2px solid var(--color-accent);
          outline-offset: 3px;
        }
        .feature-card {
          background-color: var(--color-surface);
          border: 1px solid var(--color-border);
          border-radius: 12px;
          padding: 28px;
          transition: border-color 200ms, transform 200ms, box-shadow 200ms;
        }
        .feature-card:hover {
          border-color: #334155;
          transform: translateY(-2px);
          box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        }
        @media (min-width: 768px) {
          .hero-grid {
            display: grid !important;
            grid-template-columns: 1fr 1fr;
            gap: clamp(32px, 5vw, 64px);
            align-items: start;
          }
        }
      `}</style>

      <main style={{ backgroundColor: "var(--color-bg)" }}>

        {/* ── HERO ──────────────────────────────────────────── */}
        <section
          style={{
            maxWidth: "1200px",
            margin: "0 auto",
            padding: "clamp(48px, 8vw, 96px) 24px clamp(64px, 10vw, 112px)",
          }}
        >
          <div
            className="hero-grid"
            style={{ display: "flex", flexDirection: "column", gap: "40px" }}
          >
            {/* ── Terminal preview ── */}
            <div>
              <div
                style={{
                  backgroundColor: "#0D1117",
                  border: "1px solid #1E293B",
                  borderRadius: "10px",
                  overflow: "hidden",
                }}
              >
                {/* macOS-style window chrome */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    padding: "10px 14px",
                    borderBottom: "1px solid #1E293B",
                    backgroundColor: "#161B22",
                  }}
                >
                  <div
                    style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#FF5F57" }}
                    aria-hidden="true"
                  />
                  <div
                    style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#FFBD2E" }}
                    aria-hidden="true"
                  />
                  <div
                    style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#28C840" }}
                    aria-hidden="true"
                  />
                  <span
                    style={{
                      marginLeft: "auto",
                      color: "#4B5563",
                      fontSize: "11px",
                      fontFamily: "var(--font-heading)",
                    }}
                  >
                    life-arch — zsh
                  </span>
                </div>
                {/* Lines */}
                <div
                  style={{ padding: "20px 24px" }}
                  aria-label="診断出力サンプル"
                >
                  {TERMINAL_LINES.map((line, i) => (
                    <div
                      key={i}
                      style={{
                        color: line.color,
                        fontFamily: "var(--font-heading)",
                        fontSize: "clamp(10px, 1.6vw, 13px)",
                        lineHeight: 1.7,
                        whiteSpace: "pre",
                      }}
                    >
                      {line.text || "\u00A0"}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* ── Hero copy ── */}
            <div>
              {/* For-engineers badge */}
              <div style={{ marginBottom: "20px" }}>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    backgroundColor: "rgba(62,168,255,0.08)",
                    border: "1px solid rgba(62,168,255,0.2)",
                    borderRadius: "999px",
                    padding: "4px 12px",
                    fontFamily: "var(--font-heading)",
                    fontSize: "11px",
                    color: "#3EA8FF",
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                  }}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="#3EA8FF" aria-hidden="true">
                    <circle cx="4" cy="4" r="4" />
                  </svg>
                  For Software Engineers
                </span>
              </div>

              <h1
                style={{
                  fontFamily: "var(--font-heading)",
                  fontSize: "clamp(1.75rem, 4vw, 2.75rem)",
                  fontWeight: 700,
                  lineHeight: 1.2,
                  color: "var(--color-text)",
                  marginBottom: "16px",
                }}
              >
                あなたの人生を
                <br />
                <span style={{ color: "var(--color-accent)" }}>アーキテクチャ</span>
                <br />
                として診断する
              </h1>

              <p
                style={{
                  color: "var(--color-text-muted)",
                  fontFamily: "var(--font-body)",
                  fontSize: "1rem",
                  lineHeight: 1.75,
                  marginBottom: "32px",
                }}
              >
                8 つの質問で、人生のコンポーネント構成・依存関係・
                技術的負債を可視化。エンジニアの語彙で自分を再定義する。
              </p>

              <CtaButton label="GitHub でログイン" />

              {authError && (
                <p
                  role="alert"
                  style={{
                    marginTop: "12px",
                    color: "#FCA5A5",
                    fontSize: "0.82rem",
                    fontFamily: "var(--font-body)",
                    lineHeight: 1.6,
                  }}
                >
                  {authError}
                </p>
              )}

              <p
                style={{
                  marginTop: "14px",
                  color: "#4B5563",
                  fontSize: "0.75rem",
                  fontFamily: "var(--font-body)",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <span>無料</span>
                <span aria-hidden="true">·</span>
                <span>約 5 分</span>
                <span aria-hidden="true">·</span>
                <span>登録不要</span>
              </p>
            </div>
          </div>
        </section>

        {/* ── HOW IT WORKS ──────────────────────────────────── */}
        <section
          aria-labelledby="how-heading"
          style={{
            borderTop: "1px solid var(--color-border)",
            padding: "clamp(48px, 8vw, 80px) 24px",
          }}
        >
          <div style={{ maxWidth: "1200px", margin: "0 auto" }}>
            <p
              aria-hidden="true"
              style={{
                fontFamily: "var(--font-heading)",
                fontSize: "11px",
                color: "var(--color-accent)",
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                marginBottom: "12px",
              }}
            >
              // how it works
            </p>
            <h2
              id="how-heading"
              style={{
                fontFamily: "var(--font-heading)",
                fontSize: "clamp(1.25rem, 2.5vw, 1.75rem)",
                fontWeight: 600,
                color: "var(--color-text)",
                marginBottom: "40px",
              }}
            >
              3 ステップで診断完了
            </h2>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                gap: "20px",
              }}
            >
              {STEPS.map((step) => (
                <div
                  key={step.num}
                  style={{
                    backgroundColor: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "10px",
                    padding: "24px",
                  }}
                >
                  <div
                    style={{
                      fontFamily: "var(--font-heading)",
                      fontSize: "11px",
                      color: "var(--color-accent)",
                      letterSpacing: "0.1em",
                      marginBottom: "12px",
                    }}
                  >
                    STEP {step.num}
                  </div>
                  <div
                    aria-hidden="true"
                    style={{
                      backgroundColor: "#0D1117",
                      border: "1px solid #1E293B",
                      borderRadius: "6px",
                      padding: "8px 12px",
                      fontFamily: "var(--font-heading)",
                      fontSize: "12px",
                      color: "#38BDF8",
                      marginBottom: "16px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {step.code}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-body)",
                      fontWeight: 600,
                      fontSize: "0.95rem",
                      color: "var(--color-text)",
                      marginBottom: "6px",
                    }}
                  >
                    {step.label}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-body)",
                      fontSize: "0.85rem",
                      color: "var(--color-text-muted)",
                      lineHeight: 1.6,
                    }}
                  >
                    {step.desc}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── WHAT YOU GET ──────────────────────────────────── */}
        <section
          aria-labelledby="output-heading"
          style={{
            borderTop: "1px solid var(--color-border)",
            padding: "clamp(48px, 8vw, 80px) 24px",
          }}
        >
          <div style={{ maxWidth: "1200px", margin: "0 auto" }}>
            <p
              aria-hidden="true"
              style={{
                fontFamily: "var(--font-heading)",
                fontSize: "11px",
                color: "var(--color-accent)",
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                marginBottom: "12px",
              }}
            >
              // output
            </p>
            <h2
              id="output-heading"
              style={{
                fontFamily: "var(--font-heading)",
                fontSize: "clamp(1.25rem, 2.5vw, 1.75rem)",
                fontWeight: 600,
                color: "var(--color-text)",
                marginBottom: "40px",
              }}
            >
              診断で得られるもの
            </h2>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                gap: "20px",
              }}
            >
              {FEATURES.map((f) => (
                <div key={f.label} className="feature-card">
                  <div
                    aria-hidden="true"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "40px",
                      height: "40px",
                      backgroundColor: "rgba(62,168,255,0.08)",
                      border: "1px solid rgba(62,168,255,0.15)",
                      borderRadius: "8px",
                      color: "var(--color-accent)",
                      marginBottom: "16px",
                    }}
                  >
                    {f.icon}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-body)",
                      fontWeight: 600,
                      fontSize: "1rem",
                      color: "var(--color-text)",
                      marginBottom: "8px",
                    }}
                  >
                    {f.label}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-body)",
                      fontSize: "0.875rem",
                      color: "var(--color-text-muted)",
                      lineHeight: 1.7,
                      marginBottom: "16px",
                    }}
                  >
                    {f.desc}
                  </div>
                  <div
                    style={{
                      display: "inline-block",
                      fontFamily: "var(--font-heading)",
                      fontSize: "11px",
                      color: "#38BDF8",
                      backgroundColor: "rgba(56,189,248,0.08)",
                      border: "1px solid rgba(56,189,248,0.15)",
                      borderRadius: "4px",
                      padding: "2px 8px",
                    }}
                  >
                    {f.tag}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── FOOTER CTA ────────────────────────────────────── */}
        <section
          aria-labelledby="footer-cta-heading"
          style={{
            borderTop: "1px solid var(--color-border)",
            padding: "clamp(48px, 8vw, 96px) 24px",
            textAlign: "center",
          }}
        >
          <div style={{ maxWidth: "560px", margin: "0 auto" }}>
            <h2
              id="footer-cta-heading"
              style={{
                fontFamily: "var(--font-heading)",
                fontSize: "clamp(1.25rem, 3vw, 1.875rem)",
                fontWeight: 700,
                color: "var(--color-text)",
                lineHeight: 1.3,
                marginBottom: "16px",
              }}
            >
              自分の人生を
              <br />
              <span style={{ color: "var(--color-accent)" }}>コードレビュー</span>
              する時間
            </h2>
            <p
              style={{
                fontFamily: "var(--font-body)",
                fontSize: "0.9rem",
                color: "var(--color-text-muted)",
                lineHeight: 1.7,
                marginBottom: "32px",
              }}
            >
              あなたのアーキテクチャには、どんなパターンが隠れているか。
            </p>

            <div
              style={{
                display: "flex",
                justifyContent: "center",
              }}
            >
              <CtaButton label="無料で診断を始める" />
            </div>

            <p
              style={{
                marginTop: "16px",
                color: "#374151",
                fontSize: "0.75rem",
                fontFamily: "var(--font-body)",
              }}
            >
              無料 · 約 5 分 · 登録不要
            </p>
          </div>
        </section>
      </main>
    </>
  );
}
