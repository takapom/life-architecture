# Issue テンプレート SoT

## 正規ソース
- `.github/ISSUE_TEMPLATE/task.yml` がタスク Issue フィールドの唯一の SoT（Single Source of Truth）。
- このスキルは正規テンプレートを参照しなければならず、テンプレート本体をコピーしてはならない。

## 標準パス
- 標準オーケストレーションの語彙は `intake` -> `execute` -> `close`。
- `orchestrate-plan` は intake Issue の作成/検証のみを担当する。永続化された実行プランアーティファクトの作成は行わない。

## フィールド整合ルール
- `Summary`: 必須の成果物。
- `Background / Context`: 関連 Issue やインシデントの参照とコンテキスト。
- `Task ID`: 機械可読な `<DOMAIN>-<NNN+>` 形式の ID。
- `Task Type`: `feature|bugfix|refactor|ops|docs|chore` のいずれか。
- `Status`: `backlog|ready|in progress|in review|done` のいずれか。
- `Priority`: 整数。小さいほど高優先度。
- `Allowed Files`: このタスクが変更可能なファイル/パスパターン。
- `Acceptance Checks`: マージ前に必要な客観的チェック。
- `Tests`: このタスクの具体的なテストコマンド。
- `Non-goals`: 明示的なスコープ外の制約。
- `Commit Units`: 1つの worktree/タスク内で実行されるレビュー可能なコミットチェックポイント。
- `Acceptance Criteria`: 客観的な合格条件。
- `RCA / Impact Scope`: バグ修正コンテキストに必須。

## タスク ID ルール
- `Task ID` は `<DOMAIN>-<NNN+>` 形式のみとする。
- タイトル/ラベルのスレッドマーカー（`[th:*]`、`agent-thread:*`）は規約外であり、ゲーティングに使用してはならない。

## 実行チェックリスト
1. タスク Issue を作成または更新する前に `.github/ISSUE_TEMPLATE/task.yml` を読む。
2. 必須のセクションラベルと値がワークフロー要件に一致していることを確認する。
3. `ISSUE_DAG_METADATA_START` / `ISSUE_DAG_METADATA_END` マーカーを追加しない（レガシー形式はサポート外）。
4. Issue の状態と `Status` が一貫していることを確認する（`open != done`、`closed == done`）。
5. `Allowed Files`、`Acceptance Checks`、`Tests`、`Commit Units` が空でないことを確認する。
6. 依存関係はインライン JSON ではなく、Project の `Dependencies` フィールド（`task_id` リスト）で設定する。
7. タスク Issue を親 Issue にリンクするのは、作業が独立してマージ可能な複数のタスク Issue に分解される場合のみ。スタンドアロンの正規タスク Issue には親リンクは不要。
8. `bun .agents/skills/orchestrate-plan/scripts/plan_runtime.ts intake-validate --repository <owner/repo>` を実行し、タスク Issue の intake または派生実行プランのバリデーションエラーが残っている場合はフェイルクローズドとする。

## 関連 SoT
- `docs/contracts/governance/workflow.md`
- 実行プラン規約: `docs/operations/governance/execution-plan.md`
