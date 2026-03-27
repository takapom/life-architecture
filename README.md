# 人生アーキテクチャ診断

ユーザーの人生を「ソフトウェアアーキテクチャ」に見立てて診断・可視化するエンタメ型自己分析ツール。

**ターゲット**: ソフトウェアエンジニア（初学者〜シニア）

## Tech Stack

| レイヤー | 技術 |
|---------|------|
| フロントエンド | Next.js 15 (App Router) |
| スタイリング | Tailwind CSS + shadcn/ui |
| アーキテクチャ図 | React Flow |
| チャート | Recharts |
| DB / Auth | Supabase（GitHub認証） |
| AIエージェント | Mastra |
| AIストリーミング | Vercel AI SDK |
| AI初期プロバイダー | Gemini 1.5 Flash |
| デプロイ | Vercel |

## ドキュメント

- [要件定義](docs/requirements.md)
- [技術アーキテクチャ](docs/architecture.md)
- [データベース設計](docs/database.md)
