# リモート PR リカバリプレイブック

`merge_mode=remote-pr` でノードが失敗した場合にこのプレイブックを使用する。

## 失敗分類

| 理由 | 典型的なシグナル | 主なアクション |
|---|---|---|
| `missing_pr_url` | ステータス JSON に `pr_url` がない | ワーカー出力を更新して具体的な PR URL を含める |
| `invalid_pr_url_format` | `pull/new/...` または不一致な URL 形式 | `https://github.com/<owner>/<repo>/pull/<number>` に置換する |
| `pr_lookup_failed` | `validate_pr_url.sh` が `gh` 経由で PR を解決できない | PR が存在し `gh` アクセスが有効であることを確認する |
| `repo_mismatch` | owner/repo がオリジンから解決できないか一致しない | `ORCHESTRATE_GITHUB_REPO=<owner/repo>` を設定し git remote を確認する |
| `gh_auth_invalid` | プリフライトが認証失敗を報告 | `gh auth login` を実行する |
| `missing_gh_token_env` | プリフライトが GH_TOKEN 未設定を報告 | `export GH_TOKEN=<github_pat_or_app_token>` |
| `network_unreachable` | プリフライトがホスト/ネットワークエラーを報告 | ネットワークを復旧してリトライする |
| `git_write_denied` | プリフライトが `.git` 配下に書き込めない | ファイルシステム権限を復旧する |
| `tmpdir_unwritable` | プリフライトが `TMPDIR` に書き込めない | 書き込み可能な `TMPDIR` を設定してプリフライトを再実行する |
| `bun_tmpdir_unwritable` | プリフライトが `BUN_TMPDIR` に書き込めない | 書き込み可能な `BUN_TMPDIR` を設定してプリフライトを再実行する |
| `agent_exec_contract_failed` | doctor/実行が agent-exec サンドボックスまたは環境規約の失敗を報告 | `--dangerously-skip-permissions` を使用し `GH_TOKEN` をエクスポートする |
| `orchestrator_stopped` | ステータス概要がオーケストレーターが子の完了前に停止したことを示し、子側の根本原因が不在。注意: シャットダウン前に `ready_for_review` または `done` に到達したノードは保持され、この残留物を生成しない | 親の終了原因とランタイム環境を調査し、同じ state dir から再実行する |
| `child_failure_detected` | オーケストレーターシャットダウン時に子の status/summary は残っているが `failure_reason` が未確定 | `status/<node>.json` の summary と agent-exec ログを見て根因を確定し、再実行前に status の failure_reason を補完する |
| `git_index_lock_permission_denied` | 子ログに `.git/worktrees/.../index.lock: Operation not permitted` が含まれる | danger-full-access サンドボックスと書き込み可能な worktree/.git で再実行する |
| `orchestrator_status_write_denied` | 子ログが `status/<node>.json` に書き込めない | state-dir の書き込み権限を復旧して再実行する |
| `agent_process_exited_without_status` | 子プロセスが終端ステータス JSON なしで終了 | 子の stderr/stdout とタスク指示書を調査し、ノードを再実行する |
| `agent_exec_exited_without_status` | agent exec ランナーが終端ステータス JSON なしで終了 | `<state-dir>/agent-exec/{json,stderr,last}` を調査しノードを再実行する |
| `worktree_setup_failed` | 依存関係セットアップゲートがマージゲート前に失敗 | `setup_error_summary`/`setup_stderr` を調査。worktree 配下の `TMPDIR`/`BUN_TMPDIR` が書き込み可能であることを確認して再実行する |
| `dependency_setup_failed` | マージ時の依存関係セットアップチェックが失敗 | `bun install --offline` が失敗した場合、`bun install --frozen-lockfile` でリトライしステータスエビデンスを更新する |
| `acceptance_gate_failed` | 受入チェックが失敗 | 実装/テストを修正し受入チェックを再実行する |
| `worktree_gate_failed` | 必須の worktree ゲートコマンドが失敗 | 根本原因を修正し設定済みのゲートコマンドを再実行する |
| `worktree_gate_scope_unmapped` | ノードスコープゲートに `allowed_files` スコープのコマンドがない | `scope_gate_cmds` マッピングまたはフォールバックゲートを追加して再実行する |

