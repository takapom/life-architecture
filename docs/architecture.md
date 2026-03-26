# 技術アーキテクチャ

## 方針

**モジュラーモノリス** — ドメインごとにモジュール分割し、単一リポジトリ・単一デプロイで管理する。

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
  app/             # Next.js App Router
```

## AIエンジン設計

- **バックエンド（診断ロジック）**: Mastra — 構造化出力・プロバイダー管理
- **フロントエンド（表示）**: Vercel AI SDK — ストリーミングUI
- **初期プロバイダー**: Gemini 1.5 Flash
- **差し替え方針**: `ai/interface.ts` に `AIProvider` インターフェースを定義し、`providers/` 配下に実装を追加するだけで切り替え可能
