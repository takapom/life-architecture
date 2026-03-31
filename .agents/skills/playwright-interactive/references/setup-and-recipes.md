# セットアップとレシピ

## 初回セットアップ

対象ワークスペースの通常のパッケージマネージャーを使用する。

```bash
test -f package.json || npm init -y
npm install playwright
# Web のみ、ブラウザバイナリが見つからない場合の headed Chromium:
npx playwright install chromium
# Electron のみ、ワークスペースが Electron アプリ自体の場合:
npm install --save-dev electron
node -e "import('playwright').then(() => console.log('playwright import ok')).catch((error) => { console.error(error); process.exit(1); })"
```

## ブートストラップセル

`js_repl` カーネルごとに一度実行し、これらのバインディングを生かしておく:

```javascript
var chromium;
var electronLauncher;
var browser;
var context;
var page;
var mobileContext;
var mobilePage;
var electronApp;
var appWindow;

({ chromium, _electron: electronLauncher } = await import("playwright"));
console.log("Playwright loaded");
```

- 後続のセルが同じハンドルを再利用するため、`const` や `let` ではなく `var` を使用する。
- ハンドルが古くなった場合、カーネルをリセットするのではなく、そのバインディングを `undefined` に設定して関連するセルを再実行する。

## Web セッション

デスクトップ Web:

```javascript
var TARGET_URL = "http://127.0.0.1:3000";

browser ??= await chromium.launch({ headless: false });
context ??= await browser.newContext({ viewport: { width: 1600, height: 900 } });
page ??= await context.newPage();

await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
console.log("Loaded:", await page.title());
```

モバイル Web:

```javascript
var MOBILE_TARGET_URL = typeof TARGET_URL === "string" ? TARGET_URL : "http://127.0.0.1:3000";

browser ??= await chromium.launch({ headless: false });
mobileContext ??= await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
mobilePage ??= await mobileContext.newPage();

await mobilePage.goto(MOBILE_TARGET_URL, { waitUntil: "domcontentloaded" });
```

## Electron セッション

同じセッションがプロセスを所有するように `js_repl` から Electron を起動する:

```javascript
var ELECTRON_ENTRY = ".";

electronApp = await electronLauncher.launch({ args: [ELECTRON_ENTRY] });
appWindow = await electronApp.firstWindow();

await appWindow.waitForLoadState("domcontentloaded");
console.log(await appWindow.title());
```

- レンダラーが開発サーバーに依存する場合、まず永続的な TTY セッションでそのサーバーを起動する。
- メインプロセスまたはアプリブートストラップが変更された場合は、リロードのみではなく Electron を再起動する。

## スクリーンショット

シンプルなエビデンスキャプチャ:

```javascript
await codex.emitImage({
  bytes: await page.screenshot({ type: "jpeg", quality: 85 }),
  mimeType: "image/jpeg",
});
```

Electron:

```javascript
await codex.emitImage({
  bytes: await appWindow.screenshot({ type: "jpeg", quality: 85 }),
  mimeType: "image/jpeg",
});
```

CSS 座標で正規化されたスクリーンショット、クリップされた Electron キャプチャ、またはモデルバウンドのクリックヘルパーが必要な場合は、このローカルスキルの適応元である上流のキュレーションスキルを参照する。

## クリーンアップ

タスクが完了した時のみ実行する:

```javascript
if (electronApp) await electronApp.close().catch(() => {});
if (mobileContext) await mobileContext.close().catch(() => {});
if (context) await context.close().catch(() => {});
if (browser) await browser.close().catch(() => {});

browser = undefined;
context = undefined;
page = undefined;
mobileContext = undefined;
mobilePage = undefined;
electronApp = undefined;
appWindow = undefined;

console.log("Playwright session closed");
```
