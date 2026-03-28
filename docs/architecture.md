# 技術アーキテクチャ

## 方針

**モジュラーモノリス** — ドメインごとにモジュール分割し、単一リポジトリ・単一デプロイで管理する。

---

## ディレクトリ構成

```
src/
  modules/
    auth/          # Supabase GitHub認証
    diagnosis/     # ヒアリング・診断フロー
    result/        # 診断結果・命名生成
    history/       # 診断履歴の保存・取得
    visualization/ # 静的フローボード・Recharts
    ai/            # AIエンジン抽象層
      providers/
        gemini.ts  # Gemini 1.5 Flash実装
      interface.ts # AIProvider インターフェース定義
  app/             # Next.js App Router（下記ルーティング参照）
```

---

## ルーティング設計

```
app/
  layout.tsx                  # 共通レイアウト（グローバルナビ: /history リンク含む）
  page.tsx                    # ランディング（認証ガード外）
  auth/callback/page.tsx      # GitHub OAuthコールバック（認証ガード外）
  result/[id]/page.tsx        # 診断結果（認証ガード外・シェアURL対応）id = diagnosis_results.id
  (auth)/
    layout.tsx                # 認証ガード（未ログインは / にリダイレクト）
    diagnosis/page.tsx        # 現在の診断（DiagnosisFlow コンポーネント共有）
    past/page.tsx             # 過去フェーズ作成
    past/diagnosis/page.tsx   # 過去の診断（DiagnosisFlow コンポーネント共有）
    timeline/[id]/page.tsx    # 変遷図（現在診断IDで特定）
    history/page.tsx          # 診断履歴一覧
```

### ルーティング補足

- `/diagnosis` と `/past/diagnosis` は同一の `DiagnosisFlow` コンポーネントを `mode: "current" | "past"` で切り替えて共有
- 診断の各ステップ（8問 + loading）はURLを変えず、クライアント側のstateで管理する
- `/result/[id]` は認証ガード外。誰でもURLで閲覧可能（シェア用途）
- `/result/[id]` の `id` は `diagnosis_results.id`。結果に直接アクセスできるため JOIN 不要
- `/result/[id]` では未ログインユーザーに対してGitHubログインを促すバナーを表示する（ブロックはしない）
- `/timeline/[id]` の `id` は現在診断の `diagnosis_id`。`paired_diagnosis_id` で過去診断を取得する
- `/history` への遷移元はグローバルナビ + `/result/[id]` 内のリンク

---

## 認証設計

- **プロバイダー**: GitHub OAuth のみ（ゲスト診断なし）
- **実装**: Supabase Auth
- **ユーザー登録**: 初回ログイン時に `profiles` テーブルへ自動登録（`id` は `auth.users.id` と同一）
- **認証ガード**: `(auth)/layout.tsx` で未ログインユーザーをランディングにリダイレクト

---

## 共通化方針

- **型定義**: `types/` に集約し、各モジュールから参照する
- **ユーティリティ**: `lib/` にまとめ、同等の処理を複数箇所に書かない
- **UIコンポーネント**: ページ固有ロジックと分離し、共通部品として切り出す
- **定数・設定値**: 一箇所で管理し、マジックナンバーを散在させない

---

## AIエンジン設計

- **バックエンド（診断ロジック）**: Mastra — 構造化出力・プロバイダー管理
- **フロントエンド（表示）**: Vercel AI SDK — ストリーミングUI
- **初期プロバイダー**: Gemini 1.5 Flash
- **差し替え方針**: `ai/interface.ts` に `AIProvider` インターフェースを定義し、`providers/` 配下に実装を追加するだけで切り替え可能

---

## AIへの入力設計

質問テキスト・アーキテクチャ概念・回答をセットで渡すことでAIの診断精度を高める。

```typescript
{
  phase_label: "現在",
  phase_type: "current",
  answers: [
    {
      question: "最近、一番時間とエネルギーを注いでることって何？",
      concept: "コアシステム / メインワークロード",
      answer: "仕事と個人開発を半々でやってる"
    },
    // ... 8問分
  ]
}
```

