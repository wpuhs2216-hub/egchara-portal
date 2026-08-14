// リンク死活チェッカー — 内部リンク / app の実ルート / 主要外部リンク / 32キャラ画像を実リクエストで確認する。
// 内部ターゲットは「リンク由来(href)」と「ルート由来(app/**/page.tsx)」の和集合。後者が無いと
// どこからもリンクされない救済ルート(/workspaces/ 等)が永久に無監視になる(Day97)。
// 使い方:
//   node scripts/check-links.mjs             # 本番 (https://egshugy.com) に対して確認
//   node scripts/check-links.mjs --base http://192.168.0.77   # オリジン直叩き
//   node scripts/check-links.mjs --strict    # egtype配信(soft)の404も致命扱い
//   node scripts/check-links.mjs --list      # 実リクエストを出さず監視対象一覧だけ出す
// 終了コード: portal自前リンク失敗=1 / soft(egtype配信 /egtype/**)失敗は既定で警告のみ(0)・--strictで1
//   (egtype と portal はセットでデプロイ。egtype 未デプロイ中の新16体型ページ404は想定内)
//   soft/hard は URL の配信主体から導く(Day101・classifyTargetUrl)。カテゴリ名ではないので
//   「同じ egtype デプロイ依存なのに画像は致命・型ページは警告」のような割れ方は起こらない。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchWithRetry } from './fetch-with-retry.mjs'
import { extractExternalUrls, extractCharIds, extractLocalAssetRefs, routesFromPageFiles, normalizeRoutePath, findSelfUrlMismatches, extractMetadataBaseOrigin, classifyTargetUrl, canonicalizeTargetUrl, crossRepoRootFromRoster, CROSS_REPO_PREFIXES, findIconOnlyControlsWithoutName, findRedirectStubsWithoutNoindex, findRoutesNamingLayoutDefault, ogImageRoutesFromFiles, classifyOgDelivery, findSitemapCoverageGaps, findOriginWideSwWipes, findRobotsSitemapIssues, classifyServedRobots, classifyServedSitemap, isServedSitemapFatal, partitionLinkResults, isUnreachableResult, hostOf, diagnoseConnectFailures, classifyRecheck, resolveConnectFailures } from './lib/extract-targets.mjs'
import { simulateSwActivate } from './lib/sw-activate-sim.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const baseIdx = process.argv.indexOf('--base')
const baseArg = baseIdx > -1 ? process.argv[baseIdx + 1] : null
if (baseIdx > -1 && !baseArg) { console.error('--base にはURLを指定してください'); process.exit(2) }
const BASE = (baseArg ?? 'https://egshugy.com').replace(/\/$/, '')

// --- 監視対象の「抽出層」そのものの override(Day125・Day116 起票) ---
// 既存の LINKS_APP_DIR / LINKS_SELFURL_DIR / LINKS_SW_DIR / LINKS_PUBLIC_DIR は
// **各ガード専用**の口で、「そもそも何を叩くか」を決める抽出層——featured-apps /
// EXPERIMENTS / app の JSX / live components——には口が無かった。
// そのため配線テストは**正本の app/ をそのまま**読むしかなく、実在の外部ドメイン
// (x.com・tiktok・googletagmanager)を本当に叩いていた＝実行環境の回線状態で結果が変わる。
// 実測: セルフテストが **9回に1回**「本題と無関係な赤」を出していた(Day123 PM で計測)。
// フィクスチャを見せられる口を1つ足し、抽出層まで含めて決定的に固定できるようにする。
// 既定は従来どおり正本(ROOT)なので、この口を使わない限り挙動は不変。
const SRC_ROOT = process.env.LINKS_SRC_DIR ? path.resolve(process.env.LINKS_SRC_DIR) : ROOT
const SRC_APP = path.join(SRC_ROOT, 'app')
const SRC_COMPONENTS = path.join(SRC_ROOT, 'components')

// 抽出元のファイルを読む。**正本を見ているときに無いのは構成変更**なので、生の ENOENT を
// 投げずに名指しで落とす（従来は featured-apps.tsx / app/page.tsx を無条件 readFileSync
// しており、消えた日はスタックトレースだけが出て「何の抽出が死んだか」が読めなかった）。
// フィクスチャ(LINKS_SRC_DIR)では任意＝最小の app/ だけで配線を踏める。
function readSourceFile(file, label) {
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
  if (SRC_ROOT === ROOT) {
    console.log(`  ✗ 抽出失敗 [${label}] ${path.relative(ROOT, file)} が見つからない`)
    console.log(`[check-links] ✗ 致命: ${label} の抽出元が無い（構成変更で監視が無言化した可能性）。`)
    process.exit(1)
  }
  return ''
}


// あるコンポーネントが app/ の実ルートから import され実際にレンダーされているか。
// import されていない = デッドコンポーネント(未レンダー)で、その内部リンクは live サイトの
// どこからも辿れない phantom。
function isImportedByApp(basename) {
  const stack = [SRC_APP]
  const re = new RegExp(`from\\s+["'][^"']*${basename}["']`)
  while (stack.length) {
    const dir = stack.pop()
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.name.endsWith('.tsx') && re.test(fs.readFileSync(full, 'utf8'))) return true
    }
  }
  return false
}

// 1) featured-apps.tsx の内部リンク抽出は「featured-apps が実際に app/ から import されて
//   いる時だけ」行う。Day58 で判明したとおり featured-apps は現在どのページからも import
//   されていないデッドコンポーネントで、その配列には live カタログ(EXPERIMENTS / app JSX)に
//   存在しない phantom リンク(/ng-word/・/party/・/team-maker/ 等)が含まれる。常時抽出すると
//   ①live から辿れないアプリの 404 で check-links が false-red になり ②「デッド components/ は
//   監視しない」という下の collectAppInternal の方針(Day58)と自己矛盾する。import された
//   (＝カタログとして復活した)時だけ拾い、それ以外は live 実リンク(experimentInternal +
//   pageNavInternal)に委ねる(Day64)。
const featuredLive = isImportedByApp('featured-apps')
const featured = readSourceFile(path.join(SRC_COMPONENTS, 'featured-apps.tsx'), 'featured-apps')
const featuredInternal = featuredLive
  ? [...featured.matchAll(/href: "(\/[a-z0-9-]+\/)", comingSoon: (true|false)/g)]
      .filter((m) => m[2] === 'false')
      .map((m) => m[1])
  : []

// 2) page.tsx の ALL_CHARACTERS から32キャラ画像URL + 図鑑カードのディープリンク先(types)を生成
const page = readSourceFile(path.join(SRC_APP, 'page.tsx'), 'トップの配列(ALL_CHARACTERS/EXPERIMENTS)')

// 2.5) page.tsx の EXPERIMENTS(あそぶ) からも稼働中(active|beta)ゲームの内部リンクを抽出。
//   featured-apps とは別配列・別 shape(status ベース)で持つため、ここを見ないと playground の
//   リンク切れを取りこぼす（実際 6ボールパズルが /puzzle/(404) と /ramune-puzzle/(200) で
//   featured-apps と食い違っていた）。soon(href なし)は対象外。featured-apps と重複しても Set で統合。
const experimentInternal = [...page.matchAll(/status: "(?:active|beta)", href: "(\/[a-z0-9-]+\/)"/g)]
  .map((m) => m[1])

// 2.6) ライブページ(app/**/*.tsx)の JSX 静的内部リンク(href="/...")も抽出。
//   ヘッダ/フッタ/ナビの Link href="/noxa/"・href="/stamps/" 等は featured-apps/EXPERIMENTS の
//   オブジェクト配列 shape に載らないため、これを見ないと portal 自前サブページ導線のリンク切れを
//   取りこぼす(実際 /noxa/・/stamps/ が無監視だった＝Day45 の EXPERIMENTS 取りこぼしと同クラス)。
//   アンカー(#...)・動的(テンプレートリテラル ${...})は静的 href="/..." に一致しないため自然に除外。
//   キャラ型頁の /egtype/types/<id>/ は charPages(soft)が別途担当。components/ は未レンダーの
//   デッドコンポーネントを含むため対象にせず、実ルートである app/ のみを見る。
function collectAppInternal(dir) {
  let out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out = out.concat(collectAppInternal(full))
    else if (e.name.endsWith('.tsx')) {
      const src = fs.readFileSync(full, 'utf8')
      out = out.concat([...src.matchAll(/href="(\/[a-z0-9/-]*)"/g)].map((m) => m[1]))
    }
  }
  return out
}
const pageNavInternal = collectAppInternal(SRC_APP)

