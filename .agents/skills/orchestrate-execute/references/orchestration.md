# 親子オーケストレーション

## 目的
PR単位のタスクDAGを駆動し、ノードごとに子エージェントを生成する。その後、親がレビューアレーンを満たし、全ノードがマージまたはブロック状態になるまでマージを行う。

## DAG JSON スキーマ（最小構成）
```json
{
  "base_branch": "main",
  "worktree_root": "../wt",
  "max_workers": 3,
  "spawn_mode": "agent-exec",
  "auto_approve": true,
  "merge_mode": "remote-pr",
  "state_backend": "github",
  "merge_strategy": "squash",
  "require_passing_tests": true,
  "require_traceability": true,
  "require_acceptance_checks": true,
  "enforce_branch_policy": true,
  "branch_policy": {
    "integration_branch": "main",
    "staging_branch": "stg",
    "production_branch": "main",
    "release_branch_prefixes": ["release/"],
    "promotion_flow": "integration->staging->production",
    "promotion_targets": {
      "integration": "stg",
      "staging": "main"
    },
    "role_gate_cmds": {
      "integration": "bun run ci:strict",
      "staging": "bun run ci:fast",
      "production": "bun run ci:strict"
    },
    "role_merge_modes": {
      "integration": "remote-pr",
      "staging": "remote-pr",
      "production": "remote-pr"
    }
  },
  "issue_tracking": {
    "strategy": "remote-github-sot",
    "repository": "owner/repo",
    "progress_issue_number": 0,
    "progress_issue_url": "",
    "node_issue_mode": "per-node",
    "sync_labels": true,
    "pending_label": "pending-decision"
  },
  "source_items": [
    { "id": "FC-1", "verdict": "valid", "summary": "..." },
    { "id": "FC-2", "verdict": "pending", "summary": "..." }
  ],
  "issue_map": {
    "FC-1": "https://github.com/owner/repo/issues/101",
    "FC-2": "https://github.com/owner/repo/issues/102"
  },
  "deferred_items": [
    { "id": "FC-9", "reason": "上流依存によりブロック" }
  ],
  "worktree_gate": {
    "enabled": true,
    "gate_cmd": "bun run ci",
    "include_default_checks": false
  },
  "setup_worktree_cmd": "bun install --offline",
  "require_worktree_setup": true,
  "require_base_up_to_date": true,
  "allow_dirty_base": false,
  "queue_strategy": "dag_priority",
  "runtime_policy": {
    "max_runtime_seconds": 3600,
    "stuck_timeout_seconds": 300
  },
  "retry_policy": {
    "max_retries": 3,
    "backoff_base_seconds": 10,
    "backoff_factor": 2,
    "backoff_max_seconds": 300,
    "queue_freeze_on_conflict": true
  },
  "nodes": [
    {
      "id": "PR1",
      "branch": "task/pr1",
      "github_issue": "https://github.com/owner/repo/issues/101",
      "priority": 1,
      "deps": [],
      "scope": "変更内容",
      "covers": ["FC-1"],
      "files": ["path/a", "path/b"],
      "non_goals": ["変更してはならない内容"],
      "allowed_files": ["path/a", "path/b"],
      "acceptance": ["AC1", "AC2"],
      "acceptance_checks": ["npm test -- path/to/spec"],
      "tests": ["npm test"],
      "instructions": "補足事項"
    }
  ],
  "agent_exec": {
    "cmd": "claude",
    "args": "--dangerously-skip-permissions"
  }
}
```

`auto_approve` を `false` に設定するのは、その実行で明示的な手動レビューを必要とする場合のみ。
オペレーター/ステータスツールは、永続化された `gate-results.json.dispatch.review_policy` アーティファクトから有効なレビューモードを読み取り、設定を再解決しない。

## skills.config.toml（必須のランタイムデフォルト/プロファイル）
`orchestrate_dag.py` はデフォルトで `<repo-root>/tools/orchestrator/orchestrate/skills.config.toml` を常に読み込む（`--skills-config` でオーバーライド可能）。

