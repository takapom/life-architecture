# 実行出力テンプレート

## 子ステータス JSON

```json
{
  "node_id": "PR1",
  "status": "ready_for_review",
  "summary": "変更内容",
  "failure_reason": "none",
  "pr_url": "https://github.com/owner/repo/pull/123",
  "tests": [
    {"cmd":"bun run ci:fast","result":"pass","notes":""}
  ],
  "changed_files": ["src/app.ts"],
  "timestamp": "2026-02-02T00:00:00Z"
}
```

## レビュー判定 JSON

```json
{
  "node_id": "PR1",
  "decision": "approve",
  "summary": "LGTM",
  "reviewer_lane": "manual",
  "reviewed_at": "2026-02-02T00:00:00Z",
  "findings": [],
  "escalation": {
    "level": "none",
    "reason": ""
  }
}
```

自動レビューセッションでは、オーケストレーターが `reviewer_lane: "auto"` で同じアーティファクト形状を書き込む。

## コンフリクト JSON

```json
{
  "node_id": "PR1",
  "branch": "task/pr1",
  "base_branch": "main",
  "conflicts": ["src/app.ts"],
  "timestamp": "2026-02-02T00:00:00Z"
}
```