// 2.7) app/**/page.tsx から「実際に配信されるルート」そのものを列挙する(Day97)。
//   2)〜2.6) はいずれも **リンク**(href / 配列の href フィールド)を辿る抽出で、どこからも
//   リンクされないルートは監視対象に一度も入らない。実例が `/workspaces/` で、これは
//   yorulog の Service Worker が握った古いキャッシュから来た人をトップへ逃がす救済ルート＝
//   **リンクされないことが仕様**。本番で 200 を返しているのに監視は素通りで、消えても
//   check-links は「✓ 全件OK」と出る(= 監視対象の選定層での false-green)。
//   リンク由来の集合と Set で統合するので、リンクもあるルート(/・/noxa/・/stamps/)は重複しない。
function collectPageFiles(dir, prefix = '') {
  let out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out = out.concat(collectPageFiles(path.join(dir, e.name), rel))
    else out.push(rel)
  }
  return out
}
const { routes: appRoutes, skipped: skippedRoutes } = routesFromPageFiles(collectPageFiles(SRC_APP))
// 抽出0件の floor(Day91 と同型): app/ に page が1つも無いことは静的ポータルではありえず、
// 0件は「ルート規約の変更でこの層が黙って死んだ」ことを意味する。そのまま進むと
// リンク由来だけの旧挙動へ静かに退化する＝この修正自体が無言で無効化されるため即座に落とす。
if (appRoutes.length === 0) {
  console.log('  ✗ 抽出失敗 [実ルート] app/ から page.* を1件も抽出できない')
  console.log('[check-links] ✗ 致命: 実ルート抽出が0件（Next のルート規約変更で監視が無言化した可能性）。scripts/lib/extract-targets.mjs の routesFromPageFiles を確認すること。')
  process.exit(1)
}
// リンク由来はルート由来と表記を揃えてから統合する(PM Day97)。trailingSlash: true 環境で
// `href="/noxa"` と `/noxa/` は同じルートなので、素の Set 統合だと同一ルートを2回叩き、
// 「うち無リンクM」もリンク済みルートを無リンクと誤報する。
const linkInternal = [...new Set([...featuredInternal, ...experimentInternal, ...pageNavInternal].map(normalizeRoutePath))]
const internal = [...new Set([...linkInternal, ...appRoutes])]
const unlinkedRoutes = appRoutes.filter((r) => !linkInternal.includes(r))
for (const s of skippedRoutes) console.log(`  ⓘ 静的検査対象外 [実ルート] app/${s.file}（${s.reason}）`)
const charIds = extractCharIds(page)
// 抽出0件の floor(Day91): 抽出は page.tsx の記法に依存するため、整形や ID 規則の変更で
// 黙って0件になりうる。そのまま進むと「キャラ画像0 + キャラ型頁0 件を検査して✓全件OK」と
// いう完全な false-green になり、32体の死活監視が消えたことに誰も気づけない。抽出が死んだ
// ことそれ自体を致命として即座に落とす。
if (charIds.length === 0) {
  console.log('  ✗ 抽出失敗 [キャラ] app/page.tsx の ALL_CHARACTERS から id を1件も抽出できない')
  console.log('[check-links] ✗ 致命: キャラ抽出が0件（記法変更で監視が無言化した可能性）。scripts/lib/extract-targets.mjs の CHAR_ID_RE を確認すること。')
  process.exit(1)
}
const charImages = charIds.map((id) => `/egtype/characters/${id}.webp`)
// 図鑑カードは /egtype/types/<id>/ へディープリンクする（Day23）。リンク切れを死活監視する。
const charPages = charIds.map((id) => `/egtype/types/${id}/`)

// 3) 主要外部リンク（live なソースから抽出し、CDN/フォント等のノイズを除外）
// 抽出規則は scripts/lib/extract-targets.mjs（クエリ・@handle を含む実URLを拾い、
// テンプレートリテラルの動的URLは捨てる）。
const EXCLUDE = /w3\.org|fonts\.|line-scdn|embed\.js|placeholder|schema\.org/
function collectTsx(dir) {
  let out = ''
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out += collectTsx(full)
    else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) out += fs.readFileSync(full, 'utf8')
  }
  return out
}
// components/ は app/ から import された(＝実際にレンダーされる)ものだけを見る。
// 内部リンクについては featured-apps(Day58/Day64) と collectAppInternal(Day45) で
// 「デッドコンポーネントの phantom リンクは監視しない」方針を既に採っているのに、
// 外部URLだけがその方針から漏れて components/ 全体を無条件に舐めていた(Day91)。
// 実害: 現在 components/ は全ファイルが未 import で、そこから
//   https://www.tiktok.com/@（テンプレートリテラルが切れた実在しない phantom）
//   https://x.com/Egshugy ほか、live と食い違う旧 SNS ハンドル4件
// が hard ターゲットとして叩かれていた。誰も辿れないリンクの404で cron が red になる
// (＝false-red)一方、live 側のハンドルとの食い違いは検知できないという逆立ちが起きる。
function collectLiveComponents() {
  const dir = SRC_COMPONENTS
  if (!fs.existsSync(dir)) return ''
  let out = ''
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) continue // components/ui 等のサブディレクトリは直接ルートにならない
    if (!/\.tsx?$/.test(e.name)) continue
    const base = e.name.replace(/\.tsx?$/, '')
    if (isImportedByApp(base)) out += fs.readFileSync(path.join(dir, e.name), 'utf8')
  }
  return out
}
const liveSrc = collectTsx(SRC_APP) + collectLiveComponents()
const externals = extractExternalUrls(liveSrc, { exclude: EXCLUDE })

// 一時失敗(タイムアウト/瞬断/5xx/429)は fetchWithRetry が数回リトライしてから確定する。
// 単発フレークで死活監視が「致命」誤警報を出すのを防ぐ(恒久404はリトライせず即検知)。
async function check(url) {
  const r = await fetchWithRetry(url)
  // challenged: bot 対策に阻まれて生死が測れない応答(Day116)。ok でも失敗でもない第三の状態。
  return { url, status: r.status, ok: r.ok, err: r.err, errCode: r.errCode ?? null, challenged: Boolean(r.challenged) }
}

// カテゴリ分離: portal自前で常時live であるべきもの(hard)と、egtype の別デプロイに
// 依存する型ページ・ディープリンク(soft)を分ける。type ページは egtype 本番デプロイ後に
// 有効化される(portal と egtype はセットでデプロイする運用)。egtype 未デプロイ中に
// 新16体の /egtype/types/<id>/ が404になるのは既知・想定内で、portal の cron 定点観測を
// 常時 red にしない。--strict 指定時のみ soft 失敗も致命(exit 1)にする。
// --- ローカル静的アセットの実在チェック(HTTP前・メタ/JSX のルート直下画像参照) ---
// OG/twitter/icon 等メタの画像参照や JSX の src は check-links の href 抽出に載らず(href ではない)、
// 実在しない public アセットを指していても HTTP チェックの網から漏れる(実際 /stamps の openGraph が
// 実在しない /og-image.png を指し共有カードが 404 だった=Day82)。app 配下のルート直下画像リテラル
// ("/xxx.png" 等・単一セグメント)が public/ に実在することをファイルシステムで固定する。
// /egtype/... のような多セグメント(別アプリ配信)や ${...} 動的パスは対象外(自然に除外される)。
// 抽出規則は scripts/lib/extract-targets.mjs。Day91 で①シングルクォート対応
// (layout.tsx は全面シングルクォートで書かれており、そこに画像を1行足すだけで
// Day82 と同じ「実在しない OG 画像を指して共有カードが404」が無検知で再発しえた)
// ②PWA 必須資産 /manifest.json・/sw.js まで対象化(拡張子が画像でないため無検査だった)。
function scanLocalAssetRefs() {
  const refs = new Set()
  const stack = [SRC_APP]
  while (stack.length) {
    const dir = stack.pop()
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.name.endsWith('.tsx')) {
        for (const p of extractLocalAssetRefs(fs.readFileSync(full, 'utf8'))) refs.add(p)
      }
    }
  }
  return [...refs]
}
const localImageRefs = scanLocalAssetRefs()
const localMissing = localImageRefs.filter((p) => !fs.existsSync(path.join(ROOT, 'public', p)))
for (const p of localMissing) console.log(`  ✗ MISSING  [ローカル静的] public${p} が存在しない(メタ/JSX が参照・共有カード等が404になる)`)

// --- canonical / og:url の自己参照ずれ(PM Day97) ---
// 自サイトの絶対URL宣言は死活監視から見ればただの外部リンクで、**別ルートを指していても
// 200 が返るので永久に検知されない**。検索エンジンへの正規URL誤申告・SNS で別ページの
// 共有カードが出る、という実害だけが静かに残る。実ルートを母集団にして突合する。
// origin は app/layout.tsx の metadataBase を単一の出所とする（二重管理を作らない）。
// LINKS_SELFURL_DIR は selftest がフィクスチャを見せるための非破壊 override(Day94 の
// UPTIME_APP_DIR と同じ作法)。正本を一時改竄せずに「ずれ→exit 1」の配線まで固定できる。
const SELFURL_DIR = process.env.LINKS_SELFURL_DIR ? path.resolve(process.env.LINKS_SELFURL_DIR) : SRC_APP
const selfOrigin = extractMetadataBaseOrigin(fs.readFileSync(path.join(SELFURL_DIR, 'layout.tsx'), 'utf8'))
if (!selfOrigin) {
  console.log('  ✗ 抽出失敗 [自己URL] app/layout.tsx から metadataBase を読めない')
  console.log('[check-links] ✗ 致命: metadataBase 抽出が0件（記法変更で canonical/og:url の突合が無言化した可能性）。')
  process.exit(1)
}
const selfUrlEntries = collectPageFiles(SELFURL_DIR)
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => ({ file: f, src: fs.readFileSync(path.join(SELFURL_DIR, f), 'utf8') }))
const { mismatches: selfUrlMismatches, declarations: selfUrlDeclarations } = findSelfUrlMismatches(selfUrlEntries, selfOrigin)
// 宣言0件の floor(Day91 と同型)。突合対象を canonical/url のキーに絞った分、記法変更
// (例: canonical を new URL(...) で組む)で母集団が黙って空になり、「✓ 整合」と出たまま
// 突合が消える経路が生まれる。宣言が1件も無いこと自体を致命として顕在化する。
if (selfUrlDeclarations === 0) {
  console.log('  ✗ 抽出失敗 [自己URL] app/ の page/layout から canonical・og:url の宣言を1件も抽出できない')
  console.log('[check-links] ✗ 致命: 自己URL宣言が0件（記法変更で突合が無言化した可能性）。scripts/lib/extract-targets.mjs の findSelfUrlMismatches を確認すること。')
  process.exit(1)
}
// ずれはネットワークを見るまでもなく確定する静的な欠陥なので即座に落とす。
// 末尾までまとめて判定すると --list（HTTP を出さない口）が exit 0 で素通しにしてしまう。
if (selfUrlMismatches.length > 0) {
  for (const m of selfUrlMismatches) {
    console.log(`  ✗ ずれ  [自己URL] app/${m.file} が ${m.declared} を宣言(このファイルのルートは ${m.expected})＝canonical/og:url の誤申告`)
  }
  console.log(`[check-links] ✗ 致命: canonical/og:url の自己参照ずれ ${selfUrlMismatches.length}件（別ルートでも 200 が返るため HTTP 検査では検知できない・SEO の正規URL誤申告と共有カードの取り違えになる）。`)
  process.exit(1)
}