```toml
["orchestrate"]
default_profile = "remote-pr-default"

["orchestrate".defaults]
merge_mode = "remote-pr"
state_backend = "github"
merge_queue = false
cleanup = true
require_traceability = true
require_acceptance_checks = true
require_base_up_to_date = true
enforce_branch_policy = true
writing_language = "ja"

["orchestrate".defaults.branch_policy]
integration_branch = "main"
staging_branch = "stg"
production_branch = "main"
release_branch_prefixes = ["release/"]
promotion_flow = "integration->staging->production"

["orchestrate".profiles."remote-pr-default"]
base_branch = "main"
merge_mode = "remote-pr"
state_backend = "github"
enforce_branch_policy = true
auto_approve = true

["orchestrate".profiles."remote-pr-default".worktree_gate]
enabled = true
gate_cmd = "bun run ci:strict"
include_default_checks = false
```

優先順位:
- CLI フラグ
- DAG 値
- `skills.config.toml`（`defaults` + 選択された `profile`）
- 組み込みデフォルト

## ステートバックエンド / ステートディレクトリ
- `state_backend` は `github|local` をサポート（デフォルト: `github`）。
- `github` バックエンド:
  - `state-dir` アーティファクトが実行/リカバリのソース（`state.json`、`gate-results.json`、`status/*.json`）。
  - `state.json.github_state` はオプションの実行リンケージメタデータ（`run_id`、`run_issue_number`、`run_issue_url`）を保持。
- `local` バックエンド:
  - github バックエンドと同じ `state-dir` アーティファクト規約。

オーケストレーターはランタイムアーティファクトをディレクトリ配下に書き込む（デフォルト: `<repo_parent>/wt/.omta/state/sessions/<session-id>`）:
- `session-manifest.json`: 現在のセッションのランタイムアーティファクトの正規インデックス
- `inputs/execution-plan.json`: このセッション用に GitHub タスク Issue から生成されたコンパイル済み実行プランのスナップショット
- `state.json`: ノードステータスと試行回数
- `gate-results.json`: 正規化されたゲートスナップショット（テスト/セットアップ/受入/worktree + アーティファクトリンク）およびディスパッチ状態
  - `dispatch.ready_candidates`: 現在のセッションスナップショットの決定論的な準備済みノード順序
  - `nodes[*].dispatch.retry`: バックオフ、枯渇、最終リトライ理由
  - `nodes[*].dispatch.escalation`: ノードがブロック/枯渇時の手動介入理由
- `github-run-context.json`: クローズ/照合用の正規セッションローカル GitHub 実行コンテキスト
- `tasks/{node_id}.md`: 子タスク指示書
- `status/{node_id}.json`: 子ステータスレポート（`summary`、`failure_reason`、remote-pr の場合: `pr_url`）
- `review/{node_id}.json`: 正規レビューアレーンアーティファクト
  - 必須の判定: `approve|rework|reject`
  - ランタイムが受け付けるオプションフィールド: `summary`、`findings[]`、`escalation`、`reviewer_lane`、`reviewed_at`
- `conflict/{node_id}.json`: マージコンフリクトの詳細
- `state.json.github_state`: オプションの実行リンケージ（`run_id`、`run_issue_number`、`run_issue_url`）
- 正規ランタイムアーティファクトレイアウトは `docs/contracts/governance/session-artifacts.md` で定義
- 正規 GitHub 照合ルールは `docs/contracts/governance/github-reconciliation.md` で定義

## 親フロー（オーケストレーター）
1) GitHub Issue グラフから実行プランをコンパイルし、検証し、worktree を準備し、子タスクファイルを生成する。
2) 準備完了ノード（依存関係が満たされたもの）に対して子エージェントを生成する。
3) `status/*.json` の `status=ready_for_review` を待つ。
4) 有効なレビューモードが手動の場合、レビューして `review/*.json` に `decision=approve|rework|reject` を書き込む。
5) 有効なレビューモードが自動の場合、オーケストレーター自身が正規の自動承認 `review/*.json` アーティファクトを書き込む。
6) レビューアレーンアーティファクトが存在するまでマージ準備はブロックされる。実装レーンのみではノードを完了に遷移させてはならない。
7) worktree ゲートコマンド（`gate_cmd`、またはデフォルトの `typecheck`/`lint`）を実行し、`merge_mode` に基づいて統合を処理する。
8) `remote-pr` のみ: 子ステータスから有効な `pr_url` エビデンス（`https://github.com/<owner>/<repo>/pull/<number>`）を要求する。
9) マージ/完了まで繰り返し、cleanup が有効な場合は worktree を削除する。