---

## AIの出力スキーマ（Zod）

```typescript
const DiagnosisOutputSchema = z.object({
  architecture_name: z.string(),   // 例: "Tennis-Centric Monolith"
  description: z.string(),         // メタファーを交えた人生解説
  scores: z.object({
    throughput:      z.number().min(0).max(100),
    deploy_freq:     z.number().min(0).max(100),
    fault_tolerance: z.number().min(0).max(100),
    observability:   z.number().min(0).max(100),
    tech_debt:       z.number().min(0).max(100),
    coupling:        z.number().min(0).max(100),
  }),
  diagram_data: z.object({
    nodes: z.array(z.object({
      id:       z.string(),
      type:     z.enum(['component', 'service', 'database', 'external']),
      position: z.object({ x: z.number(), y: z.number() }),
      data:     z.object({
        label:       z.string(),
        description: z.string().optional(),
      }),
    })),
    edges: z.array(z.object({
      id:     z.string(),
      source: z.string(),
      target: z.string(),
      label:  z.string().optional(),
    })),
    flows: z.array(z.object({
      id:      z.string(),
      access:  z.string(),
      summary: z.string(),
      steps: z.array(z.object({
        node_id: z.string(),
        title:   z.string(),
        detail:  z.string(),
      })),
    })),
  }),
})
```

`diagram_data` は依存関係だけでなく、代表アクセスごとの処理順を表す `flows` を含む。結果画面ではこの `flows` を使って「どの入口アクセスが、どの順番で、どのノードを通るか」を読めるようにする。

---

## スコア軸定義

レーダーチャートの6軸。エンタメ性を重視し、エンジニアがSNSでシェアしやすい設計。

| 軸 | 高スコアの意味 | 低スコアの意味 |
|----|--------------|--------------|
| **Throughput** | 仕事もプライベートもフル稼働。処理能力が化け物 | 特にやることがない。省電力モード |
| **Deploy Freq** | 挑戦のリリースが止まらない。常にvNext | 変化を避けている。しばらく新しいことをしていない |
| **Fault Tolerance** | 障害に動じない自動フェイルオーバー人間 | ちょっとしたことで落ちる。SPOF気質 |
| **Observability** | 自分の内部状態を正確にモニタリングできる | 気づいたら限界。メトリクス未設定 |
| **Tech Debt** | 高いほどクリーン。やり残しが少ない状態 | 山積みのTODO。全部レガシー |
| **Coupling** | 他者との結びつきが強い（両義性あり） | 完全に独立。サーバーレス孤立型 |

> **Coupling の両義性**: 高くても「密結合モノリス」、低くても「孤立したサーバーレス」とAIが解説する。どちらに転んでもネタになるよう設計。

---

## AIペルソナ設計

### キャラクター定義

**ちょっと毒舌なエンジニア先輩** — 技術用語を自然に使いながら、ユーザーの人生を的確かつ少し辛口に診断する。馴れ馴れしすぎず、でも距離は近い。

| 要素 | 方針 |
|------|------|
| 口調 | タメ口に近いが丁寧。「〜ですね」より「〜だな」寄り |
| 毒舌レベル | 軽めの自虐を引き出す程度。傷つけない毒舌 |
| 技術用語 | エンジニアが即理解できる用語を自然に混ぜる |
| メタファー | 人生の出来事を技術用語に変換して解説（例: 失恋＝セッション切れ） |
| 命名 | 響きとキャッチーさ最優先。略称・英語名でSNS映えを意識 |

### トーンの例

```
悪い例（硬すぎる）:
「あなたの人生システムを分析した結果、Fault Toleranceが
 低いことが判明しました。」

良い例（ちょうどいい毒舌）:
「Fault Tolerance 18か。ちょっとしたことで落ちるタイプだな。
 まあ、それはそれでSPOF感があって人間らしいけど。」
```

### プロンプトの実装場所

設計意図はここに記述し、実際のシステムプロンプトは実装フェーズで以下に定義する。

```
src/modules/ai/prompts/diagnosis.ts
```