// --- アイコンだけのリンク/ボタンにアクセシブル名があるか(Day104) ---
// リンクの「到達できるか」は HTTP で見ているが、「そのリンクを名前で識別できるか」は
// 200 が返る限り死活監視では永久に検知できない。実測で /stamps/ の戻るリンク(そのページ
// 唯一の内部リンク)が名前を持たず、スクリーンリーダーでは行き止まりになっていた。
// 自己URLずれと同じ「ネットワークを見ずに確定する静的欠陥」なのでここで落とす。
// LINKS_APP_DIR は selftest がフィクスチャを見せるための非破壊 override(LINKS_SELFURL_DIR と同作法)。
const APP_DIR = process.env.LINKS_APP_DIR ? path.resolve(process.env.LINKS_APP_DIR) : SRC_APP
// 走査は app/ だけでなく components/ も見る(Day113)。実測では画面の実体は components/ 側に多く
// (featured-apps / footer / links-section 等)、**アイコンだけのリンク/ボタンが最も生えやすいのは
// そちら**なのに、Day104 の母集団は app/ だけだった＝コンポーネントに退行が入っても永久に緑。
// 現時点の指摘は0件だが「今たまたま違反が無い」と「見ている」は別（母集団の穴を先に塞ぐ）。
const COMPONENTS_DIR = process.env.LINKS_COMPONENTS_DIR
  ? path.resolve(process.env.LINKS_COMPONENTS_DIR)
  : path.join(ROOT, 'components')
// ルート単位のガード(noindex スタブ)は app/ の実ルートだけが対象なので、母集団は分けて持つ。
// a11y と同じ配列を使い回すと、components/ を足した瞬間に「ルートでないもの」をルート扱いする。
const appTsxEntries = collectPageFiles(APP_DIR)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => ({ file: f, src: fs.readFileSync(path.join(APP_DIR, f), 'utf8') }))
const a11yRoots = [{ label: 'app', dir: APP_DIR }]
if (fs.existsSync(COMPONENTS_DIR)) a11yRoots.push({ label: 'components', dir: COMPONENTS_DIR })
const a11yOffenders = []
let a11yScanned = 0
const a11yScannedByRoot = {}
for (const root of a11yRoots) {
  a11yScannedByRoot[root.label] = 0
  for (const f of collectPageFiles(root.dir).filter((f) => f.endsWith('.tsx'))) {
    const src = fs.readFileSync(path.join(root.dir, f), 'utf8')
    const { offenders, scanned } = findIconOnlyControlsWithoutName(src)
    a11yScanned += scanned
    a11yScannedByRoot[root.label] += scanned
    for (const o of offenders) a11yOffenders.push({ file: `${root.label}/${f}`, ...o })
  }
}
// 母集団0件の floor(Day91 と同型)。JSX の記法・整形が変わってタグ走査が黙って0件になると
// 「指摘0件＝問題なし」と出続け、このガードだけが無言で消える。
if (a11yScanned === 0) {
  console.log(`  ✗ 抽出失敗 [a11y] ${a11yRoots.map((r) => r.label + '/').join(' と ')}から子を持つ Link/a/button を1件も走査できない`)
  console.log('[check-links] ✗ 致命: a11y 走査の母集団が0件（JSX 記法の変更でガードが無言化した可能性）。scripts/lib/extract-targets.mjs の findIconOnlyControlsWithoutName を確認すること。')
  process.exit(1)
}
if (a11yOffenders.length > 0) {
  for (const o of a11yOffenders) {
    console.log(`  ✗ 名前なし  [a11y] ${o.file}: ${o.snippet} … 可視テキストも aria-label も無い(スクリーンリーダーで識別不能)`)
  }
  console.log(`[check-links] ✗ 致命: アクセシブル名の無いアイコンのみのリンク/ボタン ${a11yOffenders.length}件（HTTP は 200 を返すため死活監視では検知できない・WCAG 2.4.4/4.1.2）。`)
  process.exit(1)
}

// --- リダイレクトスタブが noindex を宣言しているか(Day104) ---
// 中身を持たず即リダイレクトするだけのルート(/workspaces/ = SW 汚染端末の救済)は、metadata を
// 宣言しないとレイアウト既定＝トップと完全同一の title/description/OG を名乗る。robots.txt は
// Allow: / でクローラは到達でき、JS を実行しない相手にはリダイレクトも起きない＝「トップと同じ
// 名前の空ページ」が重複コンテンツとして索引されうる。sitemap 非掲載は索引されない保証ではない。
{
  const byDir = new Map()
  for (const e of appTsxEntries) {
    const parts = e.file.split('/')
    parts.pop()
    const dir = parts.join('/')
    if (!byDir.has(dir)) byDir.set(dir, [])
    byDir.get(dir).push({ rel: e.file, src: e.src })
  }
  const routeDirs = [...byDir.entries()].map(([dir, files]) => ({ route: `/${dir ? `${dir}/` : ''}`, files }))
  const stubs = findRedirectStubsWithoutNoindex(routeDirs)
  if (stubs.length > 0) {
    for (const s of stubs) {
      console.log(`  ✗ noindex なし  [索引] ${s.route}: 即リダイレクトのスタブなのに robots.index:false が無い(${s.files.join(', ')})`)
    }
    console.log(`[check-links] ✗ 致命: 索引制御の無いリダイレクトスタブ ${stubs.length}件（トップと同一メタの空ページが重複コンテンツとして索引されうる）。`)
    process.exit(1)
  }

  // 同じ欠陥はリダイレクトの有無と無関係に起きる(Day104 起票の横断・Day119 実装)。
  // 自前の title/description を持たないルートは、レイアウト既定＝トップと同一のメタを
  // 名乗る。`"use client"` のページは metadata を書けないので、同階層に layout.tsx を
  // 足さない限り必ずこうなる（実測: /noxa/ は noxa/layout.tsx で健全、/ は対象外）。
  const defaulted = findRoutesNamingLayoutDefault(routeDirs)
  if (defaulted.length > 0) {
    for (const d of defaulted) {
      console.log(`  ✗ 既定メタ  [索引] ${d.route}: 自前の title/description が無くレイアウト既定(＝トップと同一)を名乗る(${d.files.join(', ')})`)
    }
    console.log(`[check-links] ✗ 致命: レイアウト既定メタをそのまま名乗るルート ${defaulted.length}件（"use client" のページは同階層に layout.tsx を置くか noindex を宣言すること）。`)
    process.exit(1)
  }
  // floor: ルートの母集団が空なら、この2つのガードは何も見ていない。
  // 実測(Day119): 現在の規約では **同じ入力に対し下の OG ルート抽出の floor が先に落とす**
  // （app/ が空なら OG ファイルも0件になるため）。それでも残すのは、前段がゆるめられたときに
  // **索引ガードだけが無言で空になる**のを防ぐため——Day113 の配信 sitemap floor と同じ扱いで、
  // 「今は到達しない」と「置かなくてよい」は別（前段の厳しさに黙って依存しない）。
  if (routeDirs.filter((d) => d.files.some((f) => /(?:^|\/)page\./.test(f.rel))).length === 0) {
    console.log('[check-links] ✗ 致命: 索引ガードのルート母集団が0件（app/ の走査が壊れてガードが無言化した可能性）。')
    process.exit(1)
  }
}