### リモート PR ボディの安全性
`gh` で PR 説明を作成または更新する際、`--body` でインライン Markdown を渡してはならない。
シェル展開により Markdown コンテンツが破損する可能性がある（例: バッククォートで囲まれたスニペット）。
PR タイトル/ボディおよびコミット言語は `skills.config.toml` の `writing_language` で制御される（許可値: `ja|en`、デフォルト: `ja`）。
無効な `writing_language` 値および `orchestrate.defaults` / `orchestrate.profiles.*` 配下の不明なキーはフェイルクローズドとなる。

常にシングルクォートのヒアドキュメントで生成したボディファイルを使用する:

```bash
tmp_pr_body="$(mktemp -t pr-body.XXXXXX.md)"
cat >"$tmp_pr_body" <<'EOF'
## Summary
- 変更点を簡潔に記載
EOF

gh pr create \
  --base "<base-branch>" \
  --head "<head-branch>" \
  --title "<pr-title>" \
  --body-file "$tmp_pr_body"
# or
gh pr edit <pr-number> --body-file "$tmp_pr_body"
```

### ブランチクリーンアップの安全性
- worktree が多いリポジトリでは `gh pr merge --delete-branch` を避ける。
- 以下を標準とする:
  - 削除なしマージ: `gh pr merge <pr-number> --squash`
  - ヘルパーによるクリーンアップ: `bash scripts/ops/cleanup-by-pr.sh --pr <number|url>`
- `bash scripts/ops/pr-merge-safe.sh` はデフォルトセーフ（cleanup 未適用）。cleanup 適用まで一括で行う場合のみ `--cleanup` を付与する。
- ワンショット操作で cleanup を適用する場合: `bash scripts/ops/pr-merge-safe.sh --pr <number> --method squash --cleanup`。

バリデーションチェックには、重複/不明な依存関係、循環検出、ソースアイテムのトレーサビリティカバレッジ、および（有効時）ノードのテスト/受入プラン欠落が含まれる。
`allowed_files` は並列スケジューリングの正規書き込みセット規約でもある:
- GitHub タスク Issue は `Status=ready` で重複する `Allowed Files` スコープを同時に持ってはならない。
- ランタイムディスパッチは現在のティックで排他的な準備済みサブセットのみを選択する。
- 競合する保留ノードは保留のままとなり、`gate-results.json` に `dispatch.reason=write_set_conflict` として表示される。
`layer_policies.*.fallbacks` はサポートされなくなり、設定エラーとして扱われる（フェイルクローズド）。
`enforce_branch_policy` が有効な場合、ベースブランチのロール（`integration/staging/production`）は設定されたマージモードとゲートコマンドに一致する必要がある。
`issue_tracking.strategy=remote-github-sot` の場合、各ノードは `github_issue` リンクを含むべきであり、リモート Issue の状態が実行の SoT として扱われる。
各ノードはソースアイテムを正確に1つカバーし、`node.github_issue` は `issue_map[source_id]` と一致する必要がある。
remote-pr 実行では、`--doctor` がリポジトリ/実行の前提条件と agent-exec 規約チェック（サンドボックス/認証）を検証し、前提条件が欠落している場合はフェイルクローズドとなる。
`state_backend=github` の場合、ランタイムは Issue トラッキングリポジトリの解決と `gh` の利用可能性を要求する。進捗 Issue リンケージはオプションのメタデータ。

### リモート PR エビデンス規約
- 子ステータス JSON の必須キー: `pr_url`。
- 有効な形式: `https://github.com/<owner>/<repo>/pull/<number>`。
- 無効な形式: `https://github.com/<owner>/<repo>/pull/new/<branch>`。
- ランタイムバリデーションは `tools/orchestrator/orchestrate/validate_pr_url.sh`（存在する場合）を使用する。
- 失敗理由はステータスおよびゲートアーティファクトに機械可読な `failure_reason` 値として書き込まれる。
- リトライ可能なランタイム失敗は、リトライ予算が枯渇するまで `state.json` と `gate-results.json` に残る。早期に終端の子ステータスにミラーリングしてはならない。
- リカバリ手順は `references/recovery-playbook.md` に記載。

