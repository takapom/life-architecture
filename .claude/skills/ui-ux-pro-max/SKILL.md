---
name: ui-ux-pro-max
description: "UI/UX デザイン支援スキル。67 のスタイル、96 のカラーパレット、57 のフォントペアリング、25 のチャート、13 のスタック（React、Next.js、Vue、Svelte、SwiftUI、React Native、Flutter、Tailwind、shadcn/ui）を収録。対応アクション: plan、build、create、design、implement、review、fix、improve、optimize、enhance、refactor、UI/UX コードのチェック。対象プロジェクト: website、landing page、dashboard、admin panel、e-commerce、SaaS、portfolio、blog、mobile app、.html、.tsx、.vue、.svelte。要素: button、modal、navbar、sidebar、card、table、form、chart。スタイル: glassmorphism、claymorphism、minimalism、brutalism、neumorphism、bento grid、dark mode、responsive、skeuomorphism、flat design。トピック: color palette、accessibility、animation、layout、typography、font pairing、spacing、hover、shadow、gradient。連携: コンポーネント検索と実装例のための shadcn/ui MCP。"
---
# UI/UX Pro Max - デザインインテリジェンス

Web アプリとモバイルアプリ向けの包括的なデザインガイド。67 のスタイル、96 のカラーパレット、57 のフォントペアリング、99 の UX ガイドライン、25 のチャートタイプを 13 の技術スタックにわたって収録しています。優先度ベースで推奨を返す検索可能なデータベースです。

## 適用するタイミング

次のような場面で、このガイドラインを参照します。
- 新しい UI コンポーネントやページを設計するとき
- カラーパレットやタイポグラフィを選ぶとき
- UX 上の問題がないかコードレビューするとき
- ランディングページやダッシュボードを構築するとき
- アクセシビリティ要件を実装するとき

## 優先度別ルールカテゴリ

| 優先度 | カテゴリ | 影響度 | ドメイン |
|----------|----------|--------|--------|
| 1 | アクセシビリティ | CRITICAL | `ux` |
| 2 | タッチ操作とインタラクション | CRITICAL | `ux` |
| 3 | パフォーマンス | HIGH | `ux` |
| 4 | レイアウトとレスポンシブ | HIGH | `ux` |
| 5 | タイポグラフィと配色 | MEDIUM | `typography`, `color` |
| 6 | アニメーション | MEDIUM | `ux` |
| 7 | スタイル選定 | MEDIUM | `style`, `product` |
| 8 | チャートとデータ表現 | LOW | `chart` |

## クイックリファレンス

### 1. アクセシビリティ（CRITICAL）

- `color-contrast` - 通常テキストは最低 4.5:1 のコントラスト比
- `focus-states` - インタラクティブ要素に視認できるフォーカスリングを付ける
- `alt-text` - 意味のある画像には説明的な alt テキストを付ける
- `aria-labels` - アイコンのみのボタンには aria-label を付ける
- `keyboard-nav` - Tab 順序を見た目の順序と一致させる
- `form-labels` - `for` 属性付きの `label` を使う

### 2. タッチ操作とインタラクション（CRITICAL）

- `touch-target-size` - タップ領域は最低 44x44px
- `hover-vs-tap` - 主要な操作は hover ではなく click/tap で成立させる
- `loading-buttons` - 非同期処理中はボタンを無効化する
- `error-feedback` - 問題箇所の近くに明確なエラーメッセージを表示する
- `cursor-pointer` - クリック可能な要素には `cursor-pointer` を付ける

### 3. パフォーマンス（HIGH）

- `image-optimization` - WebP、`srcset`、遅延読み込みを使う
- `reduced-motion` - `prefers-reduced-motion` を考慮する
- `content-jumping` - 非同期コンテンツ用の表示領域を先に確保する

### 4. レイアウトとレスポンシブ（HIGH）

- `viewport-meta` - `width=device-width initial-scale=1` を設定する
- `readable-font-size` - モバイルの本文サイズは最低 16px
- `horizontal-scroll` - コンテンツがビューポート幅に収まるようにする
- `z-index-management` - `z-index` のスケールを定義する（10、20、30、50）

### 5. タイポグラフィと配色（MEDIUM）

- `line-height` - 本文の行間は 1.5〜1.75 を使う
- `line-length` - 1 行あたり 65〜75 文字を目安にする
- `font-pairing` - 見出し用と本文用のフォントの性格を揃える

