---
name: orchestrate-execute
description: オーケストレーションのフェーズ2。GitHubタスクイシューから実行プランをコンパイルし、サブエージェント実装とfail-closed品質ゲートで実行する。
metadata:
  execution_mode: scripted
  runtime_entrypoint: scripts/execute_runtime.ts
---

# オーケストレーション 実行

## 目的
オーケストレーションフローのフェーズ2（`execute`）を実行する。

主要ケイパビリティ: `engineering-manager` + サブエージェント `engineer`。

このフェーズが担当する範囲:
- プリフライト/ドクター検証
- GitHubタスクイシューからの実行プランのコンパイル/検証
- オーケストレーター実行（`run`）
- 品質ゲートの強制とレビュアーレーン依存のマージ準備判定

このフェーズが担当しない範囲:
- 生の要件の正規化とイシュー作成
- 最終クリーンアップ/レポートクローズ

## ランタイムコマンド
```bash
# ヘルプ
bun .agents/skills/orchestrate-execute/scripts/execute_runtime.ts --help

# ドクタープリフライトのみ
bun .agents/skills/orchestrate-execute/scripts/execute_runtime.ts doctor \
  --profile remote-pr-default \
  --state-backend github

# 実行（ドクター + ランタイム）
bun .agents/skills/orchestrate-execute/scripts/execute_runtime.ts run \
  --profile remote-pr-default \
  --state-backend github

# オフラインイシューソースでの実行
bun .agents/skills/orchestrate-execute/scripts/execute_runtime.ts run \
  --profile remote-pr-default \
  --state-backend github \
  --task-source ./.tmp/issues.json
```

## ランタイム契約
- `doctor` の失敗は fail-closed である。
- `doctor` は終了前にGitHubタスクイシューから実行プランをコンパイルおよび検証する。
- `merge_mode=remote-pr` はGH認証/プリフライト契約を必要とする。
- `state-backend` のデフォルトは `github`。
- デフォルトの state ディレクトリは決定論的な永続パス（`<repo_parent>/wt/.omta/state/sessions/<session-id>`）。
- 実行プランのスナップショット、ワーカーステータスアーティファクト、ゲート結果はランタイム state ディレクトリ配下に出力されなければならない。
- マージ準備には `review/*.json` の正規レビュアーレーンアーティファクトが必要。実装出力のみでは不十分。
- ヒューマンレビューが必要なのは、有効なレビューモードがマニュアル（プロファイル/DAG/CLI経由で `auto_approve=false`）の場合のみ。オートレビュープロファイルでもアーティファクトは必要だが、オーケストレーターが自動的に書き込む。

## 参照
- フェーズ契約: `docs/contracts/governance/workflow.md`
- ワークフロー SoT: `docs/contracts/governance/workflow.md`
- オーケストレーションプロトコル: `references/orchestration.md`
- リカバリプレイブック: `references/recovery-playbook.md`
- 出力テンプレート: `references/execution-output-templates.md`
