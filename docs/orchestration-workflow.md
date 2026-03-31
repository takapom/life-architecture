# Orchestration Workflow

このドキュメントは life-architecture におけるオーケストレーション実行手順の SoT です。

## 前提条件

### 1回だけ必要なセットアップ

```bash
# Rust バイナリのビルド（初回 or ソース変更後）
bun run dev:tools:rust:build

# GH_TOKEN の設定
export GH_TOKEN=$(gh auth token)
```

`.env.local` に永続化する場合:
```
GH_TOKEN=<gh auth token の出力>
```

### 必要な環境

| ツール | 確認コマンド |
|--------|-------------|
| bun | `bun --version` |
| cargo (Rust) | `cargo --version` |
| gh CLI | `gh auth status` |
| tmux | `tmux -V` |

---

## 標準フロー

```
1. task issue 作成  →  2. task-source JSON 準備  →  3. orchestrator:start  →  4. 監視  →  5. orchestrator:close
```

---

## Step 1: task issue の作成

task issue のタイトルは `[TASK] <TASK_ID>: <説明>` 形式で作成する。
`<TASK_ID>` のパターン: `LA-001`, `LA-002`, ... （`[A-Z]+-\d{3,}` 形式）

```bash
gh issue create \
  --repo takapom/life-architecture \
  --label task \
  --title "[TASK] LA-NNN: <タスクの説明>" \
  --body "$(cat <<'EOF'
## Summary
<2-4行で変更内容・理由・完了状態を記述>

## Background / Context
<背景・動機>

## Runtime Invariants
- INV1: <変えてはいけない不変条件>

## Ownership / SoT
- Owner: <担当ディレクトリ>
- SoT: <主要ファイル>

## Task Type
feature

## Priority
50

## Admission Mode
standard

## Global Invariant
N/A

## Unfreeze Condition
N/A

## Allowed Files
- src/**

## Acceptance Checks
- <完了条件1>

## Tests
- npm run lint
- npm run build

## Non-goals
- <やらないこと>

## Forbidden Shortcuts
- <禁止する近道>

## Commit Units
- [ ] CU1: <コミット単位の説明>

## Reviewer Outcomes
- <レビュアーが確認できること>

## Canonical Gap
<現状と理想の差分>

## Canonical Gap Owner
<担当ディレクトリ>

## Canonical Gap Review Date
<YYYY-MM-DD>

## Canonical Deferral Reason
N/A

## Canonical Deferral Condition
N/A

## Task Sizing Exception
N/A

## Task Sizing Exception Type
N/A

## Task Sizing Split Failure
N/A

## Task Sizing Exception Reviewer Attestation
N/A

## Task Sizing Unsafe State
N/A

## Task Sizing Affected Invariant
N/A

## Task Sizing Atomic Boundary
N/A
EOF
)"
```

`task` ラベルが存在しない場合は事前に作成:
```bash
gh label create task --repo takapom/life-architecture --description "Orchestrator task issue" --color "0052cc"
```

---

## Step 2: task-source JSON の準備

現状、issue-graph は GitHub GraphQL の `projectItems` フィールドを取得しないため、
ステータスを `project_fields` に手動 inject した JSON ファイルを用意する必要がある。

```bash
gh api repos/takapom/life-architecture/issues/<番号> \
  --jq '{number, title, state, body, labels: [.labels[].name]}' \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
d['project_fields'] = {'status': 'in progress'}
print(json.dumps([d], indent=2))
" > /tmp/task-source.json
```

---

## Step 3: orchestrator:start

```bash
GH_TOKEN=$(gh auth token) bun run orchestrator:start -- \
  --repository takapom/life-architecture \
  --issue <issue番号> \
  --task-source /tmp/task-source.json
```

### Doctor チェック一覧

起動前に以下がすべて `[ok]` になる必要がある:

| チェック | 対処 |
|----------|------|
| `base_worktree_clean` | 未コミット変更をコミットする（`.claude/`・`.env*` は gitignore 済み） |
| `template_sot_files` | `.github/PULL_REQUEST_TEMPLATE.md` と `.github/ISSUE_TEMPLATE/task.yml` が存在すること |
| `remote_pr_preflight` | `GH_TOKEN` 環境変数を設定すること |
| `base_branch` | `main` ブランチで実行すること |

---

## Step 4: 監視

```bash
# セッション状態を確認
GH_TOKEN=$(gh auth token) bun run orchestrator:status -- \
  --session-id <sess-YYYYMMDDHHMMSS-xxxxxxxx>

# tmux に接続（利用可能な場合）
bun run orchestrator:attach -- --session-id <sess-...>
```

### セッション ID の確認

```bash
ls /Users/takagiyuuki/wt/.omta/state/sessions/ | tail -5
```

### 状態の見方

| status | 意味 |
|--------|------|
| `running` | サブエージェントが実装中 |
| `review` | レビュー待ち（auto モードでは自動通過） |
| `done` | 完了 |
| `failed` | 失敗。`last_failure_reason` を確認 |

---

## Step 5: orchestrator:close

```bash
GH_TOKEN=$(gh auth token) bun run orchestrator:close -- \
  --repository takapom/life-architecture \
  --session-id <sess-...>
```

---

## Rust バイナリの再ビルド

Rust ソースを変更した場合や `binary stale` エラーが出た場合:

```bash
bun run dev:tools:rust:build
```

ビルド成果物は `../wt/.omta/rust-runtime/targets/orchestrator/<fingerprint>/debug/omta-orchestrator` に配置される。

---

## トラブルシューティング

### `task issue must be status=ready or in progress`

Step 2 の task-source JSON を再作成し、`project_fields.status` が `"in progress"` になっているか確認する。

### `base_worktree_clean: N changed path(s)`

変更をコミットする。`.claude/` と `.env*` は gitignore 済みなので通常は問題ない。
それ以外のファイルが残っている場合:

```bash
git status --short
git add <該当ファイル> && git commit -m "chore: ..."
```

### `orchestrator binary is stale` または `missing binary`

```bash
bun run dev:tools:rust:build
```

### `missing GH_TOKEN for remote-pr mode`

```bash
export GH_TOKEN=$(gh auth token)
```

### `task_id is required` または `title must encode task_id`

issue タイトルが `[TASK] LA-NNN: ...` 形式になっていない。
`gh issue edit <番号> --title "[TASK] LA-NNN: ..."` で修正する。
