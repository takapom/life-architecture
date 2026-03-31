# クローズフェーズ クリーンアッププレイブック

クローズフェーズでクリーンアップまたは残留物処理中に失敗が発生した場合にこのプレイブックを使用する。

## クリーンアップ失敗分類

| 理由 | 典型的なシグナル | 主なアクション |
|---|---|---|
| `worktree_remove_failed` | `git worktree remove` が非ゼロを返す | dirty 状態やアクティブなプロセスを確認し、`--force` でリトライする |
| `worktree_remove_force_failed` | `--force` リトライも失敗 | worktree パスを手動で調査し、ロックしているプロセスを終了してディレクトリを削除する |
| `branch_delete_failed` | `git push origin --delete` または `git branch -d` が失敗 | ブランチが存在し保護されていないことを確認し、`gh api` フォールバックを使用する |
| `prune_failed` | `git worktree prune` が非ゼロを返す | `.git/worktrees` の古いエントリを調査し手動で削除する |
| `cleanup_plan_missing` | `cleanup-plan` の事前実行なしに `cleanup-apply` が呼ばれた | まず `cleanup-plan` を実行してターゲットリストを生成する |
| `cleanup_apply_partial` | 一部のターゲットが成功し、他が失敗 | クリーンアップ結果 JSON で失敗したターゲットを調査し個別にリトライする |
| `parent_issue_sync_failed` | 親 Issue のクローズ/再オープン API 呼び出しが失敗 | `GH_TOKEN` の権限と Issue のアクセス可能性を確認してリトライする |
| `parent_issue_sync_ambiguous` | Sub-issue の状態またはタスクの Status が解決できない | Sub-issue リンクと Project タスクアイテムを手動で調査する |
| `parent_issue_sync_scope_missing` | 現在のセッションが境界付き親 Issue メタデータを公開していない | セッションの `inputs/execution-plan.json` を復元してクローズをリトライする |

## Worktree 分類パターン

クローズフェーズは worktree を以下のカテゴリに分類する:

| カテゴリ | 基準 | デフォルトアクション |
|---|---|---|
| `merged_clean` | PR マージ済み、worktree クリーン | worktree 削除 + ブランチ削除 |
| `merged_dirty` | PR マージ済み、worktree に未コミット変更あり | フェイルクローズド（調査のために保持） |
| `unmerged_terminal` | PR 未マージ、ノード終端（失敗/ブロック） | 調査のために worktree を保持 |
| `unmerged_active` | PR 未マージ、ノードまだアクティブ | スキップ（クローズフェーズには出現しないはず） |
| `orphan` | worktree は存在するが DAG に一致するノードがない | 警告をログし、手動レビューのために保持 |

## 親 Issue 同期の失敗リカバリ

クローズフェーズは `state-dir/inputs/execution-plan.json` を境界付き親 Issue スコープとして使用する。標準クローズフローはリポジトリ全体の親探索にフォールバックしない。

1. Sub-issue リンクが正しいことを確認する:
```bash
gh api graphql -f query='
  query($number: Int!, $owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        subIssues(first: 50) { nodes { number state } }
      }
    }
  }
' -f owner=<owner> -f repo=<repo> -F number=<parent_issue_number>
```

2. 全 Sub-issue のタスクアイテム Status を確認する:
```bash
ISSUE_REPOSITORY=<owner/repo> bun run execution-plan:from-issues -- --output .tmp/execution-plan.json
```

3. 現在のセッションが境界付き親 Issue メタデータを保持していることを確認する:
```bash
jq '.source_items[] | {id, parent_issue_number, parent_issue_url}' \
  <repo_parent>/wt/.omta/state/sessions/<session-id>/inputs/execution-plan.json
```

4. 親 Issue 同期付きでクローズを再実行する:
```bash
bun .agents/skills/orchestrate-close/scripts/close_runtime.ts run \
  --state-backend github \
  --session-id <session-id> \
  --repository <owner/repo> \
  --base-branch main
```

5. 同期が引き続き失敗する場合、境界付き親 Issue セットでスタンドアロン同期スクリプトを実行する:
```bash
bun scripts/ops/sync-parent-issue-status.ts \
  --repository <owner/repo> \
  --parent-issue <number> \
  --parent-issue <number> \
  --apply
```

6. 例外的な手動リカバリのみ、リポジトリ全体の探索を明示的にオプトインできる:
```bash
bun scripts/ops/sync-parent-issue-status.ts \
  --repository <owner/repo> \
  --all-parents \
  --dry-run
```

## オペレーターノート

- `cleanup-apply` は常に明示的。`run` はデフォルトでプランのみの出力を生成する。
- dirty な worktree は自動的に削除されない（フェイルクローズド、オーバーライドなし）。
- マージ済み PR の個別クリーンアップには `bash scripts/ops/cleanup-by-pr.sh --pr <number>` を使用する。
- 親 Issue 同期の `dry-run` がデフォルト。`apply` は明示的に指定する必要がある。
- 現在のセッションでアーティファクトパスがオーバーライドされた場合は、まず `session-manifest.json` を調査する。
