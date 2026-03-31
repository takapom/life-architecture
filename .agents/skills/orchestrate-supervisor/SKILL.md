---
name: orchestrate-supervisor
description: 明示的なオーケストレーションスーパーバイザー。GitHubタスク状態とセッションアーティファクトからインテーク、実行、クローズ、またはレジュームを選択し、正規のフェーズランタイムに委譲する。
metadata:
  execution_mode: scripted
  runtime_entrypoint: scripts/supervisor_runtime.ts
---

# オーケストレーション スーパーバイザー

## 目的
オーケストレーションの明示的なスーパーバイザーエントリーポイントを実行する。

このスキルが担当する範囲:
- `intake`、`execute`、`resume`、`close` にわたるフェーズ選択
- GitHubタスク状態とセッションアーティファクトのみに基づく決定論的ルーティング
- 新たな信頼できる情報源を作り出すことなく、正規のフェーズランタイムへ委譲

このスキルが担当しない範囲:
- インテークへのルーティング以外のタスクイシュー作成ルール
- 実行時のノードオーケストレーションやレビューゲーティング
- クローズへのルーティング以外のクリーンアップロジック
- tmux やオペレーター CLI サーフェス

## ランタイムコマンド
```bash
# ヘルプ
bun .agents/skills/orchestrate-supervisor/scripts/supervisor_runtime.ts --help

# スーパーバイザーが選択するフェーズを確認
bun .agents/skills/orchestrate-supervisor/scripts/supervisor_runtime.ts select-phase \
  --repository owner/repo \
  --issue 5612

# グループ化された親イシューを明示的に確認
bun .agents/skills/orchestrate-supervisor/scripts/supervisor_runtime.ts select-phase \
  --repository owner/repo \
  --parent-issue 900

# 選択されたフェーズを実行
bun .agents/skills/orchestrate-supervisor/scripts/supervisor_runtime.ts run \
  --repository owner/repo \
  --issue 5612
```

## ランタイム契約
- 明示的な呼び出しのみ。このスキルは暗黙的に自動実行してはならない。
- 選択の優先順位:
  1. 現在のセッションアーティファクト（`state.json`）が存在する場合
  2. 要求されたイシューセレクタ配下のGitHubタスクイシュー状態
- `--issue` が正規のセレクタである。正規のタスクイシューに解決される場合、スーパーバイザーはまず単一タスクパスを取る。それ以外の場合はグループ化された親スコープとして扱う。
- `resume` は既存のセッション state ディレクトリを伴う execute ルーティングである。
- 終端セッション状態は `close` にルーティングされる。
- 親配下にタスクイシューがない場合は `intake` にルーティングされる。
- スタンドアロンの正規タスクイシューは直接 `execute` または `close` にルーティングされ、インテークフローを捏造しない。
- 親配下に既存のオープンタスクイシューがある場合は `execute` にルーティングされる。
- GitHub状態が `close` を示唆しているがセッション状態が欠落している場合、スーパーバイザーはランタイム状態を捏造するのではなく fail-closed でなければならない。

## 参照
- ワークフロー SoT: `docs/contracts/governance/workflow.md`
- セッションアーティファクト SoT: `docs/contracts/governance/session-artifacts.md`
- 実行フェーズ: `../orchestrate-execute/SKILL.md`
- クローズフェーズ: `../orchestrate-close/SKILL.md`