### 6. アニメーション（MEDIUM）

- `duration-timing` - マイクロインタラクションは 150〜300ms を使う
- `transform-performance` - `width` / `height` ではなく `transform` / `opacity` を使う
- `loading-states` - スケルトンスクリーンまたはスピナーを用意する

### 7. スタイル選定（MEDIUM）

- `style-match` - プロダクトの種類に合うスタイルを選ぶ
- `consistency` - 全ページで同じスタイル言語を使う
- `no-emoji-icons` - 絵文字ではなく SVG アイコンを使う

### 8. チャートとデータ表現（LOW）

- `chart-type` - データの性質に合うチャートタイプを選ぶ
- `color-guidance` - アクセシブルなカラーパレットを使う
- `data-table` - アクセシビリティのために表形式の代替も提供する

## 使い方

特定のドメインは、以下の CLI ツールで検索します。

---


## 前提条件

Python がインストールされているか確認します。

```bash
python3 --version || python --version
```

Python が未インストールの場合は、ユーザーの OS に応じて導入します。

**macOS:**
```bash
brew install python3
```

**Ubuntu/Debian:**
```bash
sudo apt update && sudo apt install python3
```

**Windows:**
```powershell
winget install Python.Python.3.12
```

---

## この Skill の使い方

ユーザーが UI/UX 作業（design、build、create、implement、review、fix、improve）を依頼した場合は、次のワークフローに従います。

### Step 1: ユーザー要件を分析する

ユーザー依頼から次の情報を抽出します。
- **プロダクト種別**: SaaS、e-commerce、portfolio、dashboard、landing page など
- **スタイルキーワード**: minimal、playful、professional、elegant、dark mode など
- **業界**: healthcare、fintech、gaming、education など
- **スタック**: React、Vue、Next.js。指定がなければ `html-tailwind`

### Step 2: デザインシステムを生成する（必須）

推論付きの包括的な提案を得るため、**必ず `--design-system` から開始**します。

```bash
python3 skills/ui-ux-pro-max/scripts/search.py "<product_type> <industry> <keywords>" --design-system [-p "Project Name"]
```

このコマンドでは次を行います。
1. 5 つのドメイン（product、style、color、landing、typography）を並列検索する
2. `ui-reasoning.csv` の推論ルールを適用して最適な候補を選ぶ
3. pattern、style、colors、typography、effects を含む完全なデザインシステムを返す
4. 避けるべきアンチパターンも含める

**例:**
```bash
python3 skills/ui-ux-pro-max/scripts/search.py "beauty spa wellness service" --design-system -p "Serenity Spa"
```

### Step 2b: デザインシステムを永続化する（Master + Overrides パターン）

セッションをまたいで階層的に参照できるよう、デザインシステムを保存するには `--persist` を追加します。

```bash
python3 skills/ui-ux-pro-max/scripts/search.py "<query>" --design-system --persist -p "Project Name"
```

これにより次が作成されます。
- `design-system/MASTER.md` — すべてのデザインルールを持つグローバルな Source of Truth
- `design-system/pages/` — ページごとの上書きルールを置くフォルダ

**ページ固有の override を付ける場合:**
```bash
python3 skills/ui-ux-pro-max/scripts/search.py "<query>" --design-system --persist -p "Project Name" --page "dashboard"
```

この場合はさらに次も作成されます。
- `design-system/pages/dashboard.md` — Master からのページ固有差分

**階層参照の動作:**
1. 特定のページ（例: `Checkout`）を作るときは、まず `design-system/pages/checkout.md` を確認する
2. ページファイルが存在する場合、そのルールが Master ファイルを **override** する
3. 存在しない場合は `design-system/MASTER.md` のみを使う

### Step 3: 必要に応じて詳細検索を追加する

デザインシステム取得後、必要に応じてドメイン検索で追加の詳細を取得します。

```bash
python3 skills/ui-ux-pro-max/scripts/search.py "<keyword>" --domain <domain> [-n <max_results>]
```

**詳細検索を使う場面:**

| 目的 | ドメイン | 例 |
|------|--------|---------|
| スタイル候補を増やしたい | `style` | `--domain style "glassmorphism dark"` |
| チャートの提案がほしい | `chart` | `--domain chart "real-time dashboard"` |
| UX のベストプラクティスを確認したい | `ux` | `--domain ux "animation accessibility"` |
| 別のフォント候補がほしい | `typography` | `--domain typography "elegant luxury"` |
| LP の構成を詰めたい | `landing` | `--domain landing "hero social-proof"` |