// --- SW ブートストラップがオリジン全体を巻き込んでいないか(Day107) ---
// 実測: app/layout.tsx の SW ブートストラップが getRegistrations()/caches.keys() の結果を
// 絞らず全件解除・全件削除していた。両 API は**スコープ無関係にオリジン全体**を返すため、
// 同居する子アプリ(/egtype/sw.js は egtype が実際に register 済み・/pekarin-chinchiro/・
// /word-wolf/・/kingscup/ も本番 200)の SW とプリキャッシュが、ポータルを開くたびに全部消えていた。
// 相互リンクなので通常動線でそのまま踏む。HTTP 検査では全ルートが 200 なので永久に無検知。
// LINKS_SW_DIR は selftest 用の非破壊 override(上と同じ理由で LINKS_APP_DIR とは別の口)。
//
// Day110 の拡張: 母集団に **SW 本体 `public/sw.js` を加える**。Day107 は「ブートストラップ」
// (app/layout.tsx のインライン script)だけを走査対象にしていたが、オリジン全体を巻き込む
// 後片付けは SW 本体の activate にも同じ形で居座っており、`app/**/*.tsx` を見るこのガードの
// 母集団に**そもそも入っていなかった**。ブートストラップは端末の救済用の一時コードで、
// 恒久的に毎デプロイ走るのは SW 本体のほう＝守る優先度はむしろ本体が上。
// LINKS_SW_FILE は selftest 用の非破壊 override。
//
// **母集団 floor は2つに分けて数える**。両者を1つの合計にすると、SW 本体が居るせいで
// 合計が0にならず「ブートストラップが消えた(＝/sw.js が二度と登録されない)」が隠れる。
// 守っている対象が別なら floor も別に置く。
{
  const SW_DIR = process.env.LINKS_SW_DIR ? path.resolve(process.env.LINKS_SW_DIR) : SRC_APP
  const SW_FILE = process.env.LINKS_SW_FILE ? path.resolve(process.env.LINKS_SW_FILE) : path.join(ROOT, 'public/sw.js')
  const bootEntries = collectPageFiles(SW_DIR)
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => ({ file: `${path.relative(ROOT, SW_DIR)}/${f}`, src: fs.readFileSync(path.join(SW_DIR, f), 'utf8') }))
  const boot = findOriginWideSwWipes(bootEntries)
  // ②SW 本体側(Day110)。存在そのものの floor は下の実走ガードが持つので、ここは走査のみ。
  const body = fs.existsSync(SW_FILE)
    ? findOriginWideSwWipes([{ file: path.relative(ROOT, SW_FILE), src: fs.readFileSync(SW_FILE, 'utf8') }])
    : { offenders: [] }
  const swOffenders = [...boot.offenders, ...body.offenders]
  // ①ブートストラップ側の母集団0件の floor(Day91 と同型)。SW を触るソースが app/ に1件も
  // 無い＝登録が消えた(＝/sw.js が二度と登録されない)か、記法が変わって走査が空振りしたか
  // のどちらかで、どちらも「✓ 問題なし」と出続けてよい状態ではない。
  if (boot.scanned === 0) {
    console.log('  ✗ 抽出失敗 [SW] app/ に SW 登録/キャッシュを触るソースが1件も無い')
    console.log('[check-links] ✗ 致命: SW ブートストラップの母集団が0件（記法変更でガードが無言化した、または登録自体が消えた可能性）。scripts/lib/extract-targets.mjs の findOriginWideSwWipes を確認すること。')
    process.exit(1)
  }
  if (swOffenders.length > 0) {
    for (const o of swOffenders) console.log(`  ✗ 巻き添え  [SW/${o.kind}] ${o.file}: ${o.why}`)
    console.log(`[check-links] ✗ 致命: SW がオリジン全体を巻き込んでいる ${swOffenders.length}件（同居する子アプリのオフライン能力を毎回破壊する）。`)
    process.exit(1)
  }
}

// --- SW の activate を実走させて削除対象を実測する(Day110) ---
// 上の静的検査は「書き方」を見る。だが Day110 に見つかった実害は
// `keys.filter((key) => key !== CACHE_NAME)` ＝**filter はあるのに他人のものを全部消す**形で、
// 「絞っているか」を見る規則の上では白だった。SW は素の JS なので実際に走らせられる。
// 偽 caches / 偽 self の上で activate を1回走らせ、**結果として何が消えたか**を直接見る。
// 判定に使う「自分のキャッシュ名」もソースを読まずに実測する(fetch を1本流して caches.open()
// に渡される名前を拾う)ので、定数名や記法が変わっても追随する。
{
  const SW_FILE = process.env.LINKS_SW_FILE ? path.resolve(process.env.LINKS_SW_FILE) : path.join(ROOT, 'public/sw.js')
  if (!fs.existsSync(SW_FILE)) {
    console.log(`  ✗ 欠落  [SW実走] ${path.relative(ROOT, SW_FILE)} が無い`)
    console.log('[check-links] ✗ 致命: SW 本体が見つからない（配信されている /sw.js の実体が消えた、または置き場が変わった）。')
    process.exit(1)
  }
  // 同居する子アプリのキャッシュ名。版番号は判定に無関係(接頭辞が別であることだけが本質)
  // なので固定値にして、子アプリ側の版上げでこの検査が腐らないようにする。
  const FOREIGN_KEYS = ['egtype-', 'pekarin-chinchiro-', 'word-wolf-', 'kingscup-'].map((p) => `${p}vX`)
  const sim = await simulateSwActivate(fs.readFileSync(SW_FILE, 'utf8'), { origin: selfOrigin, foreignKeys: FOREIGN_KEYS })
  const swFatal = []
  // 母集団/前提の floor。どれも「検査が空振りしているのに緑」を作る経路。
  if (!sim.hasActivate) swFatal.push('activate ハンドラが無い（後片付けの検査が母集団ごと空振りする）')
  if (!sim.hasFetch) swFatal.push('fetch ハンドラが無い（自分のキャッシュ名を実測できず所有判定が不能）')
  if (!sim.cacheName) swFatal.push('自オリジンの GET で caches.open() が呼ばれない（保存先＝所有キャッシュを特定できない）')
  else if (!sim.ownPrefix) swFatal.push(`キャッシュ名 "${sim.cacheName}" に接頭辞の区切りが無い（名前だけでは自分のものと他アプリのものを区別できない＝安全な後片付けが原理的に書けない）`)
  else if (FOREIGN_KEYS.some((k) => k.startsWith(sim.ownPrefix))) swFatal.push(`接頭辞 "${sim.ownPrefix}" が子アプリのキャッシュ名にも一致する（所有判定が退化している）`)
  // 本体: 他アプリのキャッシュを1件でも消したら致命。
  if (sim.foreignDeleted.length > 0) {
    swFatal.push(`activate が同居アプリのキャッシュを削除した: ${sim.foreignDeleted.join(', ')}（Cache Storage はオリジン共有。デプロイのたびに子アプリのオフライン能力を落とす）`)
  }
  // 下限: 自分の旧版は消せていること。何も消さない no-op へ退化しても「他人を消していない」
  // だけは満たされてしまうため、これが無いとガードは空洞になる。
  if (sim.ownPrefix && !sim.deleted.includes(sim.ownStaleKey)) {
    swFatal.push(`activate が自分の旧版キャッシュ ${sim.ownStaleKey} を消さない（後片付けが no-op へ退化し、旧版が永久に残る）`)
  }
  if (swFatal.length > 0) {
    for (const w of swFatal) console.log(`  ✗ 実走  [SW実走] ${path.relative(ROOT, SW_FILE)}: ${w}`)
    console.log(`[check-links] ✗ 致命: SW の activate を実走させた結果が不正 ${swFatal.length}件（全ルートが 200 を返すため HTTP 検査では永久に検知できない）。`)
    process.exit(1)
  }
}

const STRICT = process.argv.includes('--strict')
// hard/soft は **どの配列から来たか** ではなく **URL がどこから配信されるか** で決める(Day101)。
// 従来はカテゴリごとの手書きリテラルで、同じ egtype デプロイ依存でありながら
// キャラ画像32件と /egtype/ が hard・型ページ32件だけが soft という正反対の致命度になっていた。
// 判定規則と背景は scripts/lib/extract-targets.mjs の classifyTargetUrl を参照。
// LINKS_CROSS_REPO_PREFIXES は selftest が「接頭辞を広げすぎたら floor が落とす」ことを
// 正本を改竄せずに実証するための非破壊 override(Day94 の UPTIME_APP_DIR と同じ作法)。
const crossPrefixes = process.env.LINKS_CROSS_REPO_PREFIXES
  ? process.env.LINKS_CROSS_REPO_PREFIXES.split(',').map((s) => s.trim()).filter(Boolean)
  : CROSS_REPO_PREFIXES
const classify = (url) => classifyTargetUrl(url, BASE, crossPrefixes)

// --- クロール入口(robots.txt と申告された sitemap)を監視対象へ(Day110) ---
// 実測: Day109 時点の監視90件に **robots.txt も sitemap.xml も1件も入っていない**。Day107 で
// sitemap.xml の中身(実ルートの網羅)は固定したのに、その sitemap を配信できているか・
// クローラへ申告できているかは誰も見ていなかった＝**中身を守った入口が丸ごと無監視**。
// 申告先は robots.txt に書いてある文字列がそのまま真実なので、ハードコードせず宣言から導く
// (sitemap を増やしても申告さえすれば自動的に監視へ載る／申告だけ増やして実体が無ければ
// 下の静的突合が落とす、の両側になる)。
// LINKS_ROBOTS / LINKS_PUBLIC_DIR は selftest 用の非破壊 override(他ガードと別の口)。
const ROBOTS_PATH = process.env.LINKS_ROBOTS ? path.resolve(process.env.LINKS_ROBOTS) : path.join(ROOT, 'public/robots.txt')
const ROBOTS_PUBLIC_DIR = process.env.LINKS_PUBLIC_DIR ? path.resolve(process.env.LINKS_PUBLIC_DIR) : path.join(ROOT, 'public')
const robotsTxt = fs.readFileSync(ROBOTS_PATH, 'utf8')
// public/ 配下に実在する sitemap(再帰)。名前規約はファイル名に sitemap を含む .xml。
const publicSitemapPaths = (function collectSitemaps(dir, prefix = '') {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...collectSitemaps(path.join(dir, e.name), `${prefix}/${e.name}`))
    else if (/sitemap.*\.xml$/i.test(e.name)) out.push(`${prefix}/${e.name}`)
  }
  return out
})(ROBOTS_PUBLIC_DIR)
const { issues: robotsIssues, declared: declaredSitemaps } = findRobotsSitemapIssues(robotsTxt, {
  origin: selfOrigin,
  publicSitemapPaths,
  crossRepoPrefixes: crossPrefixes,
})
// 自オリジンの宣言だけを監視へ載せる(別オリジンの宣言は下の静的突合が不整合として落とす)。
const crawlEntryPaths = ['/robots.txt', ...declaredSitemaps
  .map((u) => { try { return new URL(u) } catch { return null } })
  .filter((p) => p && p.origin === selfOrigin)
  .map((p) => p.pathname)]