### ランタイム失敗理由リファレンス
- 頻出するオーケストレーション失敗理由:
  - `orchestrator_stopped`
  - `agent_process_exited_without_status`
  - `agent_exec_exited_without_status`
  - `worktree_setup_failed`
  - `dependency_setup_failed`
  - `acceptance_gate_failed`
  - `worktree_gate_failed`
- トリアージ優先順:
  1. `status/<node_id>.json`（`failure_reason`、`summary`）
  2. `gate-results.json`（ゲートレベルの合否スナップショット）
  3. `<state-dir>/agent-exec/{json,stderr,last}`（`spawn_mode=agent-exec` の場合）

## 子フロー
1) 割り当てられた worktree/ブランチで作業する。
2) スコープを実装し、テストを実行し、必須の worktree ゲートコマンドを実行する。
3) `status/{node_id}.json` に結果（`summary`、`failure_reason`）を書き込み、remote-pr モードでは `pr_url` を含める。
4) `conflict/{node_id}.json` が存在する場合、ベースブランチをマージして解決し、ステータスを再度更新する。

## オーケストレータースクリプト
`tools/orchestrator/orchestrate/orchestrate_dag.py` がサポートする機能:
- `bun run execution-plan:from-issues` による GitHub タスク Issue グラフからの実行プラン生成（常に有効、`inputs/execution-plan.json` として永続化）
- `--task-source`: `execution-plan:from-issues --source` に転送されるオプションのローカル JSON ソース
- `--skills-config`: 設定パスのオーバーライド（デフォルト: `<repo-root>/tools/orchestrator/orchestrate/skills.config.toml`）
- `--profile`: `orchestrate.profiles` 配下のプロファイル名
- `--merge-mode`: `remote-pr` のみ（デフォルト `remote-pr`）
- `--agent-cmd`: 子エージェント生成用のコマンドテンプレート
- `--spawn-mode`: `command|agent-exec`
- `--agent-exec-cmd`: agent exec CLI のベースコマンド（デフォルト `claude`）
- `--agent-exec-args`: agent exec の追加引数
- `--agent-exec-log-dir`: agent exec の JSON/last-message ログの書き込み先
- デフォルト: `merge_queue=false`、`cleanup=true`、`auto_approve=false`（DAG/設定/CLI でオーバーライドしない限り）
- リポジトリデフォルトプロファイル: `remote-pr-default` は `auto_approve=true` を設定するため、標準実行フローでは人間のレビューアーの割り当てが不要
- マージキューは `remote-pr` モードで自動的に無効化される。
- `--auto-approve`、`--manual-review`、`--no-merge-queue`、`--no-cleanup`: レビュー/キュー/クリーンアップの制御
- `--queue-file`: マージキューパスのオーバーライド
- `--queue-strategy`: `dag_priority|critical_path|fanout|priority_then_fifo`
- `--retry-backoff-base/--retry-backoff-factor/--retry-backoff-max`: バックオフチューニング
- `--queue-freeze-on-conflict`: コンフリクト未解決時に他のマージを一時停止
- `--queue-no-freeze-on-conflict`: コンフリクト未解決時も他のマージを許可（デフォルト）
- `--require-passing-tests` / `--no-require-passing-tests`: マージ前のテストゲート
- `--require-traceability` / `--no-require-traceability`: `source_items` カバレッジの強制（`valid` が `covers` または `deferred_items` に含まれる必要あり）
- `--require-acceptance-checks` / `--no-require-acceptance-checks`: ノードごとの `acceptance_checks` を要求し、マージ前に実行
- `--require-base-up-to-date` / `--no-require-base-up-to-date`: ベースブランチが上流に遅れていないことを要求
- `--allow-dirty-base` / `--no-allow-dirty-base`: dirty-base フェイルクローズドゲートのオーバーライド
- `--enforce-branch-policy` / `--no-enforce-branch-policy`: ベースブランチが `branch_policy` ロールルールを満たすことを要求
- `--max-runtime-seconds` / `--stuck-timeout-seconds`: ランタイムガードレール
- `--setup-worktree-cmd`: worktree 依存関係セットアップコマンドのオーバーライド
- `--no-setup-worktree`: 生成前セットアップのみスキップ。依存関係セットアップはマージゲート前に引き続き強制
- `--doctor`: プリフライトチェック（ベースブランチ、マージ状態、コマンド利用可能性、衝突）
- `--doctor` は `base_worktree_clean` を含み、`allow_dirty_base=true` でない限りベース worktree が dirty の場合に失敗する。
- `--doctor` は remote-pr モードでリポジトリ/実行の前提条件を検証する。
- `--doctor` は `spawn_mode=agent-exec` で `agent_exec_contract`（`--dangerously-skip-permissions`、および `merge_mode=remote-pr` 時の `GH_TOKEN`）を強制する。
- `--no-spawn`: 手動モード（タスク生成のみ）
- `--approve/--reject`: レビュー判定の書き込み
- DAG の `worktree_gate` 設定は各ノード worktree でのマージ時チェックを制御する（`gate_cmd` およびオプションのデフォルト `typecheck_cmd` / `lint_cmd` チェック）。
- `setup_worktree_cmd` はパッケージマネージャー固有のインストールコマンドがデフォルト（`bun install --offline`、`pnpm/yarn --frozen-lockfile`、ロックファイル存在時は `npm ci`）。`require_worktree_setup` が true の場合、セットアップ未完了時にマージゲートが失敗する。
- ノードが `allowed_files` を定義している場合、`git diff <base>...<branch>` にスコープ外のパスが含まれていると承認が拒否される。

