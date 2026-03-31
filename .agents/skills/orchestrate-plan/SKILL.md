---
name: orchestrate-plan
description: オーケストレーションのフェーズ1。生の要件をGitHubタスクイシューに正規化する。実行プランのコンパイルは execute フェーズが担当する。
metadata:
  execution_mode: scripted
  runtime_entrypoint: scripts/plan_runtime.ts
---

# オーケストレーション インテーク

## 目的
オーケストレーションフローのフェーズ1（`intake`）を実行する。

主要ケイパビリティ: `project-manager`。

このフェーズが担当する範囲:
- 生の要件 -> 正規化/ファクトチェック済みタスクイシュー
- 正規のGitHubタスクテンプレートに対する決定論的タスクイシューの upsert
- 実行開始前に必要なインテーク時のイシュー契約の強制
- execute プリフライト用の派生実行プラン契約の検証

このフェーズが担当しない範囲:
- GitHubタスクイシューからの実行プランのコンパイル
- 実行時の依存関係検証/実行可能ノードの選択
- サブエージェント実装の実行
- マージ/クリーンアップ操作

## ランタイムコマンド
```bash
# ヘルプ
bun .agents/skills/orchestrate-plan/scripts/plan_runtime.ts --help

# インテーク: 決定論的タスクイシューの upsert（バッチ）
bun .agents/skills/orchestrate-plan/scripts/issue_runtime.ts upsert-task-issues \
  --repository owner/repo \
  --input .tmp/task-issues.json \
  --issue-number 712

# インテーク: グループ化されたマルチタスクフロー
bun .agents/skills/orchestrate-plan/scripts/plan_runtime.ts intake-upsert \
  --input .tmp/task-issues.json \
  --repository owner/repo \
  --parent-issue 900

# インテーク: 派生実行プラン契約に対するタスクイシューの検証
bun .agents/skills/orchestrate-plan/scripts/plan_runtime.ts intake-validate \
  --repository owner/repo \
  [--source ./.tmp/issues.json]
```

## 必須契約
- イシュー upsert コマンドの要件:
  - ペイロード形式は `{ "items": [...] }` のみ
  - 各アイテムには明示的な `task_id` が必要（タイトル/本文/ラベルからの推論はサポート外）
  - GitHub認証（`GH_TOKEN` または認証済み `gh` セッション）
  - `--repository <owner/repo>` は必須
  - 既存のオープンイシューは重複タスクイシューを作成するのではなく、`--issue-number <number|url>` で正規化すべき
  - 親イシューはタスクがグループ化されたマルチタスクフローに属する場合のみ `--parent-issue <number|url>` で指定する（ペイロードの `parent_issue_*` はサポート外）
  - スタンドアロンのタスクイシューでは `--parent-issue` を省略できる
  - 2件以上のタスクイシューを1回で upsert する場合は `--parent-issue` が必須
  - `--parent-issue` が指定されたタスクイシューのみが親イシューのサブイシューとしてリンクされる
- `intake-validate` には `--repository <owner/repo>` が必須。
- `intake-validate` は派生実行プラン契約を検証するが、インテーク所有の実行プランアーティファクトは発行しない。
- 派生実行プラン検証の要件:
  - `issue_tracking.strategy: remote-github-sot`
  - `issue_tracking.repository`
  - 空でない `issue_map`
  - `source_items[].parent_issue_number` と `source_items[].parent_issue_url` はオプションだが、片方がある場合は両方必須
  - `issue_map` のソースごとのイシューURLが一意（重複URL禁止）
  - `nodes[].github_issue` が必須かつノード間で一意
  - `nodes[].github_issue` と `issue_map` / `covers` が整合
  - 空でない `nodes`

## 参照
- フェーズ契約: `docs/contracts/governance/workflow.md`
- ワークフロー SoT: `docs/contracts/governance/workflow.md`
- 実行プラン契約: `docs/contracts/governance/execution-plan.md`
- タスクテンプレート SoT: `references/issue-template-sot.md`
- ファクトチェックプレイブック: `references/fact-check-playbook.md`