const rawTargets = [
  ...crawlEntryPaths.map((p) => ({ url: BASE + p, cat: 'クロール入口' })),
  ...internal.map((p) => ({ url: BASE + p, cat: '内部' })),
  ...charImages.map((p) => ({ url: BASE + p, cat: 'キャラ画像' })),
  ...charPages.map((p) => ({ url: BASE + p, cat: 'キャラ型頁' })),
  ...externals.map((u) => ({ url: u, cat: '外部' })),
  // 自オリジンの素の origin 表記をルート表記へ揃えてから分類する(PM Day101)。揃えないと
  // `https://egshugy.com` と `https://egshugy.com/` が別ターゲットとして残り、同じページを
  // 2回叩いたまま「86件」と称する＝件数の水増しになる(下の重複排除は文字列一致のため素通り)。
].map((t) => {
  const url = canonicalizeTargetUrl(t.url, BASE)
  return { ...t, url, ...classify(url) }
})
// 同一URLの重複排除(PM Day97)。metadata の canonical/og:url は自サイトの絶対URLなので
// 「外部」抽出にも載り、内部ターゲットと同じURLを2回叩いていた(実測 /noxa/)。情報量は
// 増えないのに件数だけが膨らみ、監視の網が実態より広いように読めてしまう。
// soft/owner は URL の純関数になったので、同一URLなら由来が違っても判定は必ず一致する
// (＝旧実装にあった「hard を残す」競合解決はもう起こりえない)。先着を残す。
const byUrl = new Map()
for (const t of rawTargets) if (!byUrl.has(t.url)) byUrl.set(t.url, t)
const targets = [...byUrl.values()]
const dupCount = rawTargets.length - targets.length
// 集計は owner ごとに数える(PM Day101)。朝の実装は `!soft` をまとめて「portal自前」と称して
// おり、**外部リンク9件が portal 自前に混ざっていた**(実測 googletagmanager / yorulog.vercel.app
// 等が「portal自前 hard 21」に算入)。hard であることと portal 自前であることは別の話で、
// 朝が封鎖したはずの「集計の嘘」と同型の誤りが新しいサマリにそのまま残っていた。
const softTargets = targets.filter((t) => t.owner === 'egtype')
const portalTargets = targets.filter((t) => t.owner === 'portal')
const externalTargets = targets.filter((t) => t.owner === 'external')

// floor(Day91/94/96/97 と同じ作法・PM Day101 で双方向化): 分類を URL 由来の述語に委ねた分、
// **接頭辞の宣言を書き換えるだけで致命度を好きに動かせる**＝この修正自身を無言で無効化できる
// 経路が生まれる。そこで宣言(CROSS_REPO_PREFIXES / LINKS_CROSS_REPO_PREFIXES)ではなく
// **監視ターゲットの出自**を基準線にして、分類が実態と一致していることを両方向で押さえる。
// 基準線 = ロスター(charImages / charPages)から導いた cross-repo 領域の根(実データでは /egtype/)。
// 宣言をどう弄っても動かないので、**正本定数の書き換えでも env override でも同じここで落ちる**。
//
// 【なぜ両方向か】どちらへ倒れても嘘になるため。hard/soft は監視の強弱ではなく
// **責任の所在**の分類で、soft は「portal 自身では直せない失敗で cron を常時 red にしない」逃がし弁。
//   ・soft なのに領域外  … 格下げ(false-green)。portal 自前のリンク切れが警告のみ・exit 0 になる。
//     朝は「app/ の実ルートは必ず hard」で押さえたが母集団が実ルート4件しかなく、実ルートでない
//     内部リンク(/word-wolf/ /kingscup/ 等の子アプリ＝リポの CLAUDE.md がリンクパス変更禁止と
//     明示する監視の要)を飲み込む形は素通りしていた(実測 exit 0・owner 列まで egtype を騙る)。
//   ・領域内なのに hard … 逃がし弁の消失。Day101 朝が塞いだ実害がそのまま再発する(実測
//     `LINKS_CROSS_REPO_PREFIXES=/egtype/zzz/` で soft 65→0・**exit 0 のまま**サマリが
//     「portal自前 76」と称する＝朝が封鎖した「集計の嘘」まで一緒に戻る)。厳格化は一見無害だが、
//     33体目を足した瞬間に egtype 未デプロイで portal の cron が red になる。
//     一時的に全部を致命として見たい用途には --strict がある(分類は保ったまま失敗の重さだけ
//     変える口＝**分類の改竄と検査の厳しさは別の軸**)。
const crossRepoRoot = crossRepoRootFromRoster([...charImages, ...charPages])
// 根が '/' に潰れる floor: 全ターゲットが「領域内」に化け、両方向の突合が同時に空振りする。
if (crossRepoRoot === '/') {
  console.log('  ✗ 抽出失敗 [cross-repo 領域] ロスターから共通の配信領域を導けない（根が "/" に潰れた）')
  console.log('[check-links] ✗ 致命: cross-repo 領域の根が "/"（ロスターのパス規約が変わり、hard/soft の突合が母集団ごと空振りする）。scripts/lib/extract-targets.mjs の crossRepoRootFromRoster を確認すること。')
  process.exit(1)
}
const inCrossRepoArea = (t) => t.url.startsWith(`${BASE}/`) && t.url.slice(BASE.length).startsWith(crossRepoRoot)
const misclassified = [
  ...targets.filter((t) => t.soft && !inCrossRepoArea(t))
    .map((t) => ({ t, why: `${crossRepoRoot} の外(portal 自前)なのに soft へ格下げされている` })),
  ...targets.filter((t) => !t.soft && inCrossRepoArea(t))
    .map((t) => ({ t, why: `${crossRepoRoot} 配下(egtype 配信)なのに hard 扱いで、逃がし弁が消えている` })),
]
if (misclassified.length > 0) {
  for (const { t, why } of misclassified) console.log(`  ✗ 分類異常 [${t.cat}] ${t.url} は ${why}`)
  console.log(`[check-links] ✗ 致命: 配信主体の分類が実態（${crossRepoRoot} ＝ロスター由来の配信領域）と ${misclassified.length}件ずれている。scripts/lib/extract-targets.mjs の CROSS_REPO_PREFIXES と環境変数 LINKS_CROSS_REPO_PREFIXES を確認すること。`)
  process.exit(1)
}

