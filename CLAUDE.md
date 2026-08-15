# portal プロジェクトルール

## プロジェクト概要
えぐしゅぎ ラボ のポータルサイト（各ゲームアプリ・SNSリンク集）

## 技術スタック
- フレームワーク: Next.js 16 (App Router, 静的エクスポート)
- 言語: TypeScript
- UI: React 19 + Tailwind CSS 4 + shadcn/ui (new-york スタイル)
- CDN: Cloudflare

## デプロイ
- ビルド: `npm run build` → `out/` に静的サイト生成
- デプロイ: `npm run deploy`（SFTP アップロード + Cloudflare キャッシュパージ）
- キャッシュパージのみ: `npm run purge-cache`
- デプロイ先: `S:\html\` (Webルート) = サーバーの `/var/www/html`
- URL: `http://192.168.0.77/` (ルート)

### ポータルからの子アプリリンク構成
- `/pekarin-chinchiro/` → ぺかりんのえぐしゅぎチンチロ（V4 最下位回避ロジック搭載の新版）
- `/chinchiro/` → 旧チンチロ（バニラJS版、温存）
- `/word-wolf/` → ワードウルフ
- `/kingscup/` → キングスカップ
- `/stamps/` → LINE スタンプ（portal自身のサブページ）
- `/noxa/` → NOXA 構想紹介ページ（portal自身のサブページ・独自OG画像つき）
- `/workspaces/` → ワークスペース紹介ページ（portal自身のサブページ）

## ディレクトリ構成
- `app/` - Next.js ページ（トップ、stamps）
- `components/` - Reactコンポーネント
- `components/ui/` - shadcn/ui コンポーネント群
- `hooks/` - カスタムフック
- `lib/` - ユーティリティ（cn関数等）
- `scripts/` - デプロイ・キャッシュパージスクリプト

## 検証コマンド（何を実際に検査するか）
- `npm run check` … 型 + 監視系セルフテスト + egtype 整合を**まとめて**実行（これが日々の検証の入口）
- `npm run typecheck` … `tsc --noEmit`（実測: app/components など **161 ファイル**を検査する）
- `node scripts/selftest-check-links.mjs` … 死活監視 check-links の抽出・振り分け・配線（**フィクスチャで完結**。`LINKS_SRC_DIR` を使い実在ドメインは叩かない）
  - この「叩かない」は Day131 まで**名乗りだけ**だった（実走 spawn 7箇所のうち4箇所が正本の app/ を読み、1回につき外部11件を叩いていた）。
    現在は末尾の自己floor が「HTTP を打つ spawn は全数が口を渡す」「フィクスチャの監視対象は全てローカル」を規則として固定している。
    実測: ネットワークを遮断して走らせても pass 全件・約28秒で終わる（遮断前の旧実装は fail=3・352秒）。配線テストを足すときは口を渡すこと。
- `node scripts/check-links.mjs` … 本番への実走（外部ドメインを実際に叩く。cron/GitHub Actions もこれ）
- **`npm run lint` は無い**（2026-08-15 に削除）。eslint はこのリポの依存に**一度も入っていなかった**ため、
  `"lint": "eslint ."` は実行すると `eslint: not found` で落ちるだけの空手形だった。
  lint を入れる場合は eslint / eslint-config-next を devDependencies に追加してから script を戻すこと。

## コーディング規約
### コンポーネント追加時
- [ ] shadcn/ui コンポーネントは `npx shadcn@latest add <component>` で追加
- [ ] パスエイリアス `@/*` を使用（ルートからの相対パス）
- [ ] アイコンは `lucide-react` を使用

### 新しいアプリリンク追加時
- [ ] `components/featured-apps.tsx` の `apps` 配列にエントリを追加

### 壊さないガード（必須遵守）
- `next.config.ts` の `output: "export"` を変更しない
- 既存のゲームアプリへのリンクパス（`/pekarin-chinchiro/`, `/word-wolf/`, `/kingscup/`）を変更しない
- Cloudflare APIトークンをコードにハードコードしない
- ポータルは Web ルートにデプロイされるため `basePath` は設定しない
