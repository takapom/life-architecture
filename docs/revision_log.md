# Revision Log

## 2026-03-27

### 初期実装

- Phase 1: Next.js 15 + Supabase + Tailwind セットアップ
- Phase 2: GitHub OAuth 認証フロー
- Phase 3: DiagnosisFlow コンポーネント（8問・sessionStorage 保持・スライドトランジション）
- Phase 4: AI エンジン（Gemini 1.5 Flash + Mastra / Zod 構造化出力）
- Phase 5: 結果ページ（React Flow 構成図 + Recharts レーダーチャート・プログレッシブリビール）
- Phase 6: 過去診断フロー・変遷図（タイムライン）
- Phase 7: 履歴ページ・グローバルナビ

### 実装上の判断・注意点

- `reactflow` v11 の `nodeTypes` はコンポーネント外定義必須（再レンダリングでフラッシュ発生を防ぐため）
- Supabase の `submission_id` UNIQUE 制約 + API 側の冪等チェックで二重送信を防止
- `diagnosis_results` は RLS で公開読み取り可能（シェア URL のため）
- AI が返す `diagram_data.nodes[].type` は React Flow の `nodeType` キーと一致させる必要がある
- `DiagnosisFlow` は `mode="current" | "past"` で共有。sessionStorage キーをモードで分離
