## 概要

## Linked Task Issue (必須)
- `Closes #<task-issue-number>` を記載

## 変更内容
- 

## Acceptance Criteria Coverage (必須)
| Acceptance Criteria (issue) | Changed Files | Validation (checks/tests) |
| --- | --- | --- |
| 例: 〇〇画面で文言が i18n 化される | `apps/web/src/...` | `bun run check:i18n` |

## Commit Unit Coverage (必須)
- 各 non-merge commit は宣言済み `CU<n>` をちょうど 1 つ参照する
- 記法: commit subject を `CU1: ...` にするか、commit trailer `CU: CU1` を付ける
- 1 commit に複数の `CU<n>` を混在させない

## テスト
- 

## Evaluation-first Checklist (必須)
- [ ] 対応Issueの Acceptance Criteria を全件マッピングした
- [ ] 変更ファイルは `Allowed Files` の範囲内に収まっている
- [ ] 全ての non-merge commit が宣言済み `CU<n>` にちょうど 1 つ紐づいている
- [ ] 実行した検証コマンドを `Acceptance Checks` / `Tests` から記載した
- [ ] マッピングできない要件がある場合、実装前に Issue を更新した

## デザインDoD
- [ ] Light / Dark 両方で確認
- [ ] 320px 幅で崩れがない
- [ ] Loading / Error / Empty の状態を確認
- [ ] Focus / キーボード操作 / aria の確認
- [ ] 主要な成功・失敗状態の文言と導線を確認
