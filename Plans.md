# 人生アーキテクチャ診断 Plans.md

作成日: 2026-03-27

---

## Phase 1: プロジェクト基盤

| Task | 内容 | Status |
|------|------|--------|
| 1.1 | Next.js プロジェクト初期化（App Router / TypeScript / Tailwind） | cc:完了 |
| 1.2 | Supabase プロジェクト作成・環境変数設定（`.env.local`） | cc:完了 |
| 1.3 | DBマイグレーション：`profiles` / `diagnoses` / `diagnosis_results` テーブル作成 | cc:完了 |
| 1.4 | `types/` に共通型定義を集約（`Diagnosis`, `DiagnosisResult`, `DiagramData`, `Scores` 等） | cc:完了 |
| 1.5 | グローバルCSS・カラー変数・フォント設定（Fira Code / Fira Sans / `--color-*`） | cc:完了 |

---

## Phase 2: 認証

| Task | 内容 | Status |
|------|------|--------|
| 2.1 | Supabase Auth GitHub OAuth 設定・`createServerClient` / `createBrowserClient` のセットアップ | cc:完了 |
| 2.2 | `app/auth/callback/page.tsx`：OAuthコールバック処理・`profiles` テーブルへの初回登録 | cc:完了 |
| 2.3 | `app/(auth)/layout.tsx`：認証ガード（未ログイン → `/` リダイレクト） | cc:完了 |
| 2.4 | ランディング `app/page.tsx`：GitHubログインボタンのみのCTA（アクセントグリーン） | cc:完了 |

---

## Phase 3: 診断フロー（質問画面）

| Task | 内容 | Status |
|------|------|--------|
| 3.1 | `src/modules/diagnosis/questions.ts`：8問の質問マスタ（question / concept） | cc:完了 |
| 3.2 | `DiagnosisFlow` コンポーネント：1問ずつ表示・プログレスバー・`mode: "current" \| "past"` 対応 | cc:完了 |
| 3.3 | 回答を `sessionStorage` に保持するカスタムフック（`useAnswers`） | cc:完了 |
| 3.4 | `app/(auth)/diagnosis/page.tsx`：現在の診断ページ（`DiagnosisFlow` を `mode="current"` で利用） | cc:完了 |
| 3.5 | 質問→質問のスライドトランジション（200〜300ms / `prefers-reduced-motion` 対応） | cc:完了 |

---

## Phase 4: AI診断エンジン

| Task | 内容 | Status |
|------|------|--------|
| 4.1 | `src/modules/ai/interface.ts`：`AIProvider` インターフェース定義 | cc:完了 |
| 4.2 | `src/modules/ai/providers/gemini.ts`：Gemini 1.5 Flash 実装（Mastra 経由） | cc:完了 |
| 4.3 | `src/modules/ai/prompts/diagnosis.ts`：毒舌エンジニア先輩ペルソナのシステムプロンプト | cc:完了 |
| 4.4 | Zod スキーマ定義（`DiagnosisOutputSchema`）：`architecture_name` / `scores` / `diagram_data` 等 | cc:完了 |
| 4.5 | `POST /api/diagnosis` Route Handler：`submission_id` べき等チェック・質問マスタ enrich・Mastra呼び出し・DB保存トランザクション | cc:完了 |
| 4.6 | ローディング画面コンポーネント：ターミナル風ログ流し演出（Fira Code / 回答キーワードを含む） | cc:完了 |

---

## Phase 5: 診断結果ページ

| Task | 内容 | Status |
|------|------|--------|
| 5.1 | `app/result/[id]/page.tsx`：認証ガード外・シェアURL対応・未ログインバナー表示 | cc:完了 |
| 5.2 | アーキテクチャ名表示コンポーネント（Fira Code・大きく・アクセントグリーン） | cc:完了 |
| 5.3 | React Flow 構成図コンポーネント（`src/modules/visualization/`・読み取り専用・ノードラベルFira Code） | cc:完了 |
| 5.4 | Recharts レーダーチャートコンポーネント（6軸スコア表示） | cc:完了 |
| 5.5 | AI解説コメント表示（Fira Sans・フェードインで順次展開） | cc:完了 |
| 5.6 | 「過去も診断する」CTAボタン（1回のみ表示） | cc:完了 |

---

## Phase 6: 過去診断・変遷図

| Task | 内容 | Status |
|------|------|--------|
| 6.1 | `app/(auth)/past/page.tsx`：過去フェーズ作成画面（プリセット3種 + カスタム入力） | cc:完了 |
| 6.2 | `app/(auth)/past/diagnosis/page.tsx`：過去の診断（`DiagnosisFlow` を `mode="past"` で利用） | cc:完了 |
| 6.3 | `POST /api/diagnosis`：`paired_diagnosis_id` 付き過去診断の作成・2件目作成ブロック | cc:完了 |
| 6.4 | `app/(auth)/timeline/[id]/page.tsx`：現在・過去の構成図を並べた変遷図（2画面diff） | cc:完了 |
| 6.5 | シェアボタン（モックのみ・UI設置だけ） | cc:完了 |

---

## Phase 7: 履歴・ランディング仕上げ・品質

| Task | 内容 | Status |
|------|------|--------|
| 7.1 | `app/(auth)/history/page.tsx`：診断履歴一覧（グローバルナビ + `/result/[id]` からリンク） | cc:完了 |
| 7.2 | `app/layout.tsx`：グローバルナビ（`/history` リンク含む） | cc:完了 |
| 7.3 | ランディングページ仕上げ：アーキテクチャ図プレビュー・キャッチコピー（Fira Code） | cc:完了 |
| 7.4 | レスポンシブ対応・モバイルレイアウト調整 | cc:完了 |
| 7.5 | `docs/revision_log.md` 作成・初期エントリ記録 | cc:完了 |
