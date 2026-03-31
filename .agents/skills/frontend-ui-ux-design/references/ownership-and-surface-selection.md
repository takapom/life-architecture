# OMTA オーナーシップ・サーフェス選択アダプター

メソドロジーファイルが UI の役割を明確にした後に使用する。このファイルは OMTA が実装をどこに配置すべきかを決定する。

## 正規配置

1. 共有でクライアントセーフかつアプリ非依存のプリミティブは `packages/ui` に配置する。
   - `packages/ui` を `next/link`、アプリローカルフック、i18n ランタイムから解放しておく。
   - `apps/app` と `apps/platform-admin` の共有プリミティブおよび構成レイヤーとして扱う。
2. `apps/app` では、`@omta/ui` 上のパッケージアダプターとして宣言されている場合のみ `apps/app/src/components/ui` に薄いアダプターファイルを保持する。
   - `primitive-governance.ts` に従う。`components/ui` を任意のアプリローカル UI のホームとして扱わない。
3. Web ローカルコンテキストコンポーネントは `apps/app/src/components` に配置する。
   - コンポーネントが `next/link`、i18n、またはアプリローカルフックに依存する場合、`apps/app/src/components/ui` ではなくここに属する。
4. ルート構成は `apps/app/src/app`、`apps/platform-admin/src/app`、`apps/public-site/src/app` に配置する。
   - ページ、レイアウト、ローディング状態、ルートシェルは薄くする。
   - App Router ファイルに機能ロジックを移動しない。
5. 機能ロジックは `apps/app/src/features`、`apps/platform-admin/src/features`、`apps/public-site/src/features` に配置する。
   - ページ固有のフロー、クエリ/ミューテーションのオーケストレーション、フォーム、状態をここで管理する。
6. マーケティング固有の構成コンポーネントは、共有プリミティブの候補にならない限り `apps/public-site/src/components` に配置する。
7. 共有ビジネスオーナーシップをフロントエンドフォルダで解決しない。
   - 問題が共有ビジネスロジックである場合、`apps/*` を拡張する代わりに `processes/*`、`domains/*`、または `packages/*` に移動する。

## 境界ルール

- `apps -> processes -> domains -> packages` に従う。
- `apps/app/src/app -> src/features -> src/lib/api/@omta/core -> UI プリミティブ` を想定フロントエンドフローとして扱う。
- クライアントコードはクライアントセーフなエントリポイントのみを使用する。
- ブラウザコードから `@omta/*/server`、`@omta/db`、その他のサーバー専用モジュールをインポートしない。
- リポジトリ規約が明示的に拡張されない限り、`components/ui` を直接の Radix インポートから解放しておく。
- `packages/ui` を再利用可能プリミティブの実装 SoT として保持する。共有コンポーネントを `apps/app` で再作成しない。

## サーフェス選択ヒューリスティクス

- 共有プリミティブ、共有カード、共有フォームフィールド、共有シェル要素:
  `packages/ui` を使用する。
- `apps/app` の薄いアダプターで、単に `@omta/ui` をアプリローカルプリミティブ規約を通じて公開するもの:
  `apps/app/src/components/ui` を使用する。
- `next/link`、ロケール対応コピー、またはアプリローカルコンテキストが必要なアプリ専用ラッパー:
  `apps/app/src/components/ui` ではなくアプリローカルの `src/components` を使用する。
- 機能固有のページセクション、ワークフロー、またはコントローラー:
  `apps/app/src/features`、`apps/platform-admin/src/features`、または `apps/public-site/src/features` を使用する。
- グローバルページシェル、レイアウト配線、ルートレベルのローディング/エラー構成:
  該当アプリの `src/app` を使用する。

## エスカレーションすべきケース

- リクエストが共有ビジネスロジックを示唆しているが、ページ/コンポーネントファイルから始まっている。
- 再利用可能なプリミティブがアプリ固有の依存関係を必要としている。
- ルートファイルが非自明な状態遷移やデータオーケストレーションを管理し始めている。
- デザイン変更が既存の `@omta/ui` サーフェスの消費ではなく、新しいトークン/テーマのオーナーシップを必要としている。
- マーケティングサーフェスが、共有 UX トーン規約で解決すべき一回限りのテーマトークンやクロームを要求している。
