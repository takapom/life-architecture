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
    visualization/ # React Flow・Recharts
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
  (auth)/
    layout.tsx                # 認証ガード（未ログインは / にリダイレクト）
    diagnosis/page.tsx        # 現在の診断（DiagnosisFlow コンポーネント共有）
    past/page.tsx             # 過去フェーズ作成
    past/diagnosis/page.tsx   # 過去の診断（DiagnosisFlow コンポーネント共有）
    result/[id]/page.tsx      # 診断結果（/history へのリンク含む）
    timeline/page.tsx         # 変遷図（現在 + 過去の比較）
    history/page.tsx          # 診断履歴一覧
```

### ルーティング補足

- `/diagnosis` と `/past/diagnosis` は同一の `DiagnosisFlow` コンポーネントを `mode: "current" | "past"` で切り替えて共有
- 診断の各ステップ（8問 + loading）はURLを変えず、クライアント側のstateで管理する
- `/result/[id]` は直接アクセス可能（シェア用途）
- `/history` への遷移元はグローバルナビ + `/result/[id]` 内のリンク

---

## 認証設計

- **プロバイダー**: GitHub OAuth のみ（ゲスト診断なし）
- **実装**: Supabase Auth
- **ユーザー登録**: 初回ログイン時に Supabase の `users` テーブルへ自動登録
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
