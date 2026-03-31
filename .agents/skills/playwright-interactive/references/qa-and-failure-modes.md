# QA と障害モード

## QA インベントリ

サインオフ前に、インベントリが以下の3つのソースすべてをカバーしていることを確認する:

- ユーザーが要求した要件。
- 実際に変更したユーザー向けコントロール、モード、状態。
- 最終回答で行う予定の具体的な主張。

各主張またはコントロール-状態ペアについて、以下を定義する:

- 機能チェック。
- エビデンスが必要な正確なビジュアル状態。
- キャプチャ予定のスクリーンショットまたは観察。

常に少なくとも2つの探索的またはハッピーパス外のシナリオを追加する。

## リロード vs 再起動

- レンダラーコード、CSS、またはクライアントサイドの状態配線のみが変更された場合はリロードする。
- スタートアップフロー、サーバーブート、Electron メインプロセス、パーミッション、またはプロセスオーナーシップが変更された場合は再起動する。
- ハンドルが古くなっているように見える場合、カーネル全体をリセットするのではなく、そのバインディングのみをクリアして再作成する。

## ビューポートフィットルール

ビューポートフィットは推測ではなく、必須のエビデンスである。

- サインオフ前に意図する初期ビューを定義する。
- プライマリのインタラクティブサーフェスまたは必須コントロールが意図する初期ビューからクリップされたりはみ出している場合、サインオフは失敗する。
- 固定シェル、エディター、ダッシュボード、キャンバスでは、ドキュメントレベルのスクロールメトリクスでは不十分。
- スクリーンショットをプライマリエビデンスとして使用し、数値チェックはサポートとしてのみ使用する。

ブラウザ側で有用なチェック:

```javascript
console.log(await page.evaluate(() => ({
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  clientWidth: document.documentElement.clientWidth,
  clientHeight: document.documentElement.clientHeight,
  scrollWidth: document.documentElement.scrollWidth,
  scrollHeight: document.documentElement.scrollHeight,
  canScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  canScrollY: document.documentElement.scrollHeight > document.documentElement.clientHeight,
})));
```

クリッピングの可能性がある場合、ページレベルのメトリクスだけを信頼するのではなく、特定の必須領域に対して `getBoundingClientRect()` チェックを追加する。

## 一般的な障害モード

- `Cannot find module 'playwright'`: 現在のワークスペースに Playwright をインストールし、インポートを再確認する。
- ブラウザ実行ファイルが見つからない: `npx playwright install chromium` を実行する。
- `page.goto: net::ERR_CONNECTION_REFUSED`: 開発サーバーがリッスンしていないか、ポートが間違っている。
- Electron の起動がハングまたは終了する: ローカルの `electron` 依存関係を確認し、レンダラー開発サーバーが既に実行中であることを確認する。
- `Identifier has already been declared`: 既存のトップレベルバインディングを再利用するか、新しい名前を選ぶか、セルを `{ ... }` でラップする。
- `js_repl` がタイムアウトまたはリセットされる: ブートストラップを再実行し、必要なハンドルのみを再構築する。
