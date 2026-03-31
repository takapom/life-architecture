# 登録出力テンプレート

## ファクトチェックテーブル

| id | 主張 | 判定 | エビデンス | 備考 |
|---|---|---|---|---|
| FC-1 | 短い主張 | valid | `path/file.ts:123` | 詳細 |

## タスク Issue スニペット（`Commit Units`）

```md
## Commit Units
- [ ] CU1: parser/型定義の更新（最小スコープ）
- [ ] CU2: metadata guard を追加（fail-closed）
- [ ] CU3: 回帰テストを追加（fail/pass 境界を固定）
```

### 備考
- `Commit Units` は「実行順」と「コミット順」を同時に表す。
- 1 unit 完了ごとに `commit` + `push` を行い、途中状態を long-lived に溜めない。
- scope 変更が発生した場合は、実装より先に Issue の `Commit Units` を更新する。

## ハンドオフバンドルスケルトン

```json
{
  "issue_tracking": {
    "strategy": "remote-github-sot",
    "repository": "owner/repo",
    "progress_issue_number": 0,
    "progress_issue_url": ""
  },
  "source_items": [
    {
      "id":"FC-1",
      "verdict":"valid",
      "summary":"...",
      "parent_issue_number":900,
      "parent_issue_url":"https://github.com/owner/repo/issues/900"
    }
  ],
  "issue_map": {
    "FC-1": "https://github.com/owner/repo/issues/101"
  },
  "deferred_items": [],
  "nodes": [
    {
      "id": "PR1",
      "branch": "task/pr1",
      "github_issue": "https://github.com/owner/repo/issues/101",
      "covers": ["FC-1"],
      "allowed_files": ["path/a.ts"],
      "acceptance_checks": ["bun run check:docs"],
      "tests": ["bun run test:unit:affected"]
    }
  ]
}
```

## PR ボディスニペット（コミットケイデンス）

```md
## Commit Cadence
1. CU1 完了 -> commit/push
2. CU2 完了 -> commit/push
3. CU3 完了 -> commit/push
```