### エージェントコマンドテンプレート
`--agent-cmd` で使用可能なプレースホルダー:
- `{task_file}`、`{worktree}`、`{node_id}`、`{branch}`、`{base_branch}`、`{repo_root}`
- 子コマンドは `cwd={worktree}` で生成されるため、編集はメイン worktree から隔離される。

例:
```
python3 tools/orchestrator/orchestrate/orchestrate_dag.py \
  --spawn-mode agent-exec
```

Agent exec CLI ランナーの例:
```
export GH_TOKEN="<github_pat_or_app_token>"
python3 tools/orchestrator/orchestrate/orchestrate_dag.py \
  --spawn-mode agent-exec \
  --agent-exec-args "--dangerously-skip-permissions"
```

## キュー戦略（ベストプラクティス）
- `dag_priority`（デフォルト）: 明示的な `priority`、次にクリティカルパス長、次にファンアウト、次に FIFO の順で優先。
- `critical_path`: 最長の下流パスを優先（より早く完了）。
- `fanout`: 最も多くの下流ノードをアンブロックするノードを優先。
- `priority_then_fifo`: 明示的な優先度のみ、FIFO でタイブレーク。

## 備考
- `node_id` はファイルシステムセーフにする: 英字、数字、`.`、`_`、`-` のみ。
- `source_items[].verdict` は `valid|already-fixed|invalid|pending` のいずれかでなければならない。
- `source_items` の ID は一意でなければならず、1つのソースアイテムは1つのノード `covers` にのみ属することができる。
- `pending` アイテムは `deferred_items` に記載し、実装前に最終判断のために提起すべきである。
- `branch_policy` は `integration/staging/production` ロールをサポートする。`enforce_branch_policy` が有効な場合、ベースブランチとゲートコマンドはアクティブなロールを満たす必要がある。
- `issue_tracking.strategy: remote-github-sot` はリモート GitHub Issues/PR が正規の計画および実行記録であることを意味する。
- `issue_tracking.progress_issue_number` / `issue_tracking.progress_issue_url` はオプションの実行リンケージフィールド。
- `issue_map` のキーは既存の `source_items` ID でなければならず、値は設定されたリポジトリの GitHub Issue 参照でなければならない。
- `issue_map` の値は一意でなければならない（複数のソース ID が同じ Issue URL にマッピングされてはならない）。
- `nodes[].covers` はソース ID を正確に1つ含む必要がある。
- `nodes[].github_issue` は必須であり、ノード間で一意でなければならず、カバーするソース ID の `issue_map` と等しくなければならない。
- 厳密な安全性が必要な場合は、有界ループのために `--max-retries` を設定する。
- DAG ファイルはリポジトリ外に置く（またはコミットする）ことで、マージゲートがクリーンなワーキングツリーを参照できるようにする。