## 標準リカバリフロー

1. remote-pr の前提条件を検証する:
```bash
ORCH_ROOT="$(git rev-parse --show-toplevel)/tools/orchestrator/orchestrate"
export GH_TOKEN="<github_pat_or_app_token>"
python3 "$ORCH_ROOT/orchestrate_dag.py" --doctor
```
2. PR URL エビデンスを検証する:
```bash
bash "$ORCH_ROOT/validate_pr_url.sh" "https://github.com/<owner>/<repo>/pull/<number>" "<owner/repo>"
```
3. オーケストレーションを再実行する:
```bash
python3 "$ORCH_ROOT/orchestrate_dag.py" --profile remote-pr-default
```

## ランタイム失敗リカバリ（state-dir 駆動）

1. まずステートアーティファクトを読む:
```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
SESSION_ID="${ORCHESTRATE_SESSION_ID:?set ORCHESTRATE_SESSION_ID}"
STATE_DIR="$REPO_ROOT/../wt/.omta/state/sessions/$SESSION_ID"
cat "$STATE_DIR/session-manifest.json"
cat "$STATE_DIR/github-run-context.json"
cat "$STATE_DIR/state.json"
cat "$STATE_DIR/status/<node_id>.json"
cat "$STATE_DIR/gate-results.json"
```
   失敗理由が `worktree_setup_failed` / `dependency_setup_failed` の場合は `setup_error_summary` と `setup_stderr` を確認する。
2. 失敗が `child_failure_detected` / `orchestrator_stopped` / `agent_exec_exited_without_status` の場合、agent exec ログを調査する:
```bash
ls -la "$STATE_DIR/agent-exec"
cat "$STATE_DIR/agent-exec/stderr/<node_id>.log"
cat "$STATE_DIR/agent-exec/last/<node_id>.txt"
```
3. 根本原因を修正し、同じ DAG/ステートコンテキストで doctor + オーケストレーターを再実行する。

4. github バックエンドでクローズフェーズが失敗した場合、ランタイムアーティファクトに対して検証を再実行する:
```bash
bun .agents/skills/orchestrate-close/scripts/close_runtime.ts verify \
  --state-backend github \
  --repository <owner/repo> \
  --state-dir "$STATE_DIR"
```

## マージ後の PR クリーンアップ（安全パス）

worktree やコマンドポリシーの制限によりブランチクリーンアップが失敗した場合、`gh pr merge --delete-branch` を使用しない。

以下を使用する:

```bash
# マージのみ（デフォルトセーフ: cleanup は適用されない）
bash scripts/ops/pr-merge-safe.sh --pr <number> --method squash

# マージ + cleanup 適用（明示的な破壊的ステップ）
bash scripts/ops/pr-merge-safe.sh --pr <number> --method squash --cleanup

# クリーンアップのみ（マージ済み PR）
bash scripts/ops/cleanup-by-pr.sh --pr 123
```

クリーンアップヘルパーの動作:
- 解決済みベース `main` worktree が `origin/main` と完全同期しているか、クリーンに fast-forward できない限りフェイルクローズドとなる。
- 一致する worktree を先に削除する（`git worktree remove`、次に `--force` でリトライ）。
- `git push origin --delete` でリモートブランチを削除し、失敗時は `gh api .../git/refs/heads/<branch>` にフォールバックする。
- `git branch -d` でローカルブランチを削除し、失敗時は `git update-ref -d` にフォールバックする。

運用上の推奨:
- 標準パスでは `pr-merge-safe.sh --cleanup` を推奨する。完全同期ガードを自動的に経由するため。
- `cleanup-by-pr.sh` を直接使用するのは、ahead/diverged なローカル `main` 状態を照合した後、解決済みベース `main` worktree からのみ行う。

## オペレーターノート

- `pull/new/...` は完了エビデンスとして認められない。
- worktree が多いリポジトリでは `gh pr merge --delete-branch` を避ける。
- github バックエンドのクローズ/リカバリは state-dir アーティファクト駆動（`session-manifest.json`、`github-run-context.json`、`state.json`、`gate-results.json`、`status/*.json`）。
- リカバリコメントは短く実行可能にする: ブロッカー1つ、次のステップ1つ。