### Step 4: スタック別ガイドラインを取得する（デフォルト: html-tailwind）

実装スタック固有のベストプラクティスを取得します。ユーザーがスタックを指定しない場合は、**`html-tailwind` をデフォルト**にします。

```bash
python3 skills/ui-ux-pro-max/scripts/search.py "<keyword>" --stack html-tailwind
```

利用可能なスタック: `html-tailwind`, `react`, `nextjs`, `vue`, `svelte`, `swiftui`, `react-native`, `flutter`, `shadcn`, `jetpack-compose`

---

## 検索リファレンス

### 利用可能なドメイン

| Domain | 用途 | キーワード例 |
|--------|---------|------------------|
| `product` | プロダクト種別の提案 | SaaS, e-commerce, portfolio, healthcare, beauty, service |
| `style` | UI スタイル、配色、エフェクト | glassmorphism, minimalism, dark mode, brutalism |
| `typography` | フォントペアリング、Google Fonts | elegant, playful, professional, modern |
| `color` | プロダクト種別ごとのカラーパレット | saas, ecommerce, healthcare, beauty, fintech, service |
| `landing` | ページ構成、CTA 戦略 | hero, hero-centric, testimonial, pricing, social-proof |
| `chart` | チャート種別、ライブラリ提案 | trend, comparison, timeline, funnel, pie |
| `ux` | ベストプラクティス、アンチパターン | animation, accessibility, z-index, loading |
| `react` | React/Next.js のパフォーマンス | waterfall, bundle, suspense, memo, rerender, cache |
| `web` | Web インターフェースのガイドライン | aria, focus, keyboard, semantic, virtualize |
| `prompt` | AI プロンプト、CSS キーワード | (style name) |

### 利用可能なスタック

| Stack | 主な対象 |
|-------|-------|
| `html-tailwind` | Tailwind utilities、responsive、a11y（DEFAULT） |
| `react` | State、hooks、performance、patterns |
| `nextjs` | SSR、routing、images、API routes |
| `vue` | Composition API、Pinia、Vue Router |
| `svelte` | Runes、stores、SvelteKit |
| `swiftui` | Views、State、Navigation、Animation |
| `react-native` | Components、Navigation、Lists |
| `flutter` | Widgets、State、Layout、Theming |
| `shadcn` | shadcn/ui components、theming、forms、patterns |
| `jetpack-compose` | Composables、Modifiers、State Hoisting、Recomposition |

---

## ワークフロー例

**ユーザー依頼:** 「プロ向けスキンケアサービスのランディングページを作って」

### Step 1: 要件を分析する
- プロダクト種別: Beauty/Spa service
- スタイルキーワード: elegant, professional, soft
- 業界: Beauty/Wellness
- スタック: html-tailwind（default）

### Step 2: デザインシステムを生成する（必須）

```bash
python3 skills/ui-ux-pro-max/scripts/search.py "beauty spa wellness service elegant" --design-system -p "Serenity Spa"
```

**出力:** pattern、style、colors、typography、effects、anti-patterns を含む完全なデザインシステム。

### Step 3: 必要に応じて詳細検索を追加する

```bash
# animation と accessibility の UX ガイドラインを取得
python3 skills/ui-ux-pro-max/scripts/search.py "animation accessibility" --domain ux

# 必要なら別の typography 候補も取得
python3 skills/ui-ux-pro-max/scripts/search.py "elegant luxury serif" --domain typography
```

### Step 4: スタック別ガイドライン

```bash
python3 skills/ui-ux-pro-max/scripts/search.py "layout responsive form" --stack html-tailwind
```

**その後:** デザインシステムと詳細検索結果を統合し、実装に落とし込みます。

---

## 出力形式

`--design-system` フラグは 2 種類の出力形式に対応しています。

```bash
# ASCII box（default）- ターミナル表示向け
python3 skills/ui-ux-pro-max/scripts/search.py "fintech crypto" --design-system

# Markdown - ドキュメント化向け
python3 skills/ui-ux-pro-max/scripts/search.py "fintech crypto" --design-system -f markdown
```

---

## より良い結果を得るコツ