// 配置(Day107): この段は hard/soft の分類floor **より後**。sitemap の stale 判定は
// crossPrefixes(別リポ配信の領域)を共有するので、分類の宣言が壊れている状態で先に走ると
// 「分類が壊れている」ことを sitemap 側のエラーが覆い隠す（落ちる事実は同じでも原因が読めない）。
// --- sitemap.xml が実ルートを網羅しているか(Day107) ---
// public/sitemap.xml は手書きの静的ファイルで、ページを増やしても誰も更新を強制しない。
// 実測で `/noxa/`(canonical と専用 OG 画像を持つ索引対象の実ルート・本番 200)が丸ごと
// 欠落していた。全ルートが 200 を返すので HTTP 検査には一生映らない＝Day97 の「無リンクの
// 実ルートが無監視」と同じ構図の索引版。missing/stale/contradictory の3方向で突合する
// (片方向だけだと逆向きの嘘＝消したページを載せ続ける・noindex を載せる、が残る)。
// LINKS_SITEMAP_DIR / LINKS_SITEMAP は selftest がフィクスチャを見せるための非破壊 override。
// LINKS_APP_DIR とは**別の口**にする(LINKS_SELFURL_DIR と同じ作法): 各ガードのフィクスチャが
// 他のガードの母集団まで差し替えてしまうと、1つのフィクスチャで無関係なガードが落ちて
// 「どのガードを固定したのか」が曖昧になる。
{
  const SITEMAP_DIR = process.env.LINKS_SITEMAP_DIR ? path.resolve(process.env.LINKS_SITEMAP_DIR) : path.join(ROOT, 'app')
  const SITEMAP_PATH = process.env.LINKS_SITEMAP ? path.resolve(process.env.LINKS_SITEMAP) : path.join(ROOT, 'public/sitemap.xml')
  const sitemapXml = fs.readFileSync(SITEMAP_PATH, 'utf8')
  const sitemapFiles = collectPageFiles(SITEMAP_DIR)
  // ルートごとに、そのルートの page/layout を連結したソースを渡す(noindex 宣言はここに出る)。
  const srcByRoute = new Map()
  for (const f of sitemapFiles.filter((f) => f.endsWith('.tsx'))) {
    const parts = f.split('/')
    parts.pop()
    const route = `/${parts.length ? `${parts.join('/')}/` : ''}`
    srcByRoute.set(route, (srcByRoute.get(route) ?? '') + fs.readFileSync(path.join(SITEMAP_DIR, f), 'utf8'))
  }
  const { routes: sitemapRoutes } = routesFromPageFiles(sitemapFiles)
  const routeEntries = sitemapRoutes.map((route) => ({ route, src: srcByRoute.get(route) ?? '' }))
  // 母集団0件の floor(Day91 と同型)。実ルートが0件、または loc が1件も読めない場合、
  // 突合は必ず「差分なし」になり「✓ 網羅」と出たままガードが無言で消える。
  if (routeEntries.length === 0) {
    console.log('  ✗ 抽出失敗 [sitemap] app/ から実ルートを1件も導けない')
    console.log('[check-links] ✗ 致命: sitemap 突合の母集団が0件（ルート規約の変更でガードが無言化した可能性）。')
    process.exit(1)
  }
  const { missing, stale, contradictory, locCount } = findSitemapCoverageGaps(routeEntries, sitemapXml, selfOrigin, crossPrefixes)
  if (locCount === 0) {
    console.log(`  ✗ 抽出失敗 [sitemap] ${path.relative(ROOT, SITEMAP_PATH)} から <loc> を1件も抽出できない`)
    console.log('[check-links] ✗ 致命: sitemap の <loc> が0件（書式変更でガードが無言化した可能性）。')
    process.exit(1)
  }
  const sitemapOffenders = [
    ...missing.map((r) => ({ r, why: '索引対象の実ルートなのに sitemap に載っていない(検索エンジンへ申告されない)' })),
    ...stale.map((r) => ({ r, why: 'sitemap に載っているが app/ に実ルートが無い(消えたURLを索引へ差し出している)' })),
    ...contradictory.map((r) => ({ r, why: 'noindex を宣言しているのに sitemap に載っている(索引するな/しろを同時に渡している)' })),
  ]
  if (sitemapOffenders.length > 0) {
    for (const { r, why } of sitemapOffenders) console.log(`  ✗ 不整合  [sitemap] ${r}: ${why}`)
    console.log(`[check-links] ✗ 致命: sitemap.xml と実ルートの不整合 ${sitemapOffenders.length}件（全ルートが 200 を返すため HTTP 検査では検知できない）。`)
    process.exit(1)
  }
}

// --- robots.txt の Sitemap 宣言 ⇔ 実体(Day110) ---
// 配置: sitemap 段の直後。sitemap の**中身**を固定した後に、その sitemap への**入口**を固定する
// (入口が死んでいれば中身の網羅性には意味が無く、逆に入口だけ増やしても実体が無ければ
// 死んだ URL をクローラへ差し出し続ける)。突合は sitemap 段と同じく双方向。
{
  // floor その1: 宣言が1行も読めない。robots.txt から Sitemap を削った/書式を変えた場合、
  // 突合は必ず「不整合0件」になり、このガードも上の監視対象化(crawlEntryPaths)も同時に
  // 無言で消える(監視件数だけが静かに減る＝Day108 の「正常な空と壊れた空」)。
  if (declaredSitemaps.length === 0) {
    console.log(`  ✗ 抽出失敗 [robots] ${path.relative(ROOT, ROBOTS_PATH)} から Sitemap 宣言を1件も抽出できない`)
    console.log('[check-links] ✗ 致命: robots.txt の Sitemap 宣言が0件（クローラへの申告が消えたか、書式変更でガードが無言化した可能性）。')
    process.exit(1)
  }
  // floor その2: public/ から sitemap を1件も導けない。走査が壊れると「未宣言0件」＝
  // 申告漏れが無い状態と区別がつかなくなり、逆方向の突合だけが空振りする。
  if (publicSitemapPaths.length === 0) {
    console.log(`  ✗ 抽出失敗 [robots] ${path.relative(ROOT, ROBOTS_PUBLIC_DIR)} に sitemap の実体が1件も無い`)
    console.log('[check-links] ✗ 致命: public/ の sitemap 実体が0件（配信物が消えたか、走査の失敗が「申告漏れ無し」と同じ結末へ潰れている）。')
    process.exit(1)
  }
  if (robotsIssues.length > 0) {
    for (const i of robotsIssues) console.log(`  ✗ ${i.kind}  [robots] ${i.url}: ${i.why}`)
    console.log(`[check-links] ✗ 致命: robots.txt の Sitemap 宣言と実体の不整合 ${robotsIssues.length}件（宣言も実体も 200 を返しうるため HTTP 検査では検知できない）。`)
    process.exit(1)
  }
}

console.log(`[check-links] base=${BASE} 内部${internal.length}(featured-apps=${featuredLive ? 'live' : 'dead:除外'} / 実ルート${appRoutes.length}・うち無リンク${unlinkedRoutes.length}) + キャラ画像${charImages.length} + キャラ型頁${charPages.length} + 外部${externals.length} = ${targets.length}件（hard: portal自前${portalTargets.length} + 外部${externalTargets.length} / soft: egtype配信${softTargets.length}）${dupCount ? `(重複${dupCount}件を排除)` : ''}${STRICT ? ' [strict]' : ''}`)

// --list: 実リクエストを出さずに監視対象だけを吐いて終わる(Day97)。
// selftest から「何が監視対象になっているか」をネットワーク無しで固定できるようにするための口。
// 抽出層(lib)の純関数テストだけでは、抽出できていても本体で targets に合流し損ねていれば
// 監視は増えないまま通ってしまう＝配線までを固定しないと false-green は塞げない。
// OG 画像の配信ヘッダ検査(Day104)の対象。app/ の OG 規約から導いた「拡張子つき」URL。
// 通常ターゲット(targets)には混ぜない: これらは配信物としては新設で、本番へ反映されるまで
// 404 が正常な状態が続く。hard に載せれば人間ゲートのデプロイ待ちで cron が毎日 red になり、
// soft に落とせば Day101 PM2 の双方向 floor(soft ⇔ egtype 領域)を破る。よって
// **別枠・非致命(デプロイ待ち)／型の異常だけ致命** という独立した段として扱う。
const ogRoutes = ogImageRoutesFromFiles(collectPageFiles(APP_DIR))
if (ogRoutes.length === 0) {
  console.log('  ✗ 抽出失敗 [OG配信] app/ から OG 画像ルートを1件も抽出できない')
  console.log('[check-links] ✗ 致命: OG ルート抽出が0件（Next のファイル規約変更で共有カードの配信検査が無言化した可能性）。')
  process.exit(1)
}

if (process.argv.includes('--list')) {
  // 4列目に配信主体(owner)を出す。hard/soft がどの根拠で決まったかを外から突合できるようにする
  // ためで、既存の列位置(0:hard|soft / 1:cat / 2:url)は変えない。
  for (const t of targets) console.log(`${t.soft ? 'soft' : 'hard'}\t${t.cat}\t${t.url}\t${t.owner}`)
  // OG 配信ヘッダ検査の対象は別枠なのでタブ区切りの列には混ぜず、`# og` 行として出す
  // (既存の列パースを壊さずに配線を外から固定できるようにするため)。
  for (const r of ogRoutes) console.log(`# og ${BASE}${r}`)
  process.exit(0)
}
const results = await Promise.all(targets.map(async (t) => ({ ...t, ...(await check(t.url)) })))

// --- 接続段の失敗の切り分け（Day122・Day119 起票の false-red） ---
// HTTP 応答が1つも返らなかった失敗(status 0)は「リンクが壊れている」ではなく「届かなかった」。
// 届かなかった理由（一過性の瞬断 / 相手が落ちている / こちらの回線）を分けないと、瞬断のたびに
// 「✗ 致命 [外部] …/gtag/js」と**リンクを誤って名指しして**赤くなる（実測で4回中2回）。
// 順序が肝: **先に測り直し**、それでも届かなかった分だけを診断する。逆にすると、無関係な
// 2ホストがたまたま同時に瞬断した回まで「こちらの回線」と名乗ってしまう（一過性は再確認で
// 消えるので、診断の入力からも消えているべき）。
const RECHECK_DELAY_MS = Number(process.env.LINKS_RECHECK_DELAY_MS ?? 3000)
const { recovered, responded, stillDown, diagnosis: connectDiagnosis } = await resolveConnectFailures(results, {
  recheck: check,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  delayMs: RECHECK_DELAY_MS,
})
if (recovered.length > 0) {
  console.log(`[check-links] ⓘ 接続不能だった ${recovered.length}件は ${RECHECK_DELAY_MS}ms 後の再確認で回復（一過性の瞬断＝リンクは生きている）: ${recovered.map((r) => r.url).join(' ')}`)
}
// 再確認で応答が返った分(Day123 PM)。届かなかったのではなく**実際の応答**で判定する
// （404 が返ったなら、それは接続の話ではなく壊れたリンクとして下の箱で名指しされる）。
if (responded.length > 0) {
  console.log(`[check-links] ⓘ 接続不能だった ${responded.length}件は再確認で応答が返った（届かなかった扱いにせず、その応答で判定）: ${responded.map((r) => `${r.url}→${r.status}`).join(' ')}`)
}
if (connectDiagnosis === 'local-network') {
  // リンク切れとは名乗らない。監視は「測れなかった」ことを報告する（緑にもしない）。
  for (const r of stillDown) {
    console.log(`  ✗ 回線  [こちらのネットワーク] ${r.url} へ届かない（${r.err}${r.errCode ? `(${r.errCode})` : ''}）`)
  }
  const hosts = [...new Set(stillDown.map((r) => hostOf(r.url)).filter(Boolean))]
  console.log(`[check-links] ✗ 致命: 再確認しても届かない ${stillDown.length}件（不通ホスト ${hosts.length}件: ${hosts.join(' ')}／成功 ${results.filter((r) => r.ok).length}件）はこちらの回線を疑う形＝**リンクの生死については何も言えていない**（リンク切れとして名指ししない）。`)
}

