# OMTA バリデーションアダプター

変更したサーフェスに対して最小限かつ十分なチェックセットを実行する。このファイルは抽象的な UX 判断ではなく、OMTA の実装を検証するもの。

## コア Web ゲート

- ほとんどの `apps/app` フロントエンド変更の場合:
  `bun run lint:strict:web` を実行する

これは以下を含むリポジトリレベルの主要なフロントエンドガードをカバーする:

- UI ユーティリティクラスの制限
- ユーザー向けコピーのチェック
- Web レイヤー境界
- platform-admin 機能境界チェック

## サーフェス固有のチェック

### `apps/app`

- 型安全性:
  `bun run --filter @omta/app typecheck` を実行する
- 対象を絞った単体検証:
  `bun run --cwd apps/app test:unit:file -- <変更したテストまたはソースの隣接ファイル>` を実行する
- 変更が狭いスコープに収まらない場合の広範な単体カバレッジ:
  `bun run --filter @omta/app test:unit` を実行する
- ルート/レイアウト/グローバルスタイルのエントリポイント変更:
  `bun scripts/check-web-global-style-entrypoints.ts` を実行する
- コピーまたはロケール変更:
  `bun run check:i18n` を実行する

### `apps/platform-admin`

- リントと機能境界:
  `bun run --filter @omta/platform-admin lint` を実行する
- 型安全性:
  `bun run --filter @omta/platform-admin typecheck` を実行する
- 動作変更時の単体カバレッジ:
  `bun run --filter @omta/platform-admin test:unit` を実行する

### `apps/public-site`

- リント:
  `bun run --filter @omta/public-site lint` を実行する
- 型安全性:
  `bun run --filter @omta/public-site typecheck` を実行する
- 動作変更時の単体カバレッジ:
  `bun run --filter @omta/public-site test:unit` を実行する
- ビジュアルまたは公開サーフェスの回帰:
  `bun run --filter @omta/public-site test:visual` を実行する

### `packages/ui`

- リント:
  `bun run --filter @omta/ui lint` を実行する
- 型安全性:
  `bun run --filter @omta/ui typecheck` を実行する
- 共有プリミティブのテスト:
  `bun run --filter @omta/ui test:unit` を実行する
- テーマ、トークン、ブランドマーク、または共有 UX トーンの変更:
  `bun run check:ux-tone-contract` を実行する
- 公開サーフェスまたはエクスポートの変更:
  `bun run check:export-boundaries` を実行する

## エスカレーションチェック

- 変更がオーナーシップ境界を移動させるか複数のワークスペースに影響する場合:
  `bun run typecheck` を実行する
- 変更が Web アプリが消費するエクスポートを変更する場合:
  `bun run --filter @omta/app build` を実行する

## レビュー規律

- バグ修正には回帰テストを追加または更新する。
- リファクタリングには動作不変のエビデンスを示す。
- まず対象を絞ったテストを優先し、変更範囲が要求する場合にのみ拡大する。
