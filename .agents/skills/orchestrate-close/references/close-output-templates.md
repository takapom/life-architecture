# クローズ出力テンプレート

## クローズアウトサマリー JSON

```json
{
  "run_id": "session-id",
  "repository": "owner/repo",
  "state_backend": "github",
  "total_nodes": 5,
  "merged_nodes": 3,
  "failed_nodes": 1,
  "blocked_nodes": 1,
  "residue_nodes": ["PR4", "PR5"],
  "cleanup_applied": false,
  "parent_issue_sync": {
    "targets": [900],
    "results": [
      { "issue_number": 900, "action": "close", "success": true }
    ]
  },
  "next_actions": [
    "PR4 のフォローアップタスク（失敗: acceptance_gate_failed）",
    "PR5 の依存関係をアンブロックし再計画する"
  ],
  "timestamp": "2026-02-24T00:00:00Z"
}
```

## フォローアップドラフト JSON

```json
{
  "run_id": "session-id",
  "residue_nodes": [
    {
      "node_id": "PR4",
      "status": "failed",
      "failure_reason": "acceptance_gate_failed",
      "summary": "受入チェックが通らなかった",
      "suggested_status": "backlog",
      "suggested_action": "実装を修正し受入チェックを再実行する"
    },
    {
      "node_id": "PR5",
      "status": "blocked",
      "failure_reason": "dependency_not_met",
      "summary": "上流の PR4 が未マージ",
      "suggested_status": "backlog",
      "suggested_action": "PR4 の解決後に再計画する"
    }
  ],
  "timestamp": "2026-02-24T00:00:00Z"
}
```

## クリーンアッププラン JSON

```json
{
  "run_id": "session-id",
  "targets": [
    {
      "node_id": "PR1",
      "pr_number": 123,
      "pr_url": "https://github.com/owner/repo/pull/123",
      "branch": "task/pr1",
      "worktree": "../wt/PR1",
      "action": "remove_worktree_and_branch",
      "pr_merged": true
    },
    {
      "node_id": "PR4",
      "pr_number": 126,
      "pr_url": "https://github.com/owner/repo/pull/126",
      "branch": "task/pr4",
      "worktree": "../wt/PR4",
      "action": "keep",
      "pr_merged": false,
      "reason": "ノード失敗、調査のために worktree を保持"
    }
  ],
  "timestamp": "2026-02-24T00:00:00Z"
}
```