// --- OG 画像の配信ヘッダ(Day104) ---
// 「200 が返るか」ではなく「**画像として配信されているか**」を見る。実測で拡張子なしの OG は
// 200 だが content-type ヘッダが無く、res.ok しか見ない従来の検査では対象に載せても検知できない。
const ogResults = await Promise.all(ogRoutes.map(async (r) => {
  const res = await fetchWithRetry(`${BASE}${r}`)
  return { route: r, ...res, verdict: classifyOgDelivery(res) }
}))
const ogBadType = ogResults.filter((r) => r.verdict === 'bad-type')
const ogPending = ogResults.filter((r) => r.verdict === 'pending-deploy')
const ogUnreachable = ogResults.filter((r) => r.verdict === 'unreachable')
for (const r of ogBadType) console.log(`  ✗ 型なし  [OG配信] ${r.url} は 200 だが content-type=${r.contentType ?? '(無し)'}＝画像として配信されていない(共有カードで画像が出ない)`)
for (const r of ogUnreachable) console.log(`  ⚠ ${r.status || r.err}  [OG配信] ${r.url}`)
if (ogPending.length > 0) {
  console.log(`[check-links] ⓘ OG配信 ${ogPending.length}/${ogRoutes.length} 件が本番未反映(404) — 拡張子つき OG はビルド物には含まれる(postbuild-og-ext)。本番反映は人間ゲートの npm run deploy 待ち＝想定内。`)
}

// --- 本番で配信されている robots.txt の中身(Day110) ---
// 上の静的突合はリポの public/robots.txt を見るが、実測で**本番はリポと別物**だった:
// `https://egshugy.com/robots.txt` は 1949 バイト（リポは 113 バイト）で、Cloudflare の
// Managed content（Content-Signal と AI クローラ向け Disallow 群）が前置され、リポ由来の行は
// その後ろに残っている。前置される側は portal のリポの外で変わるので、リポをどれだけ厳密に
// 突合しても本番の中身は保証できない。そして 200 は返るので、res.ok しか見ない従来の検査では
// 中身が別物へ差し替わっても永久に映らない（Day104 の OG content-type と同型）。
// ここだけは**取得した本文**を見る。robots.txt はサイト全体のクロール可否を1ファイルで決めるので、
// 全面 Disallow と申告の消失は他のどのリンク切れよりも影響が広い。
const robotsRes = await fetchWithRetry(`${BASE}/robots.txt`, { wantBody: true })
const servedRobots = classifyServedRobots(robotsRes, declaredSitemaps)
if (servedRobots.verdict === 'blocks-all') {
  console.log(`  ✗ 全面拒否  [robots] ${BASE}/robots.txt が User-agent: * に Disallow: / を含む（サイト全体が検索結果から消える）`)
} else if (servedRobots.verdict === 'no-sitemap') {
  console.log(`  ✗ 申告消失  [robots] リポは Sitemap を ${declaredSitemaps.length}件宣言しているのに配信物には1行も無い（デプロイ待ちでは説明できない＝配信側が中身を落としている）`)
} else if (servedRobots.verdict === 'unreachable') {
  console.log(`  ⚠ ${robotsRes.status || robotsRes.err}  [robots] ${BASE}/robots.txt を取得できない`)
} else if (servedRobots.verdict === 'pending-deploy') {
  console.log(`[check-links] ⓘ robots 申告 ${servedRobots.missingOnProd.length}/${declaredSitemaps.length}件が本番未反映 — 人間ゲートの npm run deploy 待ちなら想定内: ${servedRobots.missingOnProd.join(' ')}`)
}
// --- 本番で配信されている sitemap.xml の中身(Day113) ---
// Day107 は sitemap の中身を、Day110 はその入口(robots.txt)を固定したが、どちらも**リポの中身**。
// 実際に配信されている sitemap は誰も見ておらず、「リポの sitemap は正しいが本番は2世代前」は
// 検知できなかった（実測: 本番 /sitemap.xml に `/noxa/` が無い＝Day107 の修正が未反映）。
// 対象は robots.txt が**申告している自オリジンの sitemap**（ハードコードしない＝申告を増やせば
// 自動で検査対象になる。robots 段と同じ導出を使う）。
// 比較の基準はリポの同じパスの sitemap。実体が無い申告は上の静的突合が既に落としているので、
// ここでは「実体があるのに配信が違う」だけを見る。
const servedSitemapChecks = await Promise.all(
  crawlEntryPaths
    .filter((p) => p !== '/robots.txt')
    .map(async (p) => {
      const localPath = path.join(ROBOTS_PUBLIC_DIR, p)
      const repoLocs = fs.existsSync(localPath)
        ? [...fs.readFileSync(localPath, 'utf8').matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1])
        : []
      const res = await fetchWithRetry(`${BASE}${p}`, { wantBody: true })
      return { path: p, repoLocCount: repoLocs.length, ...classifyServedSitemap(res, { repoLocs, origin: selfOrigin }) }
    }),
)
// floor: 申告から導いた検査対象が0件なら、この段は何も検査していない。
// 実測(Day113): 現在の規約ではここへ到達する前に**上の静的 robots 段が先に落ちる**
// （宣言0件は Day110 の floor が、別オリジンだけの宣言は「別オリジン」不整合が致命化する）。
// それでも残すのは、前段が将来ゆるめられたときに**この段だけが無言で空になる**のを防ぐため。
// 「今は到達しない」と「置かなくてよい」は別（前段の厳しさに黙って依存しない）。
if (servedSitemapChecks.length === 0) {
  console.log('  ✗ 抽出失敗 [配信sitemap] robots.txt から自オリジンの sitemap 申告を1件も導けない')
  console.log('[check-links] ✗ 致命: 配信 sitemap 検査の母集団が0件（申告の書式変更でガードが無言化した可能性）。')
  process.exit(1)
}
const servedSitemapBad = servedSitemapChecks.filter((c) => isServedSitemapFatal(c.verdict))
for (const c of servedSitemapBad) {
  const why = {
    unreachable: `robots.txt が申告している入口なのに本番で取得できない(申告だけが生きて中身が死んでいる)`,
    'not-xml': `200 だが HTML が返る(SPA フォールバックが飲み込んでいる＝クローラは sitemap として読めない)`,
    empty: `200 だが <loc> が1件も無い(sitemap の体を成していない)`,
    foreign: `自オリジン外の loc が混ざる: ${c.foreign.slice(0, 3).join(' ')}`,
  }[c.verdict]
  console.log(`  ✗ ${c.verdict}  [配信sitemap] ${BASE}${c.path}: ${why}`)
}
const servedSitemapPending = servedSitemapChecks.filter((c) => c.verdict === 'pending-deploy')
if (servedSitemapPending.length > 0) {
  for (const c of servedSitemapPending) {
    console.log(`[check-links] ⓘ 配信sitemap ${c.path}: リポの ${c.missingOnProd.length}/${c.repoLocCount}件が本番の sitemap に無い — 人間ゲートの npm run deploy 待ちなら想定内: ${c.missingOnProd.slice(0, 5).join(' ')}`)
  }
}
const servedSitemapFatal = servedSitemapBad.length > 0

const robotsFatal = servedRobots.verdict === 'blocks-all' || servedRobots.verdict === 'no-sitemap'

// bot 対策のチャレンジに阻まれた応答(Day116)は「失敗」ではなく**判定不能**として分ける。
// 実測: 外部リンク https://nomishugy.vercel.app/coming-soon はブラウザ UA なら 200 だが
// 監視の UA では 403 + `x-vercel-mitigated: challenge`(Vercel の Attack Challenge)。
// リンクは生きていて実ユーザーには見えるのに、監視だけが恒常的に致命を出し cron が毎日 red
// になっていた。false-red は本物のリンク切れを埋もれさせるので分ける必要がある。
//   - 外部(portal では直せない相手側の設定)  … 警告のみ。Day101 の soft と同じ思想
//   - 自前(portal 配信)                      … **致命**。自分のサイトの死活が測れない状態を
//     緑にしたら死活監視の意味が消えるし、設定は自分で直せる
// 「403 を許す」形にはしない(本物の権限エラー・公開停止を見逃す)。チャレンジであることを
// 名乗るヘッダがある応答だけを、この経路へ落とす(判定は isBotChallenge)。
const { hardBad, softBad, challengedExternal, challengedSoft, unreachableExternal, localNetwork, unclassified, externalBlind, softBlind } = partitionLinkResults(results, { externalCount: externalTargets.length, softCount: softTargets.length })