1. **キーワードは具体的にする** - `"healthcare SaaS dashboard"` のほうが `"app"` より有効
2. **複数回検索する** - キーワードを変えると別の示唆が得られる
3. **ドメインを組み合わせる** - Style + Typography + Color で完全なデザインシステムになる
4. **必ず UX を確認する** - `"animation"`、`"z-index"`、`"accessibility"` は定番の確認項目
5. **stack フラグを使う** - 実装固有のベストプラクティスを取得できる
6. **反復する** - 最初の検索結果が合わなければ、別キーワードで再検索する

---

## プロフェッショナルな UI の共通ルール

以下は見落とされやすく、UI を素人っぽく見せる原因になりやすい項目です。

### アイコンと視覚要素

| ルール | 推奨 | 非推奨 |
|------|----|----- |
| **絵文字アイコンを使わない** | SVG アイコン（Heroicons、Lucide、Simple Icons）を使う | 🎨 🚀 ⚙️ のような絵文字を UI アイコンとして使う |
| **安定した hover 状態** | hover では color / opacity の変化を使う | レイアウトが揺れる scale transform を使う |
| **正しいブランドロゴ** | Simple Icons で公式 SVG を確認する | 推測でロゴやパスを使う |
| **一貫したアイコンサイズ** | 固定 viewBox（24x24）と `w-6 h-6` を使う | 異なるサイズのアイコンを無秩序に混在させる |

### インタラクションとカーソル

| ルール | 推奨 | 非推奨 |
|------|----|----- |
| **カーソルポインター** | クリック可能 / hover 対象のカードすべてに `cursor-pointer` を付ける | インタラクティブ要素のカーソルを初期値のままにする |
| **Hover フィードバック** | 色、影、ボーダーなどの視覚フィードバックを与える | 操作可能だと分からないままにする |
| **滑らかな遷移** | `transition-colors duration-200` を使う | 即時変化、または遅すぎる遷移（500ms 超） |

### ライト / ダークモードのコントラスト

| ルール | 推奨 | 非推奨 |
|------|----|----- |
| **ガラスカードのライトモード** | `bg-white/80` 以上の不透明度を使う | `bg-white/10` を使う（透けすぎる） |
| **ライトモードの文字コントラスト** | 本文テキストには `#0F172A`（slate-900）を使う | 本文に `#94A3B8`（slate-400）を使う |
| **ライトモードの補助テキスト** | 最低でも `#475569`（slate-600）を使う | gray-400 以下の薄い色を使う |
| **ボーダーの視認性** | ライトモードでは `border-gray-200` を使う | `border-white/10` を使う（見えない） |

### レイアウトと余白

| ルール | 推奨 | 非推奨 |
|------|----|----- |
| **フローティング navbar** | `top-4 left-4 right-4` の余白を取る | `top-0 left-0 right-0` に張り付ける |
| **コンテンツの padding** | fixed navbar の高さを見込んで余白を取る | fixed 要素の裏にコンテンツを隠してしまう |
| **一貫した max-width** | `max-w-6xl` か `max-w-7xl` を統一して使う | 異なるコンテナ幅を混在させる |

---

## 納品前チェックリスト

UI コードを納品する前に、次の項目を確認します。

### 見た目の品質
- [ ] アイコンに絵文字を使っていない（代わりに SVG を使う）
- [ ] すべてのアイコンが同じアイコンセット（Heroicons / Lucide）に揃っている
- [ ] ブランドロゴが正しい（Simple Icons で確認済み）
- [ ] hover 状態でレイアウトシフトが起きない
- [ ] テーマカラーは `var()` ではなく `bg-primary` のように直接使う

### インタラクション
- [ ] すべてのクリック可能要素に `cursor-pointer` が付いている
- [ ] hover 状態で明確な視覚フィードバックがある
- [ ] 遷移が滑らか（150〜300ms）
- [ ] キーボード操作向けのフォーカス状態が見える

### ライト / ダークモード
- [ ] ライトモードの文字コントラストが十分（最低 4.5:1）
- [ ] ライトモードでもガラス / 半透明要素が視認できる
- [ ] 両モードでボーダーが見える
- [ ] 納品前に両モードを確認した

### レイアウト
- [ ] フローティング要素が画面端から適切に離れている
- [ ] fixed navbar の裏にコンテンツが隠れていない
- [ ] 375px、768px、1024px、1440px でレスポンシブ確認済み
- [ ] モバイルで横スクロールが発生しない

### アクセシビリティ
- [ ] すべての画像に alt テキストがある
- [ ] フォーム入力にラベルがある
- [ ] 色だけで状態を伝えていない
- [ ] `prefers-reduced-motion` に対応している
