// リンク死活チェッカー — 内部リンク / app の実ルート / 主要外部リンク / 32キャラ画像を実リクエストで確認する。
// 内部ターゲットは「リンク由来(href)」と「ルート由来(app/**/page.tsx)」の和集合。後者が無いと
// どこからもリンクされない救済ルート(/workspaces/ 等)が永久に無監視になる(Day97)。
// 使い方:
//   node scripts/check-links.mjs             # 本番 (https://egshugy.com) に対して確認
//   node scripts/check-links.mjs --base http://192.168.0.77   # オリジン直叩き
//   node scripts/check-links.mjs --strict    # egtype依存の型ページ(soft)404も致命扱い
//   node scripts/check-links.mjs --list      # 実リクエストを出さず監視対象一覧だけ出す
// 終了コード: portal自前リンク失敗=1 / soft(egtype型ページ)失敗は既定で警告のみ(0)・--strictで1
//   (egtype と portal はセットでデプロイ。egtype 未デプロイ中の新16体型ページ404は想定内)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchWithRetry } from './fetch-with-retry.mjs'
import { extractExternalUrls, extractCharIds, extractLocalAssetRefs, routesFromPageFiles } from './lib/extract-targets.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const baseIdx = process.argv.indexOf('--base')
const baseArg = baseIdx > -1 ? process.argv[baseIdx + 1] : null
if (baseIdx > -1 && !baseArg) { console.error('--base にはURLを指定してください'); process.exit(2) }
const BASE = (baseArg ?? 'https://egshugy.com').replace(/\/$/, '')

// あるコンポーネントが app/ の実ルートから import され実際にレンダーされているか。
// import されていない = デッドコンポーネント(未レンダー)で、その内部リンクは live サイトの
// どこからも辿れない phantom。
function isImportedByApp(basename) {
  const stack = [path.join(ROOT, 'app')]
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
const featured = fs.readFileSync(path.join(ROOT, 'components/featured-apps.tsx'), 'utf8')
const featuredInternal = featuredLive
  ? [...featured.matchAll(/href: "(\/[a-z0-9-]+\/)", comingSoon: (true|false)/g)]
      .filter((m) => m[2] === 'false')
      .map((m) => m[1])
  : []

// 2) page.tsx の ALL_CHARACTERS から32キャラ画像URL + 図鑑カードのディープリンク先(types)を生成
const page = fs.readFileSync(path.join(ROOT, 'app/page.tsx'), 'utf8')

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
const pageNavInternal = collectAppInternal(path.join(ROOT, 'app'))

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
const { routes: appRoutes, skipped: skippedRoutes } = routesFromPageFiles(collectPageFiles(path.join(ROOT, 'app')))
// 抽出0件の floor(Day91 と同型): app/ に page が1つも無いことは静的ポータルではありえず、
// 0件は「ルート規約の変更でこの層が黙って死んだ」ことを意味する。そのまま進むと
// リンク由来だけの旧挙動へ静かに退化する＝この修正自体が無言で無効化されるため即座に落とす。
if (appRoutes.length === 0) {
  console.log('  ✗ 抽出失敗 [実ルート] app/ から page.* を1件も抽出できない')
  console.log('[check-links] ✗ 致命: 実ルート抽出が0件（Next のルート規約変更で監視が無言化した可能性）。scripts/lib/extract-targets.mjs の routesFromPageFiles を確認すること。')
  process.exit(1)
}
const linkInternal = [...new Set([...featuredInternal, ...experimentInternal, ...pageNavInternal])]
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
  const dir = path.join(ROOT, 'components')
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
const liveSrc = collectTsx(path.join(ROOT, 'app')) + collectLiveComponents()
const externals = extractExternalUrls(liveSrc, { exclude: EXCLUDE })

// 一時失敗(タイムアウト/瞬断/5xx/429)は fetchWithRetry が数回リトライしてから確定する。
// 単発フレークで死活監視が「致命」誤警報を出すのを防ぐ(恒久404はリトライせず即検知)。
async function check(url) {
  const r = await fetchWithRetry(url)
  return { url, status: r.status, ok: r.ok, err: r.err }
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
  const stack = [path.join(ROOT, 'app')]
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

const STRICT = process.argv.includes('--strict')
const targets = [
  ...internal.map((p) => ({ url: BASE + p, cat: '内部', soft: false })),
  ...charImages.map((p) => ({ url: BASE + p, cat: 'キャラ画像', soft: false })),
  ...charPages.map((p) => ({ url: BASE + p, cat: 'キャラ型頁', soft: true })),
  ...externals.map((u) => ({ url: u, cat: '外部', soft: false })),
]

console.log(`[check-links] base=${BASE} 内部${internal.length}(featured-apps=${featuredLive ? 'live' : 'dead:除外'} / 実ルート${appRoutes.length}・うち無リンク${unlinkedRoutes.length}) + キャラ画像${charImages.length} + キャラ型頁${charPages.length}(soft) + 外部${externals.length} = ${targets.length}件${STRICT ? ' [strict]' : ''}`)

// --list: 実リクエストを出さずに監視対象だけを吐いて終わる(Day97)。
// selftest から「何が監視対象になっているか」をネットワーク無しで固定できるようにするための口。
// 抽出層(lib)の純関数テストだけでは、抽出できていても本体で targets に合流し損ねていれば
// 監視は増えないまま通ってしまう＝配線までを固定しないと false-green は塞げない。
if (process.argv.includes('--list')) {
  for (const t of targets) console.log(`${t.soft ? 'soft' : 'hard'}\t${t.cat}\t${t.url}`)
  process.exit(0)
}
const results = await Promise.all(targets.map(async (t) => ({ ...t, ...(await check(t.url)) })))
const hardBad = results.filter((r) => !r.ok && !r.soft)
const softBad = results.filter((r) => !r.ok && r.soft)

for (const r of hardBad) console.log(`  ✗ ${r.status || r.err}  [${r.cat}] ${r.url}`)
for (const r of softBad) console.log(`  ⚠ ${r.status || r.err}  [${r.cat}] ${r.url}`)

if (softBad.length > 0) {
  console.log(`[check-links] ⚠ egtype依存(soft) ${softBad.length}/${charPages.length} 件が未到達 — egtype 本番デプロイ待ちなら想定内(portal と egtype はセットでデプロイ)。デプロイ後は --strict で厳格確認。`)
}

const fatal = hardBad.length > 0 || localMissing.length > 0 || (STRICT && softBad.length > 0)
if (!fatal && hardBad.length === 0 && softBad.length === 0) {
  console.log(`[check-links] ✓ 全${results.length}件 OK / ローカル静的アセット ${localImageRefs.length}件実在`)
  process.exit(0)
} else if (!fatal) {
  console.log(`[check-links] ✓ portal自前 ${results.length - softBad.length}/${results.length - softBad.length} 件 OK（soft ${softBad.length}件は警告のみ）/ ローカル静的アセット ${localImageRefs.length}件実在`)
  process.exit(0)
} else {
  console.log(`[check-links] ✗ 致命 ${hardBad.length}件${localMissing.length ? ` + ローカル静的欠落 ${localMissing.length}件` : ''}${STRICT ? ` + soft ${softBad.length}件` : ''} / 全${results.length}件`)
  process.exit(1)
}
