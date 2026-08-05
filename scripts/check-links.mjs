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
import { extractExternalUrls, extractCharIds, extractLocalAssetRefs, routesFromPageFiles, normalizeRoutePath, findSelfUrlMismatches, extractMetadataBaseOrigin, classifyTargetUrl, canonicalizeTargetUrl, crossRepoRootFromRoster, CROSS_REPO_PREFIXES } from './lib/extract-targets.mjs'

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

// --- canonical / og:url の自己参照ずれ(PM Day97) ---
// 自サイトの絶対URL宣言は死活監視から見ればただの外部リンクで、**別ルートを指していても
// 200 が返るので永久に検知されない**。検索エンジンへの正規URL誤申告・SNS で別ページの
// 共有カードが出る、という実害だけが静かに残る。実ルートを母集団にして突合する。
// origin は app/layout.tsx の metadataBase を単一の出所とする（二重管理を作らない）。
// LINKS_SELFURL_DIR は selftest がフィクスチャを見せるための非破壊 override(Day94 の
// UPTIME_APP_DIR と同じ作法)。正本を一時改竄せずに「ずれ→exit 1」の配線まで固定できる。
const SELFURL_DIR = process.env.LINKS_SELFURL_DIR ? path.resolve(process.env.LINKS_SELFURL_DIR) : path.join(ROOT, 'app')
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
const rawTargets = [
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

console.log(`[check-links] base=${BASE} 内部${internal.length}(featured-apps=${featuredLive ? 'live' : 'dead:除外'} / 実ルート${appRoutes.length}・うち無リンク${unlinkedRoutes.length}) + キャラ画像${charImages.length} + キャラ型頁${charPages.length} + 外部${externals.length} = ${targets.length}件（hard: portal自前${portalTargets.length} + 外部${externalTargets.length} / soft: egtype配信${softTargets.length}）${dupCount ? `(重複${dupCount}件を排除)` : ''}${STRICT ? ' [strict]' : ''}`)

// --list: 実リクエストを出さずに監視対象だけを吐いて終わる(Day97)。
// selftest から「何が監視対象になっているか」をネットワーク無しで固定できるようにするための口。
// 抽出層(lib)の純関数テストだけでは、抽出できていても本体で targets に合流し損ねていれば
// 監視は増えないまま通ってしまう＝配線までを固定しないと false-green は塞げない。
if (process.argv.includes('--list')) {
  // 4列目に配信主体(owner)を出す。hard/soft がどの根拠で決まったかを外から突合できるようにする
  // ためで、既存の列位置(0:hard|soft / 1:cat / 2:url)は変えない。
  for (const t of targets) console.log(`${t.soft ? 'soft' : 'hard'}\t${t.cat}\t${t.url}\t${t.owner}`)
  process.exit(0)
}
const results = await Promise.all(targets.map(async (t) => ({ ...t, ...(await check(t.url)) })))
const hardBad = results.filter((r) => !r.ok && !r.soft)
const softBad = results.filter((r) => !r.ok && r.soft)

for (const r of hardBad) console.log(`  ✗ ${r.status || r.err}  [${r.cat}] ${r.url}`)
for (const r of softBad) console.log(`  ⚠ ${r.status || r.err}  [${r.cat}] ${r.url}`)

if (softBad.length > 0) {
  console.log(`[check-links] ⚠ egtype依存(soft) ${softBad.length}/${softTargets.length} 件が未到達 — egtype 本番デプロイ待ちなら想定内(portal と egtype はセットでデプロイ)。デプロイ後は --strict で厳格確認。`)
}

const fatal = hardBad.length > 0 || localMissing.length > 0 || (STRICT && softBad.length > 0)
if (!fatal && hardBad.length === 0 && softBad.length === 0) {
  console.log(`[check-links] ✓ 全${results.length}件 OK / ローカル静的アセット ${localImageRefs.length}件実在 / 自己URL宣言 ${selfUrlDeclarations}件整合`)
  process.exit(0)
} else if (!fatal) {
  // 「portal自前 N/N」の N は **portal 自身がデプロイする分だけ** を数える(Day101)。
  // 従来は分母に egtype 配信の33件(キャラ画像32 + /egtype/)が混ざっており、hard で通った
  // 件数をそのまま「自前」と称していた＝集計の嘘だった。PM で外部リンクも分けた(hard では
  // あるが portal 自前ではない。混ぜると同じ嘘の作り直しになる)。
  console.log(`[check-links] ✓ portal自前 ${portalTargets.length}/${portalTargets.length} 件 + 外部 ${externalTargets.length}件 OK（egtype配信 soft ${softTargets.length}件中 ${softBad.length}件未到達＝警告のみ）/ ローカル静的アセット ${localImageRefs.length}件実在 / 自己URL宣言 ${selfUrlDeclarations}件整合`)
  process.exit(0)
} else {
  console.log(`[check-links] ✗ 致命 ${hardBad.length}件${localMissing.length ? ` + ローカル静的欠落 ${localMissing.length}件` : ''}${STRICT ? ` + soft ${softBad.length}件` : ''} / 全${results.length}件`)
  process.exit(1)
}
