---
name: orchestrate-close
description: オーケストレーションのフェーズ3。クリーンアップ、残留物チェック、再実装ループへのハンドオフを伴う安全な実行終了。
metadata:
  execution_mode: scripted
  runtime_entrypoint: scripts/close_runtime.ts
---

# オーケストレーション クローズ

## 目的
オーケストレーションフローのフェーズ3（`close`）を実行する。

主要ケイパビリティ: `engineering-manager` + `project-manager`。

このフェーズが担当する範囲:
- worktree/ブランチのクリーンアップとマージ後の整理
- 残留物チェック（失敗ノード、欠落アーティファクト、未解決コンフリクト）
- ループハンドオフ（ブロック/失敗ノードを新規タスクとして再実装）
- 最終クローズアウトレポート

## 必須クローズチェックリスト
1. クローズ入力ソースを確認する:
   - `state-backend=local|github`: `session-manifest.json`、`state.json`、`status/*.json`、`review/*.json`、`gate-results.json`、`inputs/execution-plan.json`
   - `state-backend=github`: `github-run-context.json`
2. マージ済み/未マージの worktree とブランチを分類する。
3. クリーンアップ実行前に、解決済みの `main` worktree を `origin/main` と完全同期した状態に保つ。標準ヘルパーパスがこれを fail-closed で強制するため、そちらを優先する。
4. クリーンアッププラン（`cleanup-plan.json`）とレビュー対象を生成する。
5. クリーンアップは `cleanup-apply` コマンドのみで適用する。
6. 失敗/残留リスクを記録し、残留ノードのフォローアップタスクを `followup-drafts.json` に作成する。
   - レビューアーティファクトが存在する場合は、レビュアーの所見/エスカレーションコンテキストを含める
7. 次のアクションリスト付きのクローズアウトサマリーを作成する。

## 共通コマンド
```bash
# ヘルプ
bun .agents/skills/orchestrate-close/scripts/close_runtime.ts --help

# クローズ前提条件の検証（アーティファクト + 終端状態）
bun .agents/skills/orchestrate-close/scripts/close_runtime.ts verify \
  --state-backend github \
  --session-id <session-id> \
  --repository owner/repo

# フルクローズ実行（残留物 + クリーンアッププラン + クローズアウト、デフォルトは非破壊）
bun .agents/skills/orchestrate-close/scripts/close_runtime.ts run \
  --state-backend github \
  --session-id <session-id> \
  --repository owner/repo \
  --base-branch main

# クリーンアッププランのみ生成
bun .agents/skills/orchestrate-close/scripts/close_runtime.ts cleanup-plan \
  --state-backend github \
  --session-id <session-id> \
  --repository owner/repo

# プランからクリーンアップを適用
bun .agents/skills/orchestrate-close/scripts/close_runtime.ts cleanup-apply \
  --state-backend github \
  --cleanup-plan-input <repo_parent>/wt/.omta/state/sessions/<session-id>/cleanup-plan.json

# 安全なPRマージ（--delete-branch なし）
bash scripts/ops/pr-merge-safe.sh --pr <number> --method squash

# 安全なPRマージ + クリーンアップ適用
bash scripts/ops/pr-merge-safe.sh --pr <number> --method squash --cleanup

# マージ済みPR/worktreeのクリーンアップ
bash scripts/ops/cleanup-by-pr.sh --pr <number|url>

# 残存worktreeの分類
ORCH_ROOT="$(git rev-parse --show-toplevel)/tools/orchestrator/orchestrate"
"$ORCH_ROOT/worktree_classify.sh" --base main
```

注意事項:
- `bash scripts/ops/pr-merge-safe.sh --pr <number> --method squash --cleanup` がマージ後の推奨パスである。クリーンアップヘルパーは、解決済みの `main` worktree が `origin/main` と完全一致する（またはクリーンに fast-forward できる）場合以外は fail-closed となる。
- `cleanup-by-pr.sh` の直接使用は、解決済みのベース `main` worktree からのみ有効。チェックアウトが `origin/main` より先行/分岐している場合、ブランチが整合されるまでクリーンアップはブロックされる。

## ランタイム契約
- `verify` は必須アーティファクトが欠落している場合に fail-closed でなければならない。
- `state-backend` のデフォルトは `github`。クローズ入力契約はローカルランタイムアーティファクト（`state.json`、`gate-results.json`、`status/*.json`）のまま。
- 標準クローズは終端実行状態のみを受け入れる。`ready_for_review` は execute/resume の非終端状態のままであり、通常のクローズ入力として扱ってはならない。
- 標準 `run` の親イシュー同期は現在のセッションの `inputs/execution-plan.json` に限定される。リポジトリ全体の親イシュー探索は標準クローズパスの範囲外。
- `run` は `inputs/execution-plan.json` が欠落している場合、または限定された親イシューメタデータが不完全な場合に fail-closed でなければならない。
- `state-dir` のデフォルトは決定論的な永続パス: `<repo_parent>/wt/.omta/state/sessions/<session-id>`。
- `--state-dir` を省略する場合は `--session-id`（または `ORCHESTRATE_SESSION_ID`）が必須（`cleanup-apply --cleanup-plan-input` 指定時を除く）。
- `run` は常にクリーンアッププラン出力を生成しなければならない。クリーンアップ適用は明示的に行う。
- `cleanup-apply` はクリーンアップ失敗時に fail-closed でなければならない。
- `run` は残留ノードのフォローアップドラフトペイロードを `followup-drafts.json` に出力しなければならない。
- `run` はタスクステータス同期の後に親イシューのクローズ/リオープン同期を実行しなければならない（fail-closed）。
- `--skip-parent-issue-sync` は `run` コマンドで親イシュー同期をスキップする。
- 正規のランタイムアーティファクトレイアウトは `docs/contracts/governance/session-artifacts.md` で定義される。
- 正規の GitHub 整合ルールは `docs/contracts/governance/github-reconciliation.md` で定義される。

## 参照
- フェーズ契約: `docs/contracts/governance/workflow.md`
- ワークフロー SoT: `docs/contracts/governance/workflow.md`
- 実行リカバリ: `.agents/skills/orchestrate-execute/references/recovery-playbook.md`
- 出力テンプレート: `references/close-output-templates.md`
- クリーンアッププレイブック: `references/cleanup-playbook.md`