// 失敗の見出しは「ステータス、無ければ例外名(原因コード)」。素の TypeError だけでは
// 相手が落ちているのか DNS なのか自分の回線なのかが分からない(Day116)。
const label = (r) => `${r.status || `${r.err}${r.errCode ? `(${r.errCode})` : ''}`}`
for (const r of hardBad) console.log(`  ✗ ${label(r)}  [${r.cat}] ${r.url}${r.challenged ? '（bot対策のチャレンジ＝自前の死活が測れない）' : ''}`)
for (const r of softBad) console.log(`  ⚠ ${label(r)}  [${r.cat}] ${r.url}`)
for (const r of challengedExternal) console.log(`  ⚠ bot対策  [${r.cat}] ${r.url} は ${r.status} + チャレンジ応答＝到達性が判定不能(実ユーザーのブラウザでは開けている可能性が高い)`)
if (challengedExternal.length > 0) {
  console.log(`[check-links] ⚠ 外部 ${challengedExternal.length}/${externalTargets.length} 件が bot 対策で判定不能 — 相手側の設定なので portal では直せない＝致命にしない(生死の確認は人手で)。`)
}
// 外部へ再確認しても届かなかった分(Day122)。チャレンジと同じ「到達性が判定不能」で、
// portal では直せない(相手の一時障害かこちらの egress)。致命にはしないが必ず数に出す。
for (const r of unreachableExternal) console.log(`  ⚠ 到達不能  [${r.cat}] ${r.url} は再確認しても届かない（${r.err}${r.errCode ? `(${r.errCode})` : ''}）＝リンクが壊れている証拠にはならない(portal では直せない)`)
if (unreachableExternal.length > 0) {
  console.log(`[check-links] ⚠ 外部 ${unreachableExternal.length}/${externalTargets.length} 件へ再確認しても届かない — 相手の一時障害かこちらの egress。**名前解決の失敗(ENOTFOUND)は従来どおり致命**なので、死んだドメインの検知力は落ちていない。`)
}
// floor: 外部の全件が判定不能(チャレンジ or 到達不能)なら、この段は**何も検査していない**のと同じ。
// 「判定不能を警告に落とす」逃がし弁が広がりすぎて検知が空洞化した状態を緑にしない。
if (externalBlind) {
  console.log(`  ✗ 全件判定不能  [外部] 外部リンク ${externalTargets.length}件すべてが測れない（bot対策 ${challengedExternal.length}件 / 到達不能 ${unreachableExternal.length}件＝監視が外部について何も言えていない）`)
}

// egtype 配信(soft)が bot 対策で判定不能な分(Day119)。Day116 は3つの箱を
// 「外部×判定不能 / 自前(非soft) / soft×判定可」で書いたため **soft × 判定不能** がどこにも
// 入らず、✗ にも ⚠ にも出ないまま softBad にも数えられず `✓ 全N件 OK` と名乗っていた
// （失敗が存在するのに全件 OK＝Day101/116 で二度塞いだ集計の嘘の3度目）。
// 扱いは外部と同じ「このリポでは直せない＝警告」だが、**数には必ず現れる**ようにする。
for (const r of challengedSoft) console.log(`  ⚠ bot対策  [${r.cat}] ${r.url} は ${r.status} + チャレンジ応答＝到達性が判定不能(egtype 配信側の設定なので portal では直せない)`)
if (challengedSoft.length > 0) {
  console.log(`[check-links] ⚠ egtype配信 ${challengedSoft.length}/${softTargets.length} 件が bot 対策で判定不能 — soft と同じく致命にはしないが「未到達」とも「OK」とも数えない。`)
}
// floor: soft の全件が判定不能なら egtype 配信について何も言えていない（外部の floor と同じ思想）
if (softBlind) {
  console.log(`  ✗ 全件判定不能  [egtype配信] soft ${softTargets.length}件すべてが bot 対策で測れない（監視が egtype 配信について何も言えていない）`)
}
// floor(網羅): どの箱にも入らなかった失敗が居たら、それは**分類規則の穴**そのもの。
// 黙って捨てると今回と同じ「失敗があるのに全件 OK」に戻るので、必ず赤で出す。
for (const r of unclassified) console.log(`  ✗ 分類不能  [${r.cat}] ${r.url}（owner=${r.owner} soft=${r.soft} challenged=${Boolean(r.challenged)} — 振り分け規則がこの組合せを持っていない）`)
if (unclassified.length > 0) {
  console.log(`[check-links] ✗ 致命: 失敗 ${unclassified.length}件がどの箱にも入らなかった（partitionLinkResults の分類が網羅していない）。`)
}

if (softBad.length > 0) {
  console.log(`[check-links] ⚠ egtype依存(soft) ${softBad.length}/${softTargets.length} 件が未到達 — egtype 本番デプロイ待ちなら想定内(portal と egtype はセットでデプロイ)。デプロイ後は --strict で厳格確認。`)
}

const fatal = hardBad.length > 0 || localNetwork.length > 0 || localMissing.length > 0 || ogBadType.length > 0 || robotsFatal || servedSitemapFatal || externalBlind || softBlind || unclassified.length > 0 || (STRICT && (softBad.length > 0 || challengedSoft.length > 0))
const robotsLabel = `robots ${servedRobots.verdict === 'ok' ? `申告${servedRobots.servedSitemaps.length}件が本番にも実在` : servedRobots.verdict}`
const ogOkLabel = `OG配信 ${ogResults.filter((r) => r.verdict === 'ok').length}/${ogRoutes.length}件が image/*`
const sitemapLabel = `配信sitemap ${servedSitemapChecks.filter((c) => c.verdict === 'ok').length}/${servedSitemapChecks.length}件が本番でもリポと一致`
// 判定不能を「OK」に数えない(Day116)。チャレンジで測れなかった分がある回に「全件 OK」と
// 名乗ると、監視が見ていないものまで見たことになる＝Day101 の集計の嘘の作り直しになる。
const challengeLabel = challengedExternal.length > 0 ? ` / 外部 ${challengedExternal.length}件は bot対策で判定不能` : ''
const unreachableLabel = unreachableExternal.length > 0 ? ` / 外部 ${unreachableExternal.length}件は再確認しても到達不能` : ''
const softChallengeLabel = challengedSoft.length > 0 ? ` / egtype配信 ${challengedSoft.length}件は bot対策で判定不能` : ''

// サマリの数字は **分岐条件とは別の観測軸**から出す(Day119・egtype Day118 の横断観点)。
// 従来 `portal自前 N/N 件 OK` は分子も分母も `portalTargets.length` で、「何件 OK だったか」を
// 一度も数えず**分岐条件を言い換えていただけ**だった。今日の欠陥（soft×判定不能が
// どの箱にも入らず、失敗があるのに緑）では、まさにこの形が嘘を隠した——箱が空なら
// N/N と名乗るので、**箱から漏れた失敗は数字に一切現れない**。
// `r.ok` は振り分けとは独立した観測なので、分類規則に穴があいた回に分子だけが減る。
// （`ローカル静的 N件実在` / `自己URL宣言 N件整合` は分岐条件そのもの＝独立でないため、
//   測ったふりの `N-0/N` に書き換えず素のまま残す。独立していない数字は floor にならない
//   ＝factory Day117 PM の教訓。）
const okOf = (owner) => results.filter((r) => r.owner === owner && r.ok).length
const failedCount = results.filter((r) => !r.ok).length

if (!fatal && failedCount === 0) {
  console.log(`[check-links] ✓ 全${results.length}件 OK / ローカル静的アセット ${localImageRefs.length}件実在 / 自己URL宣言 ${selfUrlDeclarations}件整合 / ${ogOkLabel} / ${robotsLabel} / ${sitemapLabel}`)
  process.exit(0)
} else if (!fatal) {
  // 「portal自前 N/N」の N は **portal 自身がデプロイする分だけ** を数える(Day101)。
  // 従来は分母に egtype 配信の33件(キャラ画像32 + /egtype/)が混ざっており、hard で通った
  // 件数をそのまま「自前」と称していた＝集計の嘘だった。PM で外部リンクも分けた(hard では
  // あるが portal 自前ではない。混ぜると同じ嘘の作り直しになる)。
  console.log(`[check-links] ✓ portal自前 ${okOf('portal')}/${portalTargets.length} 件 + 外部 ${okOf('external')}/${externalTargets.length}件 OK（egtype配信 soft ${softTargets.length}件中 ${softBad.length}件未到達＝警告のみ）${challengeLabel}${unreachableLabel}${softChallengeLabel} / ローカル静的アセット ${localImageRefs.length}件実在 / 自己URL宣言 ${selfUrlDeclarations}件整合 / ${ogOkLabel} / ${robotsLabel} / ${sitemapLabel}`)
  process.exit(0)
} else {
  console.log(`[check-links] ✗ 致命 ${hardBad.length}件${localNetwork.length ? ` + こちらの回線で測れず ${localNetwork.length}件` : ''}${externalBlind ? ' + 外部が全件判定不能' : ''}${softBlind ? ' + egtype配信が全件判定不能' : ''}${unclassified.length ? ` + 分類不能 ${unclassified.length}件` : ''}${localMissing.length ? ` + ローカル静的欠落 ${localMissing.length}件` : ''}${ogBadType.length ? ` + OG配信の型なし ${ogBadType.length}件` : ''}${robotsFatal ? ` + robots(${servedRobots.verdict})` : ''}${servedSitemapFatal ? ` + 配信sitemap ${servedSitemapBad.length}件` : ''}${STRICT ? ` + soft ${softBad.length}件` : ''}${STRICT && challengedSoft.length ? ` + egtype配信の判定不能 ${challengedSoft.length}件` : ''} / 全${results.length}件`)
  process.exit(1)
}
