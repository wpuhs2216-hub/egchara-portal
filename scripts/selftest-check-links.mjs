// fetch-with-retry.mjs のセルフテスト（実ネットワーク不要・決定的）。
// 使い方: node scripts/selftest-check-links.mjs   → 最後に PASS/FAIL を出す
//
// 狙い(Day85): check-links の死活監視が一時失敗(タイムアウト/瞬断/5xx/429)を単発で
// 「致命」誤警報にしていた false-red を、リトライで吸収する挙動として固定する。
// 恒久失敗(404 等)はリトライせず即検知＝リンク切れの検知力は落とさないことも併せて固定。
//
// 追加(Day91): 「何を監視対象として抽出するか」の層(scripts/lib/extract-targets.mjs)も固定する。
// 抽出が黙って0件になる/URL が途中で切れて別物を叩く、はどちらも「✓ 全件OK」と出るため
// 実行結果からは気づけない。抽出規則そのものをテストで押さえる。
//
// 追加(Day97): 「何をルートとして監視対象に載せるか」の層も固定する。従来の抽出は
// すべて **リンク**(href)を辿るもので、どこからもリンクされないルートは監視対象に一度も
// 入らなかった(/workspaces/ = SW 汚染端末の救済ルートが実例)。抽出層の純関数と、
// 本体の targets へ合流しているかの配線の両方を押さえる。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync, spawn } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { fetchWithRetry, isTransientStatus } from './fetch-with-retry.mjs'
//
// 追加(Day101): 「監視対象の致命度(hard/soft)を何で決めるか」の層も固定する。soft は
// 「portal 自身では直せない＝egtype のデプロイでしか解消しない失敗で cron を red にしない」
// ための逃がし弁で、従来はカテゴリごとの手書きリテラルだったため実際の配信主体とずれていた
// (同じ /egtype/ 依存で画像は hard・型ページは soft)。URL 由来の述語に変えた分、今度は
// 「接頭辞を広げれば自前のリンク切れまで警告のみにできる」経路が生まれるので、そこも押さえる。
import { extractExternalUrls, extractCharIds, extractLocalAssetRefs, routesFromPageFiles, normalizeRoutePath, findSelfUrlMismatches, extractMetadataBaseOrigin, classifyTargetUrl, canonicalizeTargetUrl, crossRepoRootFromRoster, findIconOnlyControlsWithoutName, findRedirectStubsWithoutNoindex, findRoutesNamingLayoutDefault, ogImageRoutesFromFiles, classifyOgDelivery, findSitemapCoverageGaps, findOriginWideSwWipes, findRobotsSitemapIssues, classifyServedRobots, parseRobotsGroups, classifyServedSitemap, isServedSitemapFatal, isBotChallenge, partitionLinkResults, isUnreachableResult, hostOf, diagnoseConnectFailures, classifyRecheck, resolveConnectFailures, isUnmeasurableExternal } from './lib/extract-targets.mjs'
//
// 追加(Day110): SW の後片付けを「書き方」ではなく「**実際に何を消したか**」で固定する。
// Day107 の静的規則は `caches.keys()` の結果を絞らず delete する形を黒としたが、実害として
// 残っていたのは `keys.filter((k) => k !== CACHE_NAME)` ＝ filter はあるのに他人のものを
// 全部消す反転形で、規則の上では白だった。SW は素の JS なので実走できる。
import { simulateSwActivate, simulateSwCacheWrites, simulateSwOfflineFallback, ownPrefixOf } from './lib/sw-activate-sim.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log('  ✓', m) }
const bad = (m) => { fail++; console.log('  ✗', m) }
const noSleep = () => Promise.resolve()  // テストは実際に待たない

// n 回だけ失敗し、その後 200 を返す mock fetch。
//   mode='throw' → ネットワークエラー(catch されて status:0 相当)
//   mode=<数値>  → その HTTP ステータスで応答(ok=false)
function flakyFetch(failCount, mode = 'throw') {
  let n = 0
  return async () => {
    if (n++ < failCount) {
      if (mode === 'throw') { const e = new Error('boom'); e.name = 'TypeError'; throw e }
      return { status: mode, ok: false }
    }
    return { status: 200, ok: true }
  }
}

console.log('[selftest-check-links] fetchWithRetry の一時失敗リトライ挙動')

// ① ネットワークエラー2回 → 3回目成功。retries=2 で回復し ok(attempts=3)
{
  const r = await fetchWithRetry('u', { fetchImpl: flakyFetch(2, 'throw'), retries: 2, sleep: noSleep })
  if (r.ok && r.attempts === 3) ok('ネットワークエラー2回はリトライで回復(attempts=3, ok)')
  else bad(`ネットワークエラー回復失敗: ${JSON.stringify(r)}`)
}

// ② 503 一時失敗1回 → 2回目成功(attempts=2)
{
  const r = await fetchWithRetry('u', { fetchImpl: flakyFetch(1, 503), retries: 2, sleep: noSleep })
  if (r.ok && r.attempts === 2) ok('503一時失敗はリトライで回復(attempts=2)')
  else bad(`503回復失敗: ${JSON.stringify(r)}`)
}

// ③ 恒久404 はリトライしない(attempts=1・ok=false)＝リンク切れは即検知
{
  const r = await fetchWithRetry('u', { fetchImpl: async () => ({ status: 404, ok: false }), retries: 2, sleep: noSleep })
  if (!r.ok && r.attempts === 1 && r.status === 404) ok('恒久404はリトライせず即fail(attempts=1)')
  else bad(`404挙動が想定外: ${JSON.stringify(r)}`)
}

// ④ 恒久ネットワークエラーは retries を使い切って fail(attempts=3・status0)
{
  const r = await fetchWithRetry('u', { fetchImpl: flakyFetch(99, 'throw'), retries: 2, sleep: noSleep })
  if (!r.ok && r.attempts === 3 && r.status === 0) ok('恒久エラーはretries使い切りfail(attempts=3)')
  else bad(`恒久エラー挙動が想定外: ${JSON.stringify(r)}`)
}

// ⑤ isTransientStatus の分類（0/429/5xx=一時, 404/200=恒久）
if (isTransientStatus(0) && isTransientStatus(429) && isTransientStatus(503) &&
    !isTransientStatus(404) && !isTransientStatus(200)) {
  ok('isTransient分類(0/429/5xx=一時, 404/200=恒久)')
} else {
  bad('isTransient分類が想定外')
}

console.log('\n[selftest-check-links] 抽出層(lib/extract-targets)の規則')

// ⑥ クエリ付き URL を切り詰めない。旧実装は文字クラスに ? = & が無く
//   `.../gtag/js?id=G-XXXX` を `.../gtag/js` として検査していた＝常時200のベースURLだけ
//   叩いて合格する false-green（Day45 で @ について直した事故と同型）。
{
  const src = `<script src="https://www.googletagmanager.com/gtag/js?id=G-J5KGMEKCF4" />`
  const urls = extractExternalUrls(src)
  if (urls.length === 1 && urls[0] === 'https://www.googletagmanager.com/gtag/js?id=G-J5KGMEKCF4') {
    ok('クエリ付きURLを丸ごと抽出(?id=… を切り落とさない)')
  } else bad(`クエリ付きURLの抽出が想定外: ${JSON.stringify(urls)}`)
}

// ⑦ @handle も従来どおり切れない（Day45 の回帰）
{
  const urls = extractExternalUrls(`href="https://www.tiktok.com/@diva_egshugy"`)
  if (urls.length === 1 && urls[0].endsWith('/@diva_egshugy')) ok('@handle URL が @ の手前で切れない(Day45 回帰)')
  else bad(`@handle の抽出が想定外: ${JSON.stringify(urls)}`)
}

// ⑧ テンプレートリテラルの動的 URL は捨てる。旧実装は `${` の手前で切って
//   実在しない `https://www.tiktok.com/@` を hard ターゲットとして叩いていた(phantom)。
{
  const urls = extractExternalUrls('const U = `https://www.tiktok.com/@${NAME}`')
  if (urls.length === 0) ok('動的URL(${…})は phantom を作らず捨てる')
  else bad(`動的URLを実URLとして拾ってしまった: ${JSON.stringify(urls)}`)
}

// ⑨ exclude(CDN/フォント等ノイズ)が効く
{
  const urls = extractExternalUrls('a="https://fonts.googleapis.com/x" b="https://example.com/y"', { exclude: /fonts\./ })
  if (urls.length === 1 && urls[0] === 'https://example.com/y') ok('exclude 指定でノイズURLを除外')
  else bad(`exclude が効いていない: ${JSON.stringify(urls)}`)
}

// ⑩ キャラ id 抽出は空白・改行の入り方に依存しない。ここが記法変更で0件化すると
//   キャラ画像32＋型頁32の死活監視が丸ごと消えたまま「✓全件OK」になる(check-links 側で
//   0件を致命にする floor も入れてある)。
{
  const oneLine = `{ id: "GRCT", name: "ぺかりん", animal: "ペリカン" },`
  const reformatted = `{\n  id: "usoron",\n  name: "でまろう",\n  animal: "オオカミ",\n},`
  const ids = extractCharIds(oneLine + reformatted)
  if (ids.length === 2 && ids[0] === 'GRCT' && ids[1] === 'usoron') ok('キャラid抽出が1行/整形後の複数行どちらでも効く')
  else bad(`キャラid抽出が想定外: ${JSON.stringify(ids)}`)
}

// ⑪ 別配列(EXPERIMENTS の ja: / PRODUCTS の jaName:)を誤ってキャラとして拾わない（負のサニティ）
{
  const ids = extractCharIds(`{ id: "wordwolf", ja: "ワードウルフ" },{ id: "yorulog", jaName: "ヨルログ" },`)
  if (ids.length === 0) ok('キャラ以外の配列(ja:/jaName:)は拾わない(負のサニティ)')
  else bad(`キャラ以外を誤抽出: ${JSON.stringify(ids)}`)
}

// ⑫ ローカル静的アセットはシングルクォートでも拾う。layout.tsx は全面シングルクォートで
//   書かれており、旧実装(ダブルクォート限定)ではそこに画像を1行足すだけで
//   「実在しない OG 画像を指して共有カードが404」(Day82)が無検知で再発しえた。
{
  const refs = extractLocalAssetRefs(`manifest: '/manifest.json'\nimages: ['/og-image.png']\nsrc="/egchara-logo.png"\nregister('/sw.js')`)
  const want = ['/manifest.json', '/og-image.png', '/egchara-logo.png', '/sw.js']
  if (want.every((p) => refs.includes(p)) && refs.length === want.length) {
    ok('ローカル資産をシングル/ダブル両クォートで抽出(manifest.json・sw.js 含む)')
  } else bad(`ローカル資産の抽出が想定外: ${JSON.stringify(refs)}`)
}

// ⑬ 別アプリ(egtype)が配信する多セグメントパスは portal の public 実在チェック対象にしない（負のサニティ）
{
  const refs = extractLocalAssetRefs(`src={"/egtype/characters/GRCT.webp"}`)
  if (refs.length === 0) ok('多セグメント(/egtype/…)は portal の実在チェック対象外(負のサニティ)')
  else bad(`別アプリ配信パスを誤って対象化: ${JSON.stringify(refs)}`)
}

console.log('\n[selftest-check-links] 実ルート列挙層(routesFromPageFiles)')

// ⑭ ルート直下と入れ子。trailingSlash: true なので末尾スラッシュ付きで出す。
{
  const { routes, skipped } = routesFromPageFiles(['page.tsx', 'noxa/page.tsx', 'workspaces/page.tsx'])
  if (routes.length === 3 && routes.includes('/') && routes.includes('/noxa/') &&
      routes.includes('/workspaces/') && skipped.length === 0) {
    ok('page.tsx をルート(/ ・/noxa/ ・/workspaces/)へ末尾スラッシュ付きで変換')
  } else bad(`ルート変換が想定外: ${JSON.stringify({ routes, skipped })}`)
}

// ⑮ ルートグループ `(...)` は URL に出ない。ここを素通りさせると存在しない
//   `/(marketing)/lp/` を叩いて false-red になる。
{
  const { routes } = routesFromPageFiles(['(marketing)/lp/page.tsx'])
  if (routes.length === 1 && routes[0] === '/lp/') ok('ルートグループ (…) は URL から落とす')
  else bad(`ルートグループの扱いが想定外: ${JSON.stringify(routes)}`)
}

// ⑯⑰ URL を静的に決められないものは routes に混ぜず skipped に分ける。
//   黙って捨てると「監視できていない」こと自体が見えなくなる。
{
  const { routes, skipped } = routesFromPageFiles(['blog/[slug]/page.tsx', '@modal/detail/page.tsx'])
  if (routes.length === 0 && skipped.length === 2 &&
      skipped.some((s) => s.file === 'blog/[slug]/page.tsx' && /動的/.test(s.reason)) &&
      skipped.some((s) => s.file === '@modal/detail/page.tsx' && /パラレル/.test(s.reason))) {
    ok('動的セグメント/パラレルルートは routes に混ぜず skipped として顕在化')
  } else bad(`静的解決不能ルートの扱いが想定外: ${JSON.stringify({ routes, skipped })}`)
}

// ⑱ プライベートフォルダ `_foo` はルーティングされない(Next.js 規約)＝叩くと404の phantom
{
  const { routes, skipped } = routesFromPageFiles(['_draft/page.tsx'])
  if (routes.length === 0 && skipped.length === 0) ok('プライベートフォルダ _… は監視対象にしない(負のサニティ)')
  else bad(`プライベートフォルダの扱いが想定外: ${JSON.stringify({ routes, skipped })}`)
}

// ⑲ page 以外(layout / opengraph-image / 画像)をルートと誤認しない（負のサニティ）
{
  const { routes } = routesFromPageFiles(['layout.tsx', 'noxa/opengraph-image.tsx', 'icon.png', 'globals.css'])
  if (routes.length === 0) ok('page 以外のファイルはルートとして拾わない(負のサニティ)')
  else bad(`page 以外を誤ってルート化: ${JSON.stringify(routes)}`)
}

// ⑳ floor の条件そのもの: 抽出0件は0件として返る（本体はこれを致命にする）
{
  const { routes } = routesFromPageFiles([])
  if (routes.length === 0) ok('page が1件も無ければ routes は0件(本体の floor が致命にする条件)')
  else bad(`空入力の扱いが想定外: ${JSON.stringify(routes)}`)
}

// ㉑ 多階層の入れ子ルート。朝は portal に入れ子が1本も無いため、変換が階層を落としていても
//   実データでは気づけない（下の配線テストの期待値も朝はトップレベル1階層しか見ていなかった）。
{
  const { routes } = routesFromPageFiles(['tools/converter/unit/page.tsx'])
  if (routes.length === 1 && routes[0] === '/tools/converter/unit/') ok('多階層の入れ子ルートを階層を落とさず変換')
  else bad(`入れ子ルートの変換が想定外: ${JSON.stringify(routes)}`)
}

// ㉒ mdx/md も実ルートを生む(pageExtensions に mdx を足した構成)。PM(Day97) までは
//   tsx/ts/jsx/js 以外を routes にも skipped にも載せず**黙って捨てて**おり、
//   本日封鎖したはずの「監視対象に入らないルート」を自分で作り直していた。
{
  const { routes, skipped } = routesFromPageFiles(['blog/page.mdx', 'news/page.md'])
  if (routes.length === 2 && routes.includes('/blog/') && routes.includes('/news/') && skipped.length === 0) {
    ok('page.mdx / page.md も実ルートとして拾う(黙って捨てない)')
  } else bad(`mdx/md の扱いが想定外: ${JSON.stringify({ routes, skipped })}`)
}

// ㉓ 未知の単一拡張子は「ルート化規則が追いついていない」ものとして skipped に顕在化する。
//   黙って continue すると Day96 の教訓どおり skip の理由が区別できず false-green になる。
{
  const { routes, skipped } = routesFromPageFiles(['future/page.vue'])
  if (routes.length === 0 && skipped.length === 1 && /未知のページ拡張子/.test(skipped[0].reason)) {
    ok('未知の page 拡張子は skipped として理由付きで顕在化')
  } else bad(`未知拡張子の扱いが想定外: ${JSON.stringify({ routes, skipped })}`)
}

// ㉔ 一方で明らかな非ルート資産(page.css 等)まで ⓘ を出すとノイズで顕在化が埋もれる（負のサニティ）
{
  const { routes, skipped } = routesFromPageFiles(['page.css', 'noxa/page.module.css', 'page.test.tsx'])
  if (routes.length === 0 && skipped.length === 0) ok('page.css / page.module.css / page.test.tsx は ⓘ を出さず静かに無視(負のサニティ)')
  else bad(`非ルート資産の扱いが想定外: ${JSON.stringify({ routes, skipped })}`)
}

console.log('\n[selftest-check-links] リンク由来パスの正規化(normalizeRoutePath)')

// ㉕ trailingSlash: true 環境ではリンク由来を揃えないと同一ルートを2回叩き、
//   「うち無リンクM」もリンク済みルートを無リンクと誤報する。
{
  const link = ['/', '/noxa', '/stamps/'].map(normalizeRoutePath)
  const routes = ['/', '/noxa/', '/stamps/', '/workspaces/']
  const internal = [...new Set([...link, ...routes])]
  const unlinked = routes.filter((r) => !link.includes(r))
  if (internal.length === 4 && !internal.includes('/noxa') &&
      unlinked.length === 1 && unlinked[0] === '/workspaces/') {
    ok('末尾スラッシュ無しの href を正規化し重複ターゲットと無リンク誤報を防ぐ')
  } else bad(`正規化が想定外: internal=${JSON.stringify(internal)} unlinked=${JSON.stringify(unlinked)}`)
}

console.log('\n[selftest-check-links] canonical/og:url の自己参照ずれ(findSelfUrlMismatches)')

const ORIGIN = 'https://egshugy.com'

// ㉖ 自分のルートを正しく指していれば何も出ない。末尾スラッシュの揺れは正規化して吸収する。
{
  const { mismatches, declarations } = findSelfUrlMismatches([
    { file: 'noxa/layout.tsx', src: `canonical: "${ORIGIN}/noxa/", url: "${ORIGIN}/noxa"` },
    { file: 'layout.tsx', src: `metadataBase: new URL('${ORIGIN}')` },
  ], ORIGIN)
  if (mismatches.length === 0 && declarations === 2) ok('自ルートを指す canonical/og:url は正常(origin だけの metadataBase は宣言に数えない)')
  else bad(`正常な宣言を誤検知: ${JSON.stringify({ mismatches, declarations })}`)
}

// ㉗ 別ルートを指す宣言＝HTTP は 200 なので死活監視をすり抜ける本命のケース。
//   検索エンジンに正規URLを誤申告し、SNS では別ページの共有カードが出続ける。
{
  const { mismatches } = findSelfUrlMismatches([
    { file: 'noxa/layout.tsx', src: `canonical: "${ORIGIN}/"` },
  ], ORIGIN)
  if (mismatches.length === 1 && mismatches[0].declared === '/' && mismatches[0].expected === '/noxa/') {
    ok('別ルートを指す canonical を検知(200 が返るため HTTP 検査では絶対に落ちない)')
  } else bad(`自己URLずれの検知が想定外: ${JSON.stringify(mismatches)}`)
}

// ㉘ URL を静的に決められないルート配下は突合しない（誤検知させない・負のサニティ）
{
  const { mismatches } = findSelfUrlMismatches([
    { file: 'blog/[slug]/layout.tsx', src: `canonical: "${ORIGIN}/blog/hello/"` },
  ], ORIGIN)
  if (mismatches.length === 0) ok('動的セグメント配下は自己URL突合の対象外(負のサニティ)')
  else bad(`動的ルートで誤検知: ${JSON.stringify(mismatches)}`)
}

// ㉙ **false-red の回帰(PM 再レビューで実測した誤検知)**: 絶対URLの OG 画像と、別ルートを指す
//   正当な絶対リンクは自己参照宣言ではない。当初実装はファイル中の自サイト絶対URLを無条件に
//   突合しており、この2つで死活監視が HTTP 検査の前に exit 1 で丸ごと落ちていた。
{
  const { mismatches, declarations } = findSelfUrlMismatches([
    { file: 'layout.tsx', src: `openGraph: { images: ['${ORIGIN}/og-image.png'] }` },
    { file: 'noxa/page.tsx', src: `<a href="${ORIGIN}/">トップへ戻る</a>` },
  ], ORIGIN)
  if (mismatches.length === 0 && declarations === 0) ok('絶対URLの OG 画像・別ルートへの正当な絶対リンクを誤検知しない(false-red 回帰)')
  else bad(`宣言でないURLを誤検知: ${JSON.stringify({ mismatches, declarations })}`)
}

// ㉚ metadata が効くのは page/layout。宣言と同じ書き方でもそれ以外のファイルは突合しない
//   (app/lib/meta.ts のように複数ルート分の canonical を組み立てる置き場を誤検知させない)。
{
  const { mismatches, declarations } = findSelfUrlMismatches([
    { file: 'lib/meta.ts', src: `canonical: "${ORIGIN}/noxa/"` },
  ], ORIGIN)
  if (mismatches.length === 0 && declarations === 0) ok('page/layout 以外のファイルは自己URL突合の対象外(負のサニティ)')
  else bad(`page/layout 以外で誤検知: ${JSON.stringify({ mismatches, declarations })}`)
}

// ㉛ 本物の app/ に自己URLずれが無いこと＋宣言が実在すること（実データの固定・本体 floor の裏付け）
{
  const entries = walkRel(path.join(__dirname, '..', 'app'))
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => ({ file: f, src: fs.readFileSync(path.join(__dirname, '..', 'app', f), 'utf8') }))
  const { mismatches, declarations } = findSelfUrlMismatches(entries, ORIGIN)
  if (mismatches.length === 0 && declarations === 2) ok(`実 app/ の自己URL宣言(${declarations}件)に矛盾なし`)
  else bad(`実 app/ の自己URL突合が想定外: ${JSON.stringify({ mismatches, declarations })}`)
}

// ㉜ origin の単一の出所(metadataBase)を読めること／読めなければ null（本体が致命にする条件）
{
  const good = extractMetadataBaseOrigin(`  metadataBase: new URL('https://egshugy.com'),`)
  const withSlash = extractMetadataBaseOrigin(`metadataBase: new URL("https://egshugy.com/")`)
  const gone = extractMetadataBaseOrigin(`export const metadata = { title: 'x' }`)
  if (good === 'https://egshugy.com' && withSlash === 'https://egshugy.com' && gone === null) {
    ok('metadataBase から origin を抽出(末尾スラッシュ吸収)・不在なら null(本体の floor 条件)')
  } else bad(`metadataBase 抽出が想定外: ${JSON.stringify({ good, withSlash, gone })}`)
}

console.log('\n[selftest-check-links] 配線(check-links --list が実ルートを監視対象に載せているか)')

// ㉝ 本物の app/ を歩いた結果が targets に合流しているところまで固定する。
//   抽出層が正しくても本体で合流し損ねていれば監視は増えないまま「✓」で通る。
//   とくに /workspaces/ は **どこからもリンクされないことが仕様**の救済ルート(yorulog の
//   Service Worker が握った古いキャッシュから来た人をトップへ逃がす)で、リンク由来の抽出
//   だけでは永久に無監視になる。ここが落ちたら Day97 の退行。
//   PM(Day97): 期待値の作り方を**実ツリーの再帰走査**へ改めた。朝の実装は app/ 直下1階層の
//   ディレクトリしか見ておらず、入れ子ルート(app/a/b/page.tsx)が配線から落ちても緑のまま＝
//   本日封鎖した「母集団の決め方が狭くて取りこぼす」穴を、テストの期待値側で作っていた。
//   期待値を routesFromPageFiles に委ねてよいのは、同関数の変換規則を上で独立に固定して
//   いるため。このテストが見るのは「その結果が本体の targets へ合流しているか」の配線。
function walkRel(dir, prefix = '') {
  let out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out = out.concat(walkRel(path.join(dir, e.name), rel))
    else out.push(rel)
  }
  return out
}
{
  const r = spawnSync(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--list'], { encoding: 'utf8' })
  const internal = r.stdout.split('\n').filter((l) => l.split('\t')[1] === '内部').map((l) => l.split('\t')[2])
  const { routes: expected } = routesFromPageFiles(walkRel(path.join(__dirname, '..', 'app')))
  const missing = expected.filter((p) => !internal.some((u) => u.endsWith(p)))
  if (r.status === 0 && expected.length > 0 && missing.length === 0 && internal.some((u) => u.endsWith('/workspaces/'))) {
    ok(`app の実ルート全${expected.length}件が監視対象に載っている(再帰走査・無リンクの /workspaces/ を含む)`)
  } else bad(`実ルートが監視対象から漏れている: expected=${JSON.stringify(expected)} missing=${JSON.stringify(missing)} status=${r.status}`)
}

// ㉞ 監視対象に同一URLの重複が無い(正規化の配線)。重複は無害に見えて件数表示を膨らませ、
//   「内部N件」を実態より多く見せる＝監視の網が広がったように誤読させる。
{
  const r = spawnSync(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--list'], { encoding: 'utf8' })
  const urls = r.stdout.split('\n').filter((l) => l.includes('\t')).map((l) => l.split('\t')[2])
  const dup = urls.filter((u, i) => urls.indexOf(u) !== i)
  if (dup.length === 0) ok('監視対象URLに重複が無い(リンク由来とルート由来の統合が正規化されている)')
  else bad(`監視対象URLが重複している: ${JSON.stringify([...new Set(dup)])}`)
}

// ㉛㉜ 自己URLずれ→exit 1 の配線。LINKS_SELFURL_DIR の非破壊 override で正本は触らない
//   (Day94 の UPTIME_APP_DIR と同じ作法)。--list は HTTP を出さないので、ずれの判定が
//   末尾のまとめ判定に置かれていると exit 0 で素通りする＝即時致命であることまで固定する。
{
  const fx = path.join(os.tmpdir(), 'selftest-check-links-selfurl')
  const run = (canonical) => {
    fs.rmSync(fx, { recursive: true, force: true })
    fs.mkdirSync(path.join(fx, 'noxa'), { recursive: true })
    fs.writeFileSync(path.join(fx, 'layout.tsx'), `export const metadata = { metadataBase: new URL('https://egshugy.com') }\n`)
    fs.writeFileSync(path.join(fx, 'noxa', 'layout.tsx'), `export const metadata = { alternates: { canonical: "${canonical}" } }\n`)
    const r = spawnSync(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--list'],
      { encoding: 'utf8', env: { ...process.env, LINKS_SELFURL_DIR: fx } })
    fs.rmSync(fx, { recursive: true, force: true })
    return r
  }
  const bad1 = run('https://egshugy.com/')
  if (bad1.status === 1 && /自己参照ずれ/.test(bad1.stdout)) ok('別ルートを指す canonical で check-links が即座に exit 1(--list でも素通りしない)')
  else bad(`自己URLずれの配線が想定外: status=${bad1.status}`)

  const good1 = run('https://egshugy.com/noxa/')
  if (good1.status === 0 && !/自己参照ずれ/.test(good1.stdout)) ok('自ルートを指す canonical では素通り(負のサニティ)')
  else bad(`正常な canonical で落ちた: status=${good1.status}`)
}

// ㉟ 配信主体の判定(純関数)。hard/soft は「どの配列から来たか」ではなく「URL がどこから
//   配信されるか」で決まる、を規則そのものとして固定する。
{
  const B = 'https://egshugy.com'
  const cases = [
    ['/',                                   'portal',   false, 'トップは portal 自前'],
    ['/noxa/',                              'portal',   false, '自前ルートは hard'],
    ['/egtype/',                            'egtype',   true,  'egtype 入口は soft'],
    ['/egtype/types/pekarin/',              'egtype',   true,  '型ページは soft'],
    ['/egtype/characters/pekarin.webp',     'egtype',   true,  'キャラ画像も同じデプロイ依存なので soft(Day101 の主眼)'],
  ]
  let bads = []
  for (const [p, owner, soft, why] of cases) {
    const got = classifyTargetUrl(B + p, B)
    if (got.owner !== owner || got.soft !== soft) bads.push(`${p} → ${JSON.stringify(got)} (期待 ${owner}/${soft}: ${why})`)
  }
  if (bads.length === 0) ok('配信主体の判定: /egtype/** は画像もページも一律 soft・それ以外の自サイトは hard')
  else bad(`配信主体の判定がずれている: ${bads.join(' / ')}`)

  const ext = classifyTargetUrl('https://apps.apple.com/jp/app/id123', B)
  if (ext.owner === 'external' && ext.soft === false) ok('外部リンクは hard(貼った責任は portal 側にあるので警告止まりにしない)')
  else bad(`外部リンクの判定が想定外: ${JSON.stringify(ext)}`)

  // ドメイン偽装。startsWith(base) だけで判定すると別ドメインを自前(hard)と誤認する。
  // 誤認された URL は「portal 自前が落ちている」として cron を red にする false-red 源。
  const spoof = classifyTargetUrl('https://egshugy.com.example.net/egtype/', B)
  if (spoof.owner === 'external') ok('base を接頭辞に持つだけの別ドメインを自前と誤認しない(egshugy.com.example.net)')
  else bad(`別ドメインを自前と誤認した: ${JSON.stringify(spoof)}`)
}

// ㊱ 配線: --list の実出力で /egtype/** が一件残らず soft、かつ portal 自前が一件も soft に
//   落ちていないこと。純関数が正しくても本体が旧リテラルのままなら致命度は変わらない。
{
  const r = spawnSync(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--list'], { encoding: 'utf8' })
  const rows = r.stdout.split('\n').filter((l) => l.includes('\t')).map((l) => l.split('\t'))
  const egtypeRows = rows.filter(([, , url]) => url.includes('/egtype/'))
  const hardEgtype = egtypeRows.filter(([lv]) => lv !== 'soft')
  const softOwn = rows.filter(([lv, , url]) => lv === 'soft' && !url.includes('/egtype/'))
  if (r.status === 0 && egtypeRows.length > 0 && hardEgtype.length === 0 && softOwn.length === 0) {
    ok(`egtype 配信の全${egtypeRows.length}件が soft・portal 自前に soft が無い(致命度がURL由来で一貫)`)
  } else bad(`致命度の配線が想定外: hardEgtype=${hardEgtype.length} softOwn=${softOwn.length} status=${r.status}`)

  // サマリの件数が owner 列の実内訳と3値とも一致すること(集計の嘘の再発防止)。
  // PM Day101: 朝は hard を丸ごと「portal自前」と称し外部リンク9件を自前に混ぜていた
  // (=朝が封鎖したはずの嘘と同型)。hard であることと portal 自前であることは別の話なので、
  // 「portal自前」「外部」「egtype配信」の3つを別々に突合する。
  const n = (o) => rows.filter(([, , , owner]) => owner === o).length
  const expected = `hard: portal自前${n('portal')} + 外部${n('external')} / soft: egtype配信${n('egtype')}`
  if (r.stdout.includes(expected)) ok(`サマリの内訳が owner 列と3値一致（${expected}）`)
  else bad(`サマリの内訳が実態とずれている: 期待「${expected}」/ 実際「${r.stdout.split('\n')[0]}」`)

  // 母集団 floor: 外部リンクが0件だと上の突合は 0===0 で通ってしまい、混同の再発を
  // 検知できなくなる(空振り)。実データに外部が存在することまで込みで固定する。
  if (n('external') > 0 && n('portal') > 0) ok(`突合の母集団が空でない(portal自前${n('portal')} / 外部${n('external')})`)
  else bad(`突合が空振りしている: portal=${n('portal')} external=${n('external')}（抽出層の退化を疑うこと）`)
}

// ㊲ floor: 分類を URL 由来にした代償として、接頭辞を広げるだけで「自前のリンク切れも
//   警告のみ・exit 0」に落とせてしまう＝この修正自身を無言で無効化できる経路が生まれる。
//   portal がデプロイする実ルートは必ず hard、という不変条件で押さえていることを実証する。
//   LINKS_CROSS_REPO_PREFIXES の非破壊 override を使い正本は改竄しない(Day94 と同じ作法)。
{
  const run = (prefixes) => spawnSync(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--list'],
    { encoding: 'utf8', env: { ...process.env, LINKS_CROSS_REPO_PREFIXES: prefixes } })

  const wide = run('/')
  if (wide.status === 1 && /分類異常/.test(wide.stdout)) ok('接頭辞を "/" まで広げると即座に exit 1(自前のリンク切れを警告のみに格下げできない)')
  else bad(`広すぎる接頭辞が素通りした: status=${wide.status}`)

  // 実ルートを名指しで飲み込む形も塞げていること("/" のような極端な値だけの検知ではない)。
  const narrow = run('/egtype/,/noxa/')
  if (narrow.status === 1 && /分類異常.*\/noxa\//.test(narrow.stdout)) ok('実ルート1本を接頭辞に足しただけでも分類異常として検知する(/noxa/)')
  else bad(`実ルートを飲み込む接頭辞が素通りした: status=${narrow.status}`)

  const sane = run('/egtype/')
  if (sane.status === 0 && !/分類異常/.test(sane.stdout)) ok('既定と同じ接頭辞なら素通り(負のサニティ)')
  else bad(`正常な接頭辞で落ちた: status=${sane.status}`)

  // PM Day101: 実ルート floor の母集団は app/ の4件しかなく、**実ルートでない内部リンク**
  // (/word-wolf/ 等の稼働中ゲーム＝Day45 で実 404 を出した箇所)を飲み込む形は素通りしていた。
  // 既定より緩い override は全ターゲットで拒否されること。
  const game = run('/egtype/,/word-wolf/')
  if (game.status === 1 && /word-wolf.*格下げ/.test(game.stdout)) ok('実ルートでない内部リンク(/word-wolf/)を飲み込む override も拒否する')
  else bad(`実ルート以外を飲み込む override が素通りした: status=${game.status}`)

  // 逆向き(soft を減らす=逃がし弁の消失)も拒否する。PM Day101 の当初判断は「厳格化は監視が
  // 強くなるだけなので許容」だったが、これは誤りだった。hard/soft は監視の強弱ではなく
  // **責任の所在**の分類で、soft を消すと Day101 朝が塞いだ実害がそのまま再発する:
  //   ・33体目を足した瞬間に egtype 未デプロイで portal の cron が red(soft を作った目的に反する)
  //   ・サマリが egtype 配信65件を自前に算入して「portal自前 76」と称する＝集計の嘘の再発
  // 実測(修正前): soft が 65→0 になっても **exit 0 のまま素通り**していた。
  // 一時的に全件を致命として見たい用途は --strict が担う(分類は保ったまま失敗の重さだけ変える)。
  const wiped = run(' ')
  if (wiped.status === 1 && /逃がし弁が消えている/.test(wiped.stdout)) ok('soft を全廃する override を拒否する(逃がし弁の消失＝集計の嘘と cron red の再発)')
  else bad(`soft 全廃の override が素通りした: status=${wiped.status}`)

  // 「/egtype/ を名乗ったまま実際には何も掬わない」狭め方も同じ穴。接頭辞が実在しない
  // サブパスを指すと分類上 egtype は0件になり、上と同じ結末になる(より気づきにくい形)。
  const narrowed = run('/egtype/zzz/')
  if (narrowed.status === 1 && /逃がし弁が消えている/.test(narrowed.stdout)) ok('実在しないサブパスへ狭める override も拒否する(/egtype/zzz/)')
  else bad(`狭すぎる接頭辞が素通りした: status=${narrowed.status}`)
}

// ㊲-2 基準線(純関数): 双方向 floor の突合相手＝cross-repo 領域の根は、**宣言(接頭辞)ではなく
//   ロスターから生成した実ターゲット**から導く。これにより正本定数を書き換えても env で
//   override しても基準線は動かず、同じ floor が落ちる。
{
  const real = crossRepoRootFromRoster(['/egtype/characters/pekarin.webp', '/egtype/types/pekarin/'])
  if (real === '/egtype/') ok('ロスターの実パターン(画像+型ページ)から領域の根 /egtype/ を導く')
  else bad(`領域の根が想定外: ${real}`)

  // portal 自前(/ や /noxa/)が「領域内」に化けないこと。化けると逆向き floor が
  // 全ターゲットを「hard なのはおかしい」と誤検知し、死活監視が丸ごと落ちる false-red になる
  // (PM Day97 で実際に踏んだクラス: 誤検知1件で監視が全損する)。
  const inArea = (p) => p.startsWith(real)
  if (!inArea('/') && !inArea('/noxa/') && !inArea('/egramen/') && inArea('/egtype/') && inArea('/egtype/types/x/')) {
    ok('領域判定が portal 自前(/ ・/noxa/ ・/egramen/)を巻き込まない(false-red 回帰)')
  } else bad('領域判定が portal 自前まで egtype 領域と見なしている')

  // 最終セグメント(ファイル名・キャラID)は根に含めない。1体しか無い時に領域が
  // 1ファイルへ縮み、残りの egtype 配信が「領域外なのに soft」として誤検知される。
  if (crossRepoRootFromRoster(['/egtype/characters/pekarin.webp']) === '/egtype/characters/') {
    ok('ロスター1件でも最終セグメントは根に含めない(領域が1ファイルへ縮まない)')
  } else bad(`単一ロスターの根が想定外: ${crossRepoRootFromRoster(['/egtype/characters/pekarin.webp'])}`)

  // 共通部分が無い/空なら根は '/' に潰れる＝本体が致命化すべき状態(下の配線で固定)。
  if (crossRepoRootFromRoster([]) === '/' && crossRepoRootFromRoster(['/egtype/a/x.webp', '/other/b/']) === '/') {
    ok('共通部分が無い・空のロスターでは根が "/" に潰れる(本体はこれを致命として扱う)')
  } else bad('根の潰れ判定が想定外')
}

// ㊳ 素の origin(https://egshugy.com)とルート表記(https://egshugy.com/)が別ターゲットとして
//   二重に監視されないこと。trailingSlash:true で両者は同じ1ページだが、metadataBase が
//   素の origin を宣言しているため外部URL抽出が拾い、文字列が違うので PM Day97 の重複排除
//   (文字列一致)をすり抜けて同じページを2回叩いていた(PM Day101 実測)。
{
  const B = 'https://egshugy.com'
  if (canonicalizeTargetUrl(B, B) === `${B}/` && canonicalizeTargetUrl(`${B}/noxa/`, B) === `${B}/noxa/`) {
    ok('素の origin をルート表記へ正規化する(他のURLは素通し)')
  } else bad(`origin 正規化が想定外: ${canonicalizeTargetUrl(B, B)}`)

  const r = spawnSync(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--list'], { encoding: 'utf8' })
  const urls = r.stdout.split('\n').filter((l) => l.includes('\t')).map((l) => l.split('\t')[2])
  const bare = urls.filter((u) => u === B)
  if (bare.length === 0 && urls.includes(`${B}/`)) ok('監視対象に素の origin が残っておらず、ルート表記のみ1件で監視されている')
  else bad(`素の origin が二重監視されている: bare=${bare.length} root=${urls.includes(`${B}/`)}`)
}

// ㊴ アイコンだけのリンク/ボタンのアクセシブル名(Day104・純関数)。
//   HTTP は 200 を返すので死活監視では永久に検知できない静的欠陥。判定規則そのものを固定する。
//   false-red を出さない側に倒す設計（式は「何か描画される」と見なす）も併せて押さえる。
{
  const one = (src) => findIconOnlyControlsWithoutName(src)
  const cases = [
    ['<Link href="/"><ArrowLeft className="w-5 h-5" /></Link>', 1, 'アイコンのみ・名前なしは指摘'],
    ['<Link href="/" aria-label="ホームへ戻る"><ArrowLeft /></Link>', 0, 'aria-label があれば名前あり'],
    ['<Link href="/" title="戻る"><ArrowLeft /></Link>', 0, 'title も名前として扱う'],
    ['<Link href="/"><ArrowLeft />ホームへ</Link>', 0, '可視テキストがあれば名前あり'],
    ['<Link href="/"><Icon />{c.name}</Link>', 0, '式は中身を静的に読めない＝名前ありに倒す(false-red を出さない)'],
    ['<Link href="/"><ArrowLeft />{" "}</Link>', 1, '空白だけの式は名前にならない'],
    ['<button onClick={() => setOpen(v => !v)}><X /></button>', 1, '属性値のアロー関数の > を開始タグ終端と誤認しない'],
    ['<a href="/x">テキスト</a>', 0, '要素を子に持たない(アイコンすら無い)ものは対象外'],
  ]
  const bads = []
  for (const [src, want, why] of cases) {
    const got = one(src).offenders.length
    if (got !== want) bads.push(`${why}: 期待${want}件 実際${got}件`)
  }
  if (bads.length === 0) ok('アイコンのみのリンク/ボタンの名前判定が規則どおり(名前なしだけを指摘・式は誤検知しない)')
  else bad(`a11y 名前判定がずれている: ${bads.join(' / ')}`)

  // floor の母集団: 「子を持つ Link/a/button を何個見たか」が数えられていること。
  // ここが 0 のまま通ると、指摘0件＝「✓ 問題なし」としてガードだけが無言で消える。
  const scanned = one('<Link href="/"><A /></Link><button><B /></button>').scanned
  if (scanned === 2) ok('走査した母集団(scanned)を数えている(0件を致命化する floor の根拠)')
  else bad(`scanned が想定外: ${scanned}`)
}

// ㊵ リダイレクトスタブの索引制御(Day104・純関数)。中身の無い即リダイレクトのルートが
//   noindex を宣言しているか。宣言しないとレイアウト既定＝トップと同一の title/description を
//   名乗る空ページが重複コンテンツとして索引されうる(sitemap 非掲載は索引されない保証ではない)。
{
  const stub = 'window.location.replace("/")'
  const noindex = 'export const metadata = { robots: { index: false, follow: true } }'
  const cases = [
    [[{ route: '/w/', files: [{ rel: 'w/page.tsx', src: stub }] }], 1, 'リダイレクトのみ・noindex 無しは指摘'],
    [[{ route: '/w/', files: [{ rel: 'w/page.tsx', src: `${noindex}\n${stub}` }] }], 0, '同一ファイルの noindex を認める'],
    [[{ route: '/w/', files: [{ rel: 'w/page.tsx', src: noindex }, { rel: 'w/redirect-client.tsx', src: stub }] }], 0,
      'server/client 分割(本 Day の実装形)でもディレクトリ単位で認める'],
    [[{ route: '/', files: [{ rel: 'page.tsx', src: '<h1>ホーム</h1>' }] }], 0, 'リダイレクトしない実ページは対象外'],
    [[{ route: '/w/', files: [{ rel: 'w/page.tsx', src: 'location.href = "/"' }] }], 1, 'location.href 代入形も検知する'],
  ]
  const bads = []
  for (const [dirs, want, why] of cases) {
    const got = findRedirectStubsWithoutNoindex(dirs).length
    if (got !== want) bads.push(`${why}: 期待${want}件 実際${got}件`)
  }
  if (bads.length === 0) ok('リダイレクトスタブの noindex 判定が規則どおり(分割実装も認め、実ページは巻き込まない)')
  else bad(`noindex 判定がずれている: ${bads.join(' / ')}`)
}

// ㊶ OG 画像の配信ヘッダ(Day104・純関数)。「200 が返るか」ではなく「画像として配信されているか」。
//   実測で拡張子なしの OG は 200 だが content-type ヘッダが無く、res.ok しか見ない従来の検査では
//   対象に載せても検知できなかった。
{
  const routes = ogImageRoutesFromFiles([
    'opengraph-image.tsx', 'twitter-image.tsx', 'noxa/opengraph-image.tsx',
    'page.tsx', 'layout.tsx', 'icon.png', 'noxa/opengraph-image.tsx',
  ])
  const want = ['/noxa/opengraph-image.png', '/opengraph-image.png', '/twitter-image.png']
  if (JSON.stringify(routes) === JSON.stringify(want)) {
    ok('OG ルート抽出: ファイル規約から拡張子つき配信パスを導く(重複排除・ページは巻き込まない)')
  } else bad(`OG ルート抽出が想定外: ${JSON.stringify(routes)}`)

  const cases = [
    [{ status: 200, contentType: 'image/png' }, 'ok', '200 かつ image/* は期待どおり'],
    [{ status: 200, contentType: null }, 'bad-type', '200 でも型ヘッダが無いのが本 Day の欠陥そのもの'],
    [{ status: 200, contentType: 'text/html; charset=utf-8' }, 'bad-type', '画像以外の型で返るのも欠陥'],
    [{ status: 404, contentType: null }, 'pending-deploy', '404 は本番未反映(人間ゲート待ち)＝非致命'],
    [{ status: 503, contentType: null }, 'unreachable', '5xx は瞬断扱いの警告'],
  ]
  const bads = []
  for (const [res, wantV, why] of cases) {
    const got = classifyOgDelivery(res)
    if (got !== wantV) bads.push(`${why}: 期待${wantV} 実際${got}`)
  }
  if (bads.length === 0) ok('OG 配信の分類が規則どおり(型なし＝致命 / 未反映＝非致命 の切り分け)')
  else bad(`OG 配信の分類がずれている: ${bads.join(' / ')}`)
}

// ㊷ 配線(Day104): 純関数が正しくても、本体が走査していない/致命化していなければ何も守れない。
//   LINKS_APP_DIR の非破壊 override でフィクスチャを見せ、正本を改竄せずに exit まで固定する。
//   --list を使うので実ネットワークは発生しない(3つの検査はいずれも fetch より前段)。
{
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'links-app-'))
  const write = (rel, src) => {
    const full = path.join(fixtures, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, src)
  }
  const run = (dir) => spawnSync(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--list'],
    { encoding: 'utf8', env: { ...process.env, LINKS_APP_DIR: dir } })

  // (a) 名前の無いアイコンリンクがあれば致命。
  const a = path.join(fixtures, 'a')
  write('a/page.tsx', '<Link href="/"><ArrowLeft className="w-5 h-5" /></Link>')
  write('a/opengraph-image.tsx', 'export default function OG() {}')
  const ra = run(a)
  if (ra.status === 1 && /名前なし.*a11y/.test(ra.stdout)) ok('配線: 名前の無いアイコンリンクで exit 1(a11y ガードが本体に届いている)')
  else bad(`a11y ガードが本体で効いていない: status=${ra.status}`)

  // (b) 名前はあるが、リダイレクトスタブが noindex を宣言していなければ致命。
  const b = path.join(fixtures, 'b')
  write('b/page.tsx', '<Link href="/" aria-label="ホーム"><ArrowLeft /></Link>')
  write('b/opengraph-image.tsx', 'export default function OG() {}')
  write('b/workspaces/page.tsx', 'window.location.replace("/")')
  const rb = run(b)
  if (rb.status === 1 && /noindex なし/.test(rb.stdout)) ok('配線: noindex 無しのリダイレクトスタブで exit 1(索引ガードが本体に届いている)')
  else bad(`索引ガードが本体で効いていない: status=${rb.status}`)

  // (c) 走査の母集団が消えたら致命(floor)。OG ファイルが1件も無い＝Next のファイル規約変更で
  //     共有カードの配信検査が無言化した状態。0件のまま進めば「✓」と出続ける。
  const c = path.join(fixtures, 'c')
  write('c/page.tsx', '<Link href="/" aria-label="ホーム"><ArrowLeft /></Link>')
  const rc = run(c)
  if (rc.status === 1 && /OG 画像ルートを1件も抽出できない/.test(rc.stdout)) ok('配線: OG ルート0件を致命化する floor が効いている')
  else bad(`OG floor が効いていない: status=${rc.status}`)

  // (b2) Day119: リダイレクトしない普通のルートでも、自前メタが無ければ致命(Day104 起票の横断)。
  //      (b) のスタブ検知は location.replace を含む形しか見ないので、これは別枝として固定する。
  const b2 = path.join(fixtures, 'b2')
  write('b2/page.tsx', '<Link href="/" aria-label="ホーム"><ArrowLeft /></Link>')
  write('b2/opengraph-image.tsx', 'export default function OG() {}')
  write('b2/noxa/page.tsx', '"use client"\nexport default function P(){return null}')
  const rb2 = run(b2)
  if (rb2.status === 1 && /既定メタ.*\/noxa\//.test(rb2.stdout)) ok('配線: 自前メタの無い普通のルートで exit 1(既定メタの横断ガードが本体に届いている)')
  else bad(`既定メタガードが本体で効いていない: status=${rb2.status}`)

  // (b3) 対照: 同階層に自前メタの layout.tsx を置けば通ること（常に落ちる実装なら (b2) は無意味）。
  const b3 = path.join(fixtures, 'b3')
  write('b3/page.tsx', '<Link href="/" aria-label="ホーム"><ArrowLeft /></Link>')
  write('b3/opengraph-image.tsx', 'export default function OG() {}')
  write('b3/noxa/page.tsx', '"use client"\nexport default function P(){return null}')
  write('b3/noxa/layout.tsx', 'export const metadata = { title: "NOXA", description: "…" }')
  const rb3 = run(b3)
  if (!/既定メタ/.test(rb3.stdout)) ok('配線: 自前メタを持つルートは既定メタガードに引っかからない(偽陽性なし)')
  else bad('自前メタを持つルートを誤検知している')

  // (d) 負のサニティ: 正本の app/ では 3 つとも素通りし、OG 対象が `# og` 行として出ること。
  //     行が出ない＝配線が切れていても (a)(b)(c) は全部通るため、ここまで見て初めて固定になる。
  const rd = spawnSync(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--list'], { encoding: 'utf8' })
  const ogLines = rd.stdout.split('\n').filter((l) => l.startsWith('# og '))
  if (rd.status === 0 && ogLines.length >= 4 && ogLines.every((l) => l.endsWith('.png'))) {
    ok(`配線: 正本 app/ は3ガードとも素通りし、OG 対象${ogLines.length}件が拡張子つきで監視対象に出る`)
  } else bad(`正本での配線が想定外: status=${rd.status} og=${ogLines.length}`)

  fs.rmSync(fixtures, { recursive: true, force: true })
}

// ㊸ sitemap.xml の網羅性(Day107・純関数)。手書きの静的 sitemap は増えたページを取りこぼしても
//   全ルートが 200 を返すので死活監視に一生映らない(実測: `/noxa/` が丸ごと欠落)。
//   missing/stale/contradictory の3方向を押さえる。片方向だけだと逆向きの嘘が残る。
{
  const O = 'https://x.test'
  const xml = (paths) => `<urlset>${paths.map((p) => `<loc>${O}${p}</loc>`).join('')}</urlset>`
  const noindex = 'export const metadata = { robots: { index: false, follow: true } }'
  const plain = 'export default function P() {}'

  const a = findSitemapCoverageGaps(
    [{ route: '/', src: plain }, { route: '/noxa/', src: plain }], xml(['/']), O)
  if (a.missing.join() === '/noxa/' && a.stale.length === 0 && a.contradictory.length === 0) {
    ok('sitemap: 索引対象の実ルートが未掲載なら missing で指摘(本 Day が直した欠陥そのもの)')
  } else bad(`missing 判定が想定外: ${JSON.stringify(a)}`)

  const b = findSitemapCoverageGaps([{ route: '/', src: plain }], xml(['/', '/gone/']), O)
  if (b.stale.join() === '/gone/' && b.missing.length === 0) {
    ok('sitemap: 実ルートの無い loc は stale で指摘(消えたURLを索引へ差し出さない)')
  } else bad(`stale 判定が想定外: ${JSON.stringify(b)}`)

  const c = findSitemapCoverageGaps(
    [{ route: '/', src: plain }, { route: '/workspaces/', src: noindex }], xml(['/', '/workspaces/']), O)
  if (c.contradictory.join() === '/workspaces/' && c.missing.length === 0) {
    ok('sitemap: noindex なのに掲載されていれば contradictory で指摘(索引するな/しろの同時申告)')
  } else bad(`contradictory 判定が想定外: ${JSON.stringify(c)}`)

  // noindex ルートは「載っていないのが正解」＝missing に数えない(/workspaces/ が実例)。
  const d = findSitemapCoverageGaps(
    [{ route: '/', src: plain }, { route: '/workspaces/', src: noindex }], xml(['/']), O)
  if (d.missing.length === 0 && d.stale.length === 0 && d.contradictory.length === 0) {
    ok('sitemap: noindex ルートの非掲載は正常(救済スタブで false-red を出さない)')
  } else bad(`noindex ルートで誤検知: ${JSON.stringify(d)}`)

  // 別リポ配信(/egtype/)は app/ に page を持たないので stale から除く。ここを外すと
  // portal 単体では絶対に解消できない指摘で cron が毎日 red になる。
  const e = findSitemapCoverageGaps([{ route: '/', src: plain }], xml(['/', '/egtype/']), O, ['/egtype/'])
  if (e.stale.length === 0) ok('sitemap: 別リポ配信の接頭辞(/egtype/)は stale から除外する')
  else bad(`cross-repo 除外が効いていない: ${JSON.stringify(e)}`)

  // 別オリジンの loc は portal のルート集合と突合できない＝巻き込まない。
  const f = findSitemapCoverageGaps([{ route: '/', src: plain }], xml(['/']).replace('</urlset>', '<loc>https://other.test/z/</loc></urlset>'), O)
  if (f.stale.length === 0) ok('sitemap: 別オリジンの loc は突合対象外(誤って stale にしない)')
  else bad(`別オリジンを巻き込んだ: ${JSON.stringify(f)}`)

  // floor の母集団: <loc> を1件も読めない＝書式変更でガードが無言化した状態を数えられること。
  if (findSitemapCoverageGaps([{ route: '/', src: plain }], '<urlset></urlset>', O).locCount === 0) {
    ok('sitemap: <loc> の件数を数えている(0件を致命化する floor の根拠)')
  } else bad('locCount が想定外')
}

// ㊹ SW ブートストラップの巻き添え(Day107・純関数)。getRegistrations()/caches.keys() は
//   **スコープ無関係にオリジン全体**を返すため、絞らず全件 unregister/delete すると同居する
//   子アプリ(/egtype/ 等)の SW とプリキャッシュまで毎回消える。HTTP は 200 のままなので無検知。
{
  const wipeAll = "navigator.serviceWorker.getRegistrations().then(rs=>Promise.all(rs.map(r=>r.unregister()))).then(()=>caches.keys().then(ks=>Promise.all(ks.map(k=>caches.delete(k)))))"
  const scoped = "navigator.serviceWorker.getRegistrations().then(function(rs){var bad=rs.filter(function(r){return r.scope===R});return Promise.all(bad.map(function(r){return r.unregister()})).then(function(){return bad.length?caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k.indexOf('portal')===0}).map(function(k){return caches.delete(k)}))}):null})})"

  const w = findOriginWideSwWipes([{ file: 'layout.tsx', src: wipeAll }])
  if (w.offenders.length === 2 && w.scanned === 1) {
    ok('SW: 絞り込み無しの全件 unregister と全件 caches.delete を2件とも指摘(修正前の実装形)')
  } else bad(`巻き添え判定が想定外: ${JSON.stringify(w)}`)

  const g = findOriginWideSwWipes([{ file: 'layout.tsx', src: scoped }])
  if (g.offenders.length === 0 && g.scanned === 1) {
    ok('SW: filter を挟んだ形(本 Day の実装)は指摘しない(false-red を出さない)')
  } else bad(`修正形を誤検知: ${JSON.stringify(g)}`)

  // 母集団 floor: SW を触るソースが1件も無い＝ブートストラップ消失 or 記法変更。
  if (findOriginWideSwWipes([{ file: 'page.tsx', src: 'export default function P() {}' }]).scanned === 0) {
    ok('SW: 走査した母集団(scanned)を数えている(0件を致命化する floor の根拠)')
  } else bad('SW の scanned が想定外')

  // Day122: **記法の穴**。走査対象の app/layout.tsx はインライン script 文字列で ES5 の
  // `function(ks){...}` で書かれているのに、規則はアロー限定だった。同内容の全消しを
  // function 式で書くと offenders=0 になり、**守っている当のファイルの記法をガードが
  // 見ていない**状態が続いていた（scanned は 1 なので母集団 floor も満たしてしまう）。
  const wipeAllEs5 = "navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister()}))}).then(function(){return caches.keys().then(function(ks){return Promise.all(ks.map(function(k){return caches.delete(k)}))})})"
  const w5 = findOriginWideSwWipes([{ file: 'layout.tsx', src: wipeAllEs5 }])
  if (w5.offenders.length === 2 && w5.scanned === 1) {
    ok('SW: function 式で書かれた全消しもアロー版と同じく2件とも指摘する(記法で検知が消えない)')
  } else bad(`function 式の全消しを見落とす: ${JSON.stringify(w5)}`)

  // 対照: function 式でも、絞ってあれば誤検知しない（記法対応が false-red を作らないこと）。
  const scopedEs5 = "caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k.indexOf('portal-')===0}).map(function(k){return caches.delete(k)}))})"
  if (findOriginWideSwWipes([{ file: 'layout.tsx', src: scopedEs5 }]).offenders.length === 0) {
    ok('SW: function 式でも filter で絞ってあれば指摘しない(記法対応で誤検知を増やさない)')
  } else bad('function 式の絞り込み形を誤検知している')

  // 正本 app/layout.tsx を実走査して違反0件（退行の基準線）。
  // 「今たまたま違反が無い」と「見ている」は別なので、上の検知テストと必ず対で置く。
  {
    const layoutSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'layout.tsx'), 'utf8')
    const r = findOriginWideSwWipes([{ file: 'app/layout.tsx', src: layoutSrc }])
    if (r.scanned === 1 && r.offenders.length === 0) {
      ok('SW: 正本 app/layout.tsx のブートストラップはオリジン全体を巻き込まない(退行の基準線)')
    } else bad(`正本 layout.tsx が巻き添え形: ${JSON.stringify(r)}`)
  }
}

// ㊺ 配線(Day107): 純関数が正しくても本体が致命化していなければ何も守れない。
//   LINKS_SITEMAP_DIR / LINKS_SITEMAP / LINKS_SW_DIR の非破壊 override でフィクスチャを見せる。
//   --list なので実ネットワークは発生しない(両検査とも fetch より前段)。
{
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'links-d107-'))
  const write = (rel, src) => {
    const full = path.join(fx, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, src)
  }
  const run = (env) => spawnSync(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--list'],
    { encoding: 'utf8', env: { ...process.env, ...env } })
  const ORIGIN = 'https://egshugy.com'  // 正本 app/layout.tsx の metadataBase

  // (a) 索引対象の実ルートが sitemap に無ければ致命。
  write('a/page.tsx', 'export default function P() {}')
  write('a/newpage/page.tsx', 'export default function P() {}')
  write('sm-a.xml', `<urlset><loc>${ORIGIN}/</loc></urlset>`)
  const ra = run({ LINKS_SITEMAP_DIR: path.join(fx, 'a'), LINKS_SITEMAP: path.join(fx, 'sm-a.xml') })
  if (ra.status === 1 && /不整合.*\[sitemap\] \/newpage\//.test(ra.stdout)) {
    ok('配線: sitemap 未掲載の実ルートで exit 1(sitemap ガードが本体に届いている)')
  } else bad(`sitemap ガードが本体で効いていない: status=${ra.status}`)

  // (b) <loc> が1件も読めなければ致命(floor)。0件は必ず「差分なし」に見えるため。
  write('sm-b.xml', '<urlset></urlset>')
  const rb = run({ LINKS_SITEMAP_DIR: path.join(fx, 'a'), LINKS_SITEMAP: path.join(fx, 'sm-b.xml') })
  if (rb.status === 1 && /<loc> を1件も抽出できない/.test(rb.stdout)) ok('配線: sitemap の loc 0件を致命化する floor が効いている')
  else bad(`sitemap floor が効いていない: status=${rb.status}`)

  // (c) SW ブートストラップがオリジン全体を巻き込む形へ戻れば致命(＝本 Day の修正の巻き戻し)。
  write('sw/page.tsx', 'export default function P() {}')
  write('sw/layout.tsx', "const s = `navigator.serviceWorker.getRegistrations().then(rs=>Promise.all(rs.map(r=>r.unregister()))).then(()=>caches.keys().then(ks=>Promise.all(ks.map(k=>caches.delete(k)))))`")
  const rc = run({ LINKS_SW_DIR: path.join(fx, 'sw') })
  if (rc.status === 1 && /巻き添え.*SW\/SW登録/.test(rc.stdout)) ok('配線: オリジン全体を巻き込む SW ブートストラップで exit 1')
  else bad(`SW ガードが本体で効いていない: status=${rc.status}`)

  // (d) SW を触るソースが消えれば致命(floor)。/sw.js が二度と登録されない状態でもある。
  write('nosw/page.tsx', 'export default function P() {}')
  const rd = run({ LINKS_SW_DIR: path.join(fx, 'nosw') })
  if (rd.status === 1 && /SW 登録\/キャッシュを触るソースが1件も無い/.test(rd.stdout)) ok('配線: SW 母集団0件を致命化する floor が効いている')
  else bad(`SW floor が効いていない: status=${rd.status}`)

  // (e) 負のサニティ: 正本(app/ + public/sitemap.xml)は両ガードとも素通りすること。
  //     ここを見ないと (a)〜(d) は「常に落ちる実装」でも全部通る。
  const re_ = spawnSync(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--list'], { encoding: 'utf8' })
  if (re_.status === 0 && !/\[sitemap\]/.test(re_.stdout) && !/\[SW\//.test(re_.stdout)) {
    ok('配線: 正本 app/ + public/sitemap.xml は sitemap/SW ガードとも素通りする')
  } else bad(`正本で新ガードが誤検知: status=${re_.status}`)

  fs.rmSync(fx, { recursive: true, force: true })
}

// ㊻ SW の後片付けを実走で固定する(Day110・純関数)。
//   Cache Storage は**オリジン単位で共有**される。egshugy.com には子アプリが同居しており、
//   「自分の現行キャッシュ以外を消す」は絞り込みではなく**他アプリの全消し**そのもの。
{
  // 実走用の最小 SW。fetch は「自分のキャッシュ名を名乗る」ためだけに必要(所有判定の実測源)。
  const swSrc = (activateFilter, cacheName = "`${CACHE_PREFIX}v1`") => `
const CACHE_PREFIX = 'portal-'
const CACHE_NAME = ${cacheName}
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((key) => ${activateFilter}).map((key) => caches.delete(key)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request).then((r) => {
    const c = r.clone(); caches.open(CACHE_NAME).then((x) => x.put(event.request, c)).catch(() => {}); return r
  }).catch(() => caches.match(event.request)))
})`
  const O = 'https://egshugy.com'
  const FOREIGN = ['egtype-vX', 'pekarin-chinchiro-vX', 'word-wolf-vX', 'kingscup-vX']
  const sim = (src) => simulateSwActivate(src, { origin: O, foreignKeys: FOREIGN })

  // (a) 修正前の形。filter はあるが「自分の現行以外」＝同居アプリを全部消す。
  const a = await sim(swSrc('key !== CACHE_NAME'))
  if (a.foreignDeleted.length === FOREIGN.length) {
    ok('SW実走: 「現行以外を全消し」は同居アプリのキャッシュを全件削除する(修正前の実害を実測で再現)')
  } else bad(`巻き添えを再現できない: ${JSON.stringify(a)}`)

  // (b) 本 Day の修正形。自分の旧版だけ消し、他アプリには触らない。
  const b = await sim(swSrc('key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME'))
  if (b.foreignDeleted.length === 0 && b.deleted.includes(b.ownStaleKey)) {
    ok('SW実走: 所有接頭辞で絞れば他アプリは無傷・自分の旧版だけ消える(修正形)')
  } else bad(`修正形の実走が想定外: ${JSON.stringify(b)}`)

  // (c) 下限。何も消さない no-op へ退化しても「他人を消していない」は満たされるので、
  //     自分の旧版を消せることまで要求しないとガードが空洞になる。
  const c = await sim(swSrc('false'))
  if (c.foreignDeleted.length === 0 && !c.deleted.includes(c.ownStaleKey)) {
    ok('SW実走: no-op へ退化した activate を「旧版を消さない」として区別できる(空洞化の下限)')
  } else bad(`no-op 退化を区別できない: ${JSON.stringify(c)}`)

  // (d) 所有判定は**ソースを読まず** fetch の保存先から実測する＝定数名や記法に依存しない。
  const d = await sim(swSrc('key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME').replace(/CACHE_PREFIX/g, 'P').replace(/CACHE_NAME/g, 'N'))
  if (d.cacheName === 'portal-v1' && d.ownPrefix === 'portal-' && d.foreignDeleted.length === 0) {
    ok('SW実走: 自分のキャッシュ名を caches.open() の実測で特定する(識別子を変えても追随する)')
  } else bad(`所有判定が実測になっていない: ${JSON.stringify(d)}`)

  // (e) 区切りの無い名前は所有が判定不能＝安全な後片付けが原理的に書けない。
  if (ownPrefixOf('portal-v1') === 'portal-' && ownPrefixOf('portalv1') === null && ownPrefixOf('-v1') === null) {
    ok('SW実走: 接頭辞の区切りが無いキャッシュ名を「所有判定不能」として弾く')
  } else bad(`ownPrefixOf が想定外: ${ownPrefixOf('portalv1')}`)

  // (f) 母集団 floor: activate / fetch が消えれば検査は空振りする。その状態を数えられること。
  const f = await sim("self.addEventListener('install', () => self.skipWaiting())")
  if (f.hasActivate === false && f.hasFetch === false && f.cacheName === null) {
    ok('SW実走: activate/fetch の有無を数えている(0件を致命化する floor の根拠)')
  } else bad(`floor の根拠が取れていない: ${JSON.stringify(f)}`)
}

// ㊾ SW のオフライン応答が**どのキャッシュから**返るか(Day122・実走)。
//   Day107/110/112 は delete と unregister の範囲を三度絞ったが、**読み出しの範囲**は
//   一度も見ていなかった。無名の `caches.match(request)` は Cache Storage を**オリジン全体**
//   から探すので、同居する子アプリや、救済対象の端末に残った他所製 SW の孤児キャッシュが
//   同じ URL(例 `/`)を持っていれば、それが portal の応答として返る。
//   静的検査では「match しているか」しか見えないので、activate と同じく実走で出所を測る。
{
  const O = 'https://egshugy.com'
  const swPath = path.join(__dirname, '..', 'public', 'sw.js')
  const src = fs.readFileSync(swPath, 'utf8')

  // (a) 正本。オフライン時のフォールバックは自分のキャッシュからしか取らない。
  const own = await simulateSwOfflineFallback(src, { origin: O })
  if (own.source === 'portal-v1') {
    ok('SW実走: オフライン応答は自分のキャッシュ(portal-v1)からだけ取る(他所の応答を返さない)')
  } else bad(`フォールバックの出所が想定外: ${JSON.stringify(own)}`)

  // (b) 負の対照。無名 match に戻すと**オリジン全体**から取る形になることを実測で示す
  //     （「自分のキャッシュから取れている」が偶然でないことの裏取り＝空洞化の下限）。
  const wide = await simulateSwOfflineFallback(src.replace('caches.open(CACHE_NAME).then((cache) => cache.match(event.request))', 'caches.match(event.request)'), { origin: O })
  if (wide.source === 'origin-wide') {
    ok('SW実走: 無名 caches.match はオリジン全体から取る形として区別できる(修正前の経路を再現)')
  } else bad(`修正前の形を区別できない: ${JSON.stringify(wide)}`)

  // (c) フォールバックそのものが消えた退化を「自分のキャッシュから取れている」と混同しない。
  //     (正本を機械的に削るとソースが壊れて別の失敗になるので、最小の SW を書いて測る)
  const noFallbackSw = `const CACHE_NAME='portal-v1'
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  event.respondWith(fetch(event.request))
})`
  const none = await simulateSwOfflineFallback(noFallbackSw, { origin: O })
  if (none.source === 'none') {
    ok('SW実走: フォールバックが無い形は none として区別できる(オフライン能力の退化を見逃さない)')
  } else bad(`フォールバック消失を区別できない: ${JSON.stringify(none)}`)
}

// ㊼ SW 実走ガードの配線(Day110)。純関数が正しくても本体が致命化していなければ何も守れない。
//   LINKS_SW_FILE の非破壊 override でフィクスチャを見せる(--list なので実ネットワーク無し)。
{
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'links-d110-'))
  const swFile = (name, src) => { const p = path.join(fx, name); fs.writeFileSync(p, src); return p }
  const run = (env) => spawnSync(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--list'],
    { encoding: 'utf8', env: { ...process.env, ...env } })
  const base = fs.readFileSync(path.join(__dirname, '..', 'public/sw.js'), 'utf8')

  // (a) 静的規則: 反転形(現行以外を全消し)は書き方の段で捕まる＝Day107 の規則の穴を塞いだ分。
  const ra = run({ LINKS_SW_FILE: swFile('inverted.js', base.replace('key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME', 'key !== CACHE_NAME')) })
  if (ra.status === 1 && /巻き添え.*SW\/キャッシュ.*現行キャッシュ以外/.test(ra.stdout)) {
    ok('配線: 「現行以外を全消し」の反転形で exit 1(Day107 の静的規則が白と読んでいた形)')
  } else bad(`反転形の静的検知が本体で効いていない: status=${ra.status}`)

  // (b) 実走ガード: 静的規則が原理的に見抜けない形(filter のコールバックを変数へ切り出す)。
  //     ここが落ちないなら実走ガードは静的規則の重複でしかなく、置く意味が無い。
  const indirect = base
    .replace('const CACHE_NAME = `${CACHE_PREFIX}v1`', 'const CACHE_NAME = `${CACHE_PREFIX}v1`\nconst isStale = (key) => key !== CACHE_NAME')
    .replace('.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)', '.filter(isStale)')
  const rb = run({ LINKS_SW_FILE: swFile('indirect.js', indirect) })
  if (rb.status === 1 && /SW実走.*同居アプリのキャッシュを削除/.test(rb.stdout)) {
    ok('配線: 静的規則では見抜けない間接形(filter を変数へ)を実走ガードが捕まえる')
  } else bad(`実走ガードが本体で効いていない: status=${rb.status} / ${rb.stdout.slice(-400)}`)

  // (c) 下限の配線: no-op 退化で exit 1。
  const rc = run({ LINKS_SW_FILE: swFile('noop.js', base.replace('key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME', 'false')) })
  if (rc.status === 1 && /SW実走.*旧版キャッシュ.*消さない/.test(rc.stdout)) ok('配線: activate の no-op 退化で exit 1(後片付けの下限)')
  else bad(`no-op 下限が本体で効いていない: status=${rc.status}`)

  // (d) 所有判定不能(接頭辞の区切り無し)で exit 1。
  const rd = run({ LINKS_SW_FILE: swFile('noprefix.js', base.replace("const CACHE_PREFIX = 'portal-'", "const CACHE_PREFIX = ''").replace('`${CACHE_PREFIX}v1`', "'portalv1'")) })
  if (rd.status === 1 && /SW実走.*接頭辞の区切りが無い/.test(rd.stdout)) ok('配線: 所有を名前で判定できないキャッシュ名で exit 1')
  else bad(`所有判定 floor が本体で効いていない: status=${rd.status}`)

  // (e) SW 本体が消えれば exit 1(配信されている /sw.js の実体が無くなった状態)。
  const re_ = run({ LINKS_SW_FILE: path.join(fx, 'missing.js') })
  if (re_.status === 1 && /SW 本体が見つからない/.test(re_.stdout)) ok('配線: SW 本体の欠落を致命化する floor が効いている')
  else bad(`SW 本体欠落の floor が効いていない: status=${re_.status}`)

  // (f) 負のサニティ: 正本 public/sw.js は静的・実走の両ガードとも素通りすること。
  //     ここを見ないと (a)〜(e) は「常に落ちる実装」でも全部通る。
  const rf = spawnSync(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--list'], { encoding: 'utf8' })
  if (rf.status === 0 && !/\[SW実走\]/.test(rf.stdout) && !/\[SW\//.test(rf.stdout)) {
    ok('配線: 正本 public/sw.js は静的・実走の両 SW ガードとも素通りする')
  } else bad(`正本で SW ガードが誤検知: status=${rf.status}`)

  fs.rmSync(fx, { recursive: true, force: true })
}



// ㊾ robots.txt の Sitemap 宣言 ⇔ 実体(Day110)。
//   Day107 は sitemap.xml の中身を固定したが、その sitemap への**入口**である robots.txt の
//   Sitemap 行は誰も検査していなかった。宣言も実体も 200 を返しうるので HTTP 検査では映らない。
{
  const O = 'https://egshugy.com'
  const opts = (paths) => ({ origin: O, publicSitemapPaths: paths, crossRepoPrefixes: ['/egtype/'] })
  const good = `User-agent: *\nAllow: /\n\nSitemap: ${O}/sitemap.xml\nSitemap: ${O}/egtype/sitemap.xml\n`

  const r1 = findRobotsSitemapIssues(good, opts(['/sitemap.xml']))
  if (r1.issues.length === 0 && r1.declared.length === 2) {
    ok('robots: 正本の形(自前1件 + 別リポ配信1件)は不整合0件・宣言2件を抽出')
  } else bad(`正本形で誤検知: ${JSON.stringify(r1)}`)

  // 宣言だけあって実体が無い＝誰も出力しない sitemap を入口として出し続ける。
  const r2 = findRobotsSitemapIssues(`Sitemap: ${O}/sitemap.xml\nSitemap: ${O}/nope.xml\n`, opts(['/sitemap.xml']))
  if (r2.issues.length === 1 && r2.issues[0].kind === '実体なし' && r2.issues[0].url.endsWith('/nope.xml')) {
    ok('robots: 実体の無い Sitemap 宣言を検出')
  } else bad(`実体なしを検出できない: ${JSON.stringify(r2.issues)}`)

  // 逆方向: 実体はあるのに申告していない＝クローラへの発見経路が1本減る。
  const r3 = findRobotsSitemapIssues(`Sitemap: ${O}/sitemap.xml\n`, opts(['/sitemap.xml', '/sitemap-news.xml']))
  if (r3.issues.length === 1 && r3.issues[0].kind === '未宣言' && r3.issues[0].url.endsWith('/sitemap-news.xml')) {
    ok('robots: 実在するのに未申告の sitemap を検出(双方向)')
  } else bad(`未宣言を検出できない: ${JSON.stringify(r3.issues)}`)

  // 別オリジン/相対URL は robots.txt の仕様上クロールに使われない＝申告した気になるだけ。
  const r4 = findRobotsSitemapIssues(`Sitemap: https://example.com/sitemap.xml\nSitemap: /sitemap.xml\n`, opts(['/sitemap.xml']))
  const kinds = r4.issues.map((i) => i.kind).sort()
  if (kinds.join(',') === '不正,別オリジン,未宣言') {
    ok('robots: 別オリジン宣言と相対URL宣言を無効として指摘し、自前の未申告も同時に出す')
  } else bad(`別オリジン/不正の扱いが想定外: ${JSON.stringify(kinds)}`)

  // 別リポ配信(/egtype/)は portal のリポに実体を持たないので実在検査から外す(soft の HTTP 側で見る)。
  const r5 = findRobotsSitemapIssues(`Sitemap: ${O}/sitemap.xml\nSitemap: ${O}/egtype/sitemap.xml\n`, opts(['/sitemap.xml']))
  if (r5.issues.length === 0) ok('robots: 別リポ配信の宣言をリポ内実在検査の対象にしない(false-red を出さない)')
  else bad(`cross-repo を誤検知: ${JSON.stringify(r5.issues)}`)

  // 書式の揺れ(小文字・前後の空白)でも拾えること。拾えないと floor が「宣言0件」で
  // 落ちるだけになり、実際の不整合は永久に見えない。
  const r6 = findRobotsSitemapIssues(`  sitemap :  ${O}/sitemap.xml  \n`, opts(['/sitemap.xml']))
  if (r6.declared.length === 1) ok('robots: 大文字小文字と前後空白の揺れを許容して宣言を抽出')
  else bad(`書式の揺れを取りこぼす: ${JSON.stringify(r6.declared)}`)
}

// ㊿ 本番で「実際に配信されている」robots.txt(Day110)。
//   実測: 本番 robots.txt は 1949B でリポ(113B)と別物。Cloudflare の Managed content が前置され、
//   リポ由来の行は後ろに残る。前置側は portal のリポの外で変わるので、リポの突合だけでは
//   本番の中身を保証できない。200 は返るため res.ok しか見ない検査には一生映らない。
{
  const O = 'https://egshugy.com'
  const declared = [`${O}/sitemap.xml`, `${O}/egtype/sitemap.xml`]
  const served = (body, status = 200) => classifyServedRobots({ status, body }, declared)

  const okBody = `User-agent: *\nAllow: /\n\nSitemap: ${O}/sitemap.xml\nSitemap: ${O}/egtype/sitemap.xml\n`
  if (served(okBody).verdict === 'ok') ok('robots実配信: 宣言が全て本番にも実在すれば ok')
  else bad(`正常形の判定が想定外: ${JSON.stringify(served(okBody))}`)

  // 最大の実害: サイト全体が検索結果から消える。
  const v1 = served(`User-agent: *\nDisallow: /\n\nSitemap: ${O}/sitemap.xml\nSitemap: ${O}/egtype/sitemap.xml\n`)
  if (v1.verdict === 'blocks-all') ok('robots実配信: User-agent: * の Disallow: / を全面拒否として検出')
  else bad(`全面拒否を検出できない: ${JSON.stringify(v1)}`)

  // 部分的な禁止(/admin 等)は正常運用。ここを落とすと false-red で監視が信用されなくなる。
  const v2 = served(`User-agent: *\nDisallow: /admin\nAllow: /\n\nSitemap: ${O}/sitemap.xml\nSitemap: ${O}/egtype/sitemap.xml\n`)
  if (v2.verdict === 'ok') ok('robots実配信: 部分的な Disallow(/admin) は全面拒否と混同しない')
  else bad(`部分 Disallow を誤検知: ${JSON.stringify(v2)}`)

  // 実測の本番形(Cloudflare Managed content が前置され、他 UA だけが Disallow: /)。
  // ここを blocks-all と読むと本番が毎日 red になる＝この検査自体が捨てられる。
  const cf = `# BEGIN Cloudflare Managed content\nUser-agent: *\nContent-Signal: search=yes,ai-train=no\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: CCBot\nDisallow: /\n# END Cloudflare Managed Content\n\nUser-agent: *\nAllow: /\n\nSitemap: ${O}/sitemap.xml\nSitemap: ${O}/egtype/sitemap.xml\n`
  if (served(cf).verdict === 'ok') ok('robots実配信: 実測の本番形(CF前置・AI クローラのみ Disallow)を ok と読む')
  else bad(`実測の本番形を誤検知: ${JSON.stringify(served(cf))}`)

  // 宣言はあるのに配信物には1行も無い＝デプロイでは説明できない(デプロイすれば必ず出る)。
  const v3 = served('User-agent: *\nAllow: /\n')
  if (v3.verdict === 'no-sitemap') ok('robots実配信: 申告が配信物から丸ごと消えている状態を致命として区別')
  else bad(`申告消失を検出できない: ${JSON.stringify(v3)}`)

  // 一部だけ未反映は人間ゲートのデプロイ待ちで説明できる＝警告に留める。
  const v4 = served(`User-agent: *\nAllow: /\nSitemap: ${O}/sitemap.xml\n`)
  if (v4.verdict === 'pending-deploy' && v4.missingOnProd.length === 1) {
    ok('robots実配信: 一部だけ未反映はデプロイ待ちとして致命にしない')
  } else bad(`未反映の扱いが想定外: ${JSON.stringify(v4)}`)

  if (served('', 404).verdict === 'unreachable') ok('robots実配信: 非200 は unreachable')
  else bad('非200 の扱いが想定外')

  // グループ解析の下限: 連続する User-agent 行は同一グループを共有する(RFC 9309)。
  // ここが崩れると「*, GPTBot に続く Disallow: /」を * の全面拒否と読み違える/読み落とす。
  const g = parseRobotsGroups('User-agent: *\nUser-agent: GPTBot\nDisallow: /\n')
  if (g.length === 1 && g[0].agents.length === 2 && g[0].rules.length === 1) {
    ok('robots解析: 連続する User-agent 行を同一グループとして扱う')
  } else bad(`グループ解析が想定外: ${JSON.stringify(g)}`)
  const g2 = parseRobotsGroups('# Disallow: /\nUser-agent: *\nAllow: / # 末尾コメント\n')
  if (g2.length === 1 && g2[0].rules.length === 1 && g2[0].rules[0].field === 'allow') {
    ok('robots解析: コメントを除去してから解釈する(コメント内の Disallow を規則と誤読しない)')
  } else bad(`コメント処理が想定外: ${JSON.stringify(g2)}`)
  // Sitemap はグループ非依存(RFC 9309 §2.2.3)。直前の User-agent の規則へ混ぜると
  // 「そのエージェントへの指示」の集合が実態より多くなる。
  const g3 = parseRobotsGroups(`User-agent: *\nAllow: /\nSitemap: ${O}/sitemap.xml\n`)
  if (g3.length === 1 && g3[0].rules.length === 1 && g3[0].rules[0].field === 'allow') {
    ok('robots解析: Sitemap をグループ規則へ混ぜない(非グループディレクティブ)')
  } else bad(`Sitemap がグループ規則に混入: ${JSON.stringify(g3)}`)
}

// 51 fetchWithRetry の本文取得(Day110)。robots の中身検査はここに依存する。
{
  const res200 = { status: 200, ok: true, headers: { get: () => 'text/plain' }, text: async () => 'BODY' }
  const withBody = await fetchWithRetry('u', { fetchImpl: async () => res200, sleep: noSleep, wantBody: true })
  const noBody = await fetchWithRetry('u', { fetchImpl: async () => res200, sleep: noSleep })
  if (withBody.body === 'BODY' && noBody.body === undefined) {
    ok('fetch: wantBody 指定時だけ本文を返す(90件の死活監視は従来どおりヘッダのみ)')
  } else bad(`wantBody の挙動が想定外: ${JSON.stringify([withBody.body, noBody.body])}`)
}

// 52 配線(Day110): 純関数が正しくても本体が致命化していなければ何も守れない。
//   LINKS_ROBOTS / LINKS_PUBLIC_DIR の非破壊 override でフィクスチャを見せる。
//   --list なので実ネットワークは発生しない(robots の実配信検査は fetch 段＝--list より後)。
{
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'links-d110-'))
  const write = (rel, src) => {
    const full = path.join(fx, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, src)
    return full
  }
  const run = (env) => spawnSync(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--list'],
    { encoding: 'utf8', env: { ...process.env, ...env } })
  const O = 'https://egshugy.com'  // 正本 app/layout.tsx の metadataBase

  // (a) 実体の無い sitemap を申告していれば致命。
  const rA = run({ LINKS_ROBOTS: write('robots-a.txt', `User-agent: *\nAllow: /\nSitemap: ${O}/sitemap.xml\nSitemap: ${O}/nope.xml\n`) })
  if (rA.status === 1 && /実体なし\s+\[robots\].*nope\.xml/.test(rA.stdout)) {
    ok('配線: 実体の無い Sitemap 宣言で exit 1(robots ガードが本体に届いている)')
  } else bad(`robots ガードが本体で効いていない: status=${rA.status}`)

  // (b) 宣言が1行も読めなければ致命(floor)。0件は必ず「不整合なし」に見え、
  //     同時に監視対象化(クロール入口)も無言で消える。
  const rB = run({ LINKS_ROBOTS: write('robots-b.txt', 'User-agent: *\nAllow: /\n') })
  if (rB.status === 1 && /Sitemap 宣言を1件も抽出できない/.test(rB.stdout)) ok('配線: robots の Sitemap 宣言0件を致命化する floor が効いている')
  else bad(`宣言0件 floor が効いていない: status=${rB.status}`)

  // (c) public/ から sitemap の実体を1件も導けなければ致命(floor)。走査の失敗が
  //     「申告漏れ無し」と同じ結末へ潰れる形(Day108 の「正常な空と壊れた空」)。
  fs.mkdirSync(path.join(fx, 'emptypub'), { recursive: true })
  const rC = run({ LINKS_PUBLIC_DIR: path.join(fx, 'emptypub') })
  if (rC.status === 1 && /sitemap の実体が1件も無い/.test(rC.stdout)) ok('配線: public/ の sitemap 実体0件を致命化する floor が効いている')
  else bad(`実体0件 floor が効いていない: status=${rC.status}`)

  // (d) 監視対象化の配線: 申告した入口が実際に死活監視へ載り、owner 由来で致命度が割れること。
  //     Day109 までは robots.txt も sitemap.xml も監視90件に1件も入っていなかった(実測)。
  const rD = run({})
  const entries = rD.stdout.split('\n').filter((l) => l.includes('\tクロール入口\t'))
  const hardOwn = entries.filter((l) => l.startsWith('hard\t') && l.includes('\tportal'))
  const softCross = entries.filter((l) => l.startsWith('soft\t') && l.includes('\tegtype'))
  if (entries.length >= 3 && hardOwn.length === 2 && softCross.length === 1
      && entries.some((l) => l.includes(`${O}/robots.txt`))) {
    ok('配線: robots.txt と申告された sitemap が監視対象に載り、portal自前=hard / egtype配信=soft に割れる')
  } else bad(`クロール入口の監視対象化が想定外: ${JSON.stringify(entries)}`)

  // (e) 負のサニティ: 正本(public/robots.txt + public/)は素通りすること。
  //     ここを見ないと (a)〜(c) は「常に落ちる実装」でも全部通る。
  if (rD.status === 0 && !/\[robots\]/.test(rD.stdout)) ok('配線: 正本 public/robots.txt は robots ガードを素通りする')
  else bad(`正本で robots ガードが誤検知: status=${rD.status}`)

  fs.rmSync(fx, { recursive: true, force: true })
}

// 53 本番で「実際に配信されている」sitemap.xml(Day113)。
//   Day107 は sitemap の中身を、Day110 はその入口(robots.txt)を固定したが、どちらも**リポの中身**。
//   実測(Day113): 本番 /sitemap.xml の <loc> は3件で、リポにある /noxa/ が無い(Day107 の修正が未反映)。
//   これは「壊れている」ではなく「まだ届いていない」なので警告に留め、デプロイ遅れでは説明できない
//   状態(取得不能/HTML/空/別オリジン)だけを致命にする——ここを混ぜると毎日 red になり検査ごと捨てられる。
{
  const O = 'https://egshugy.com'
  const repoLocs = [`${O}/`, `${O}/noxa/`, `${O}/stamps/`, `${O}/egtype/`]
  const xml = (locs) => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>${locs.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`
  const served = (body, status = 200) => classifyServedSitemap({ status, body }, { repoLocs, origin: O })

  if (served(xml(repoLocs)).verdict === 'ok') ok('配信sitemap: リポと本番が一致すれば ok')
  else bad(`正常形の判定が想定外: ${JSON.stringify(served(xml(repoLocs)))}`)

  // 実測されている状態。デプロイ待ちで説明がつくので致命にしない。
  const v1 = served(xml([`${O}/`, `${O}/stamps/`, `${O}/egtype/`]))
  if (v1.verdict === 'pending-deploy' && v1.missingOnProd.length === 1 && v1.missingOnProd[0] === `${O}/noxa/`
      && !isServedSitemapFatal(v1.verdict)) {
    ok('配信sitemap: リポにあって本番に無い loc はデプロイ待ち(警告)として名指しする')
  } else bad(`デプロイ遅れの判定が想定外: ${JSON.stringify(v1)}`)

  // 逆向き(本番にあってリポに無い)も配信が古いだけなので致命にしない。
  const v2 = served(xml([...repoLocs, `${O}/old/`]))
  if (v2.verdict === 'ok' && !isServedSitemapFatal(v2.verdict)) {
    ok('配信sitemap: 本番にだけ残る loc は致命にしない(古い配信で説明がつく)')
  } else bad(`本番にだけある loc の判定が想定外: ${JSON.stringify(v2)}`)

  // ここから下は「配信側が壊している」＝デプロイ遅れでは説明できない形。
  const v3 = served('', 404)
  if (v3.verdict === 'unreachable' && isServedSitemapFatal(v3.verdict)) {
    ok('配信sitemap: 申告した入口が本番で取得できない(404)を致命として検出')
  } else bad(`取得不能の判定が想定外: ${JSON.stringify(v3)}`)

  // SPA フォールバックが拡張子付き URL まで飲み込むと 200 で HTML が返る(クローラは読めない)。
  const v4 = served('<!doctype html>\n<html lang="ja"><body>portal</body></html>')
  if (v4.verdict === 'not-xml' && isServedSitemapFatal(v4.verdict)) {
    ok('配信sitemap: 200 だが HTML が返る形(SPAフォールバック)を致命として検出')
  } else bad(`HTML フォールバックの判定が想定外: ${JSON.stringify(v4)}`)

  const v5 = served('<?xml version="1.0"?>\n<urlset></urlset>')
  if (v5.verdict === 'empty' && isServedSitemapFatal(v5.verdict)) {
    ok('配信sitemap: 200 だが <loc> が1件も無い形を致命として検出')
  } else bad(`空 sitemap の判定が想定外: ${JSON.stringify(v5)}`)

  const v6 = served(xml([`${O}/`, 'https://evil.example.com/']))
  if (v6.verdict === 'foreign' && v6.foreign.length === 1 && isServedSitemapFatal(v6.verdict)) {
    ok('配信sitemap: 自オリジン外の loc が混ざる形を致命として検出')
  } else bad(`別オリジンの判定が想定外: ${JSON.stringify(v6)}`)

  // 別リポ配信(/egtype/)は自オリジン内なので foreign ではない。ここを落とすと常時 red になる。
  const v7 = classifyServedSitemap({ status: 200, body: xml([`${O}/egtype/`, `${O}/egtype/blog/`]) },
    { repoLocs: [], origin: O })
  if (v7.verdict === 'ok') ok('配信sitemap: 同一オリジンの別リポ配信(/egtype/)は foreign にしない')
  else bad(`別リポ配信の判定が想定外: ${JSON.stringify(v7)}`)

  // 検知規則そのものの固定: 致命の集合が空へ退化すると、以降どんな壊れ方も警告止まりになる。
  const fatalKinds = ['unreachable', 'not-xml', 'empty', 'foreign'].filter(isServedSitemapFatal)
  const softKinds = ['pending-deploy', 'ok'].filter(isServedSitemapFatal)
  if (fatalKinds.length === 4 && softKinds.length === 0) ok('配信sitemap: 致命/警告の振り分けが規則として固定されている')
  else bad(`致命判定の集合が想定外: fatal=${JSON.stringify(fatalKinds)} soft=${JSON.stringify(softKinds)}`)
}

// 55 a11y 走査の母集団に components/ を含める(Day113)。
//   Day104 のガードは app/ だけを見ていたが、実測では画面の実体は components/ 側に多く
//   (featured-apps / footer / links-section 等)、アイコンだけのリンク/ボタンが最も生えやすいのも
//   そちら。現時点の指摘は0件だが「今たまたま違反が無い」と「見ている」は別で、
//   母集団に入っていない限り退行は永久に検知されない。
{
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'links-a11y-'))
  const write = (rel, src) => {
    const full = path.join(fx, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, src)
    return path.dirname(full)
  }
  const run = (env) => spawnSync(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--list'],
    { encoding: 'utf8', env: { ...process.env, ...env } })

  // (a) components/ に名前なしアイコンリンクを置くと落ちること（app/ は正本のまま）。
  const badDir = write('bad/widget.tsx',
    'export default function W() {\n  return <button onClick={x}><Icon className="w-4" /></button>\n}\n')
  const rA = run({ LINKS_COMPONENTS_DIR: badDir })
  if (rA.status === 1 && /名前なし\s+\[a11y\] components\/widget\.tsx/.test(rA.stdout)) {
    ok('a11y: components/ の名前なしアイコンボタンを検出して exit 1(Day104 は app/ しか見ていなかった)')
  } else bad(`components/ の a11y 違反が素通り: status=${rA.status}`)

  // (b) 名前があれば落ちないこと（過剰検知だと components を母集団に入れた瞬間に常時 red）。
  const okDir = write('good/widget.tsx',
    'export default function W() {\n  return <button aria-label="閉じる"><Icon className="w-4" /></button>\n}\n')
  const rB = run({ LINKS_COMPONENTS_DIR: okDir })
  if (rB.status === 0 && !/\[a11y\]/.test(rB.stdout)) {
    ok('a11y: aria-label があれば components/ でも素通りする(偽陽性なし)')
  } else bad(`名前ありの components/ で誤検知: status=${rB.status}`)

  // (c) 正本の components/ が現時点で違反ゼロであることを固定（退行の基準線）。
  const rC = run({})
  if (rC.status === 0 && !/\[a11y\]/.test(rC.stdout)) ok('a11y: 正本の app/ と components/ は違反ゼロ')
  else bad(`正本で a11y 違反: status=${rC.status}`)

  fs.rmSync(fx, { recursive: true, force: true })
}

// 54 配線(Day113): **本番配信を見る段**が本体に届いているか。
//   既存の配線ガードは全て `--list` で走らせており、`--list` は fetch より前に exit する。
//   つまり Day110 の「配信 robots.txt」と本日の「配信 sitemap.xml」は、純関数のテストはあっても
//   **本体で致命化されているかを誰も見ていなかった**（純関数を呼び忘れても・呼んで結果を捨てても
//   永久に緑）。ローカルの HTTP サーバを立てて `--base` で向け、実際の fetch 段を通して固定する。
{
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'links-d113-'))
  const write = (rel, src) => {
    const full = path.join(fx, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, src)
    return full
  }
  const O = 'https://egshugy.com'  // 正本 app/layout.tsx の metadataBase（申告はこの origin で書く）
  const REPO_LOCS = [`${O}/`, `${O}/stamps/`]
  const sitemapXml = (locs) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>${locs.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`
  const robotsTxt = `User-agent: *\nAllow: /\nSitemap: ${O}/sitemap.xml\n`
  const publicDir = path.join(fx, 'public')
  fs.mkdirSync(publicDir, { recursive: true })
  fs.writeFileSync(path.join(publicDir, 'sitemap.xml'), sitemapXml(REPO_LOCS))

  // 配信側の応答を差し替えられるローカルサーバ。既定は「全部 200・正常」で、
  // 検査したい1本だけを壊す（他の段の失敗が混ざると、何を証明したのか読めなくなるため）。
  let serve = {}
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0]
    const custom = serve[url]
    if (custom) {
      res.writeHead(custom.status ?? 200, { 'content-type': custom.type ?? 'text/plain; charset=utf-8' })
      res.end(custom.body ?? '')
      return
    }
    if (url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end(robotsTxt); return
    }
    if (url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' }); res.end(sitemapXml(REPO_LOCS)); return
    }
    // OG は画像として配信されていること（型なしだと別の段が致命化して原因が読めなくなる）
    if (/opengraph-image|twitter-image|\.png$/.test(url)) {
      res.writeHead(200, { 'content-type': 'image/png' }); res.end('x'); return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html><body>ok</body></html>')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const BASE = `http://127.0.0.1:${server.address().port}`
  // **spawnSync は使えない**: 同期 spawn はイベントループを止めるので、同じプロセスで動く
  // このローカルサーバが応答できず、check-links 側の fetch が待ち続ける（実際に最初そうなった）。
  // 非同期 spawn にして、子プロセスの実行中もサーバが応答できるようにする。
  const run = (env = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--base', BASE],
      { env: { ...process.env, LINKS_ROBOTS: write('robots.txt', robotsTxt), LINKS_PUBLIC_DIR: publicDir, ...env } })
    let stdout = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stdout += d })
    child.on('close', (status) => resolve({ status, stdout }))
  })

  // (a) 偽陽性の対照を先に置く。ここが赤いと以下の (b)(c) は「常に落ちる実装」でも通ってしまう。
  serve = {}
  const rOk = await run()
  if (!/\[配信sitemap\]/.test(rOk.stdout) && !/\[robots\]/.test(rOk.stdout)) {
    ok('配線: 配信物が正常なら配信 sitemap/robots の段は何も言わない(偽陽性なし)')
  } else bad(`正常な配信で誤検知: ${rOk.stdout.split('\n').filter((l) => /配信sitemap|\[robots\]/.test(l)).join(' / ')}`)

  // (b) 200 だが HTML（SPA フォールバック）＝クローラは sitemap として読めない。
  serve = { '/sitemap.xml': { type: 'text/html', body: '<!doctype html><html><body>portal</body></html>' } }
  const rHtml = await run()
  if (rHtml.status === 1 && /✗ not-xml\s+\[配信sitemap\]/.test(rHtml.stdout)) {
    ok('配線: 配信 sitemap が HTML を返す形で exit 1(本番配信の検査が本体に届いている)')
  } else bad(`配信 sitemap ガードが本体で効いていない: status=${rHtml.status}`)

  // (c) 申告した入口が本番で死んでいる（robots.txt は生きているのに sitemap だけ 404）。
  serve = { '/sitemap.xml': { status: 404, body: 'not found' } }
  const r404 = await run()
  if (r404.status === 1 && /✗ unreachable\s+\[配信sitemap\]/.test(r404.stdout)) {
    ok('配線: 申告した sitemap が本番で 404 なら exit 1')
  } else bad(`404 の配信 sitemap が致命化されていない: status=${r404.status}`)

  // (d) デプロイ遅れ（リポにあって本番に無い）は警告に留まり exit 0 のままであること。
  //     ここを致命にすると人間ゲートのデプロイ待ちで毎日 red になり、検査ごと捨てられる。
  //     判定は status ではなく**この段が致命に寄与していないこと**で見る。check-links は外部
  //     ドメイン(gtag 等)も叩くので、実測でそこが一時的に落ちると status が 1 になり、
  //     本題と無関係な理由でこのケースだけが赤くなる（実際に一度そうなった）。
  serve = { '/sitemap.xml': { type: 'application/xml', body: sitemapXml([`${O}/`]) } }
  const rPending = await run()
  const pendingNoted = /ⓘ 配信sitemap .*本番の sitemap に無い/.test(rPending.stdout)
  const sitemapBlamed = /✗ \S+\s+\[配信sitemap\]/.test(rPending.stdout) || /致命.*配信sitemap/.test(rPending.stdout)
  if (pendingNoted && !sitemapBlamed) {
    ok('配線: リポにあって本番に無い loc は警告に留まり致命の理由にならない(デプロイ待ちで false-red にしない)')
  } else bad(`デプロイ待ちの扱いが想定外: pending=${pendingNoted} blamed=${sitemapBlamed}`)

  // (e) Day110 の配信 robots も同じ理由で未配線だった。全面拒否が致命化されることを固定する。
  serve = { '/robots.txt': { body: `User-agent: *\nDisallow: /\nSitemap: ${O}/sitemap.xml\n` } }
  const rBlock = await run()
  if (rBlock.status === 1 && /✗ 全面拒否\s+\[robots\]/.test(rBlock.stdout)) {
    ok('配線: 配信 robots.txt の全面拒否で exit 1(Day110 の段も本体に届いている)')
  } else bad(`配信 robots ガードが本体で効いていない: status=${rBlock.status}`)

  // (f) floor: 自オリジンの sitemap 申告が0件なら、この段は何も検査していない。
  //     実測: 現在の規約では**上の静的 robots 段が先に落とす**（別オリジンだけの宣言は
  //     「別オリジン」不整合、宣言0件は Day110 の floor）。この段の floor はそこへ到達しないが、
  //     前段がゆるめられたときに**この段だけ無言で空になる**のを防ぐ保険として残している。
  //     ここで固定するのは「母集団が空になる入力は、どの層かはともかく必ず exit 1 になる」こと。
  serve = {}
  const rFloor = await run({ LINKS_ROBOTS: write('robots-nosm.txt', `User-agent: *\nAllow: /\nSitemap: https://other.example.com/sitemap.xml\n`) })
  const floorNamed = /配信 sitemap 検査の母集団が0件|自オリジンの sitemap 申告を1件も導けない|別オリジン\s+\[robots\]/.test(rFloor.stdout)
  if (rFloor.status === 1 && floorNamed) {
    ok('配線: 自オリジンの sitemap 申告が0件になる入力は必ず exit 1(層は前段でも名指しされる)')
  } else bad(`母集団が空になる入力が素通り: status=${rFloor.status}`)

  server.closeAllConnections?.()
  server.close()
  fs.rmSync(fx, { recursive: true, force: true })
}

// 55 配線(Day116): **OG 画像の配信検査(Day104)も fetch 段**にあり、Day113 のハーネスは
//   配信 sitemap/robots にしか当たっていなかった。㊷ の配線テストは `--list` で走るため
//   「OG 対象が監視対象に出るか」までしか見ておらず、**取得結果を実際に致命化しているか**は
//   誰も見ていない（classifyOgDelivery を呼び忘れても、返り値を捨てても、fatal に足し忘れても
//   純関数テストと --list テストは両方とも緑のまま）。Day113 と同じローカルサーバへ `--base` で
//   向け、OG の段だけを1本ずつ壊して本体の反応を固定する。
//   ここは「型なし＝致命」「未反映(404)＝非致命」の**切り分け**が命で、どちらかに倒れると
//   検査が死ぬ: 致命化が抜ければ Day104 の欠陥が無検知で戻り、逆に 404 まで致命化すると
//   人間ゲートのデプロイ待ちで毎日 red になり検査ごと捨てられる。
{
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'links-d116-'))
  const O = 'https://egshugy.com'  // 正本 app/layout.tsx の metadataBase
  const sitemapXml = (locs) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>${locs.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`
  const robotsTxt = `User-agent: *\nAllow: /\nSitemap: ${O}/sitemap.xml\n`
  const robotsPath = path.join(fx, 'robots.txt')
  fs.writeFileSync(robotsPath, robotsTxt)
  const publicDir = path.join(fx, 'public')
  fs.mkdirSync(publicDir, { recursive: true })
  fs.writeFileSync(path.join(publicDir, 'sitemap.xml'), sitemapXml([`${O}/`, `${O}/stamps/`]))

  // 既定は「全部正常」。OG も image/png で返し、検査したい1本だけを差し替える
  // （他の段が同時に落ちると、exit 1 が何の理由で立ったのか読めなくなる）。
  let serve = {}
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0]
    const custom = serve[url]
    if (custom) {
      res.writeHead(custom.status ?? 200, custom.type === null ? {} : { 'content-type': custom.type ?? 'text/plain; charset=utf-8' })
      res.end(custom.body ?? '')
      return
    }
    if (url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(robotsTxt); return }
    if (url === '/sitemap.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(sitemapXml([`${O}/`, `${O}/stamps/`])); return }
    if (/opengraph-image|twitter-image|\.png$/.test(url)) { res.writeHead(200, { 'content-type': 'image/png' }); res.end('x'); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html><body>ok</body></html>')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const BASE = `http://127.0.0.1:${server.address().port}`
  // spawnSync だとイベントループが止まり同一プロセスのこのサーバが応答できない(Day113 と同じ)
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--base', BASE],
      { env: { ...process.env, LINKS_ROBOTS: robotsPath, LINKS_PUBLIC_DIR: publicDir } })
    let stdout = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stdout += d })
    child.on('close', (status) => resolve({ status, stdout }))
  })
  /** OG の段が「致命の理由」に挙がっているか。status で見ると外部ドメイン(gtag 等)の
   *  一時失敗で赤くなった回まで OG のせいに見えるため、名指しの有無で判定する(Day113 (d) と同じ作法)。*/
  const ogBlamed = (out) => /✗ 型なし\s+\[OG配信\]/.test(out) || /致命.*OG配信の型なし/.test(out)
  const OG_UNDER_TEST = '/opengraph-image.png'

  // (a) 偽陽性の対照。ここが赤いと以下は「常に落ちる実装」でも通ってしまう。
  serve = {}
  const rOk = await run()
  // サマリ行は非致命の経路でしか出ない。外部ドメイン(gtag 等)が一時失敗した回に
  // 「4/4 と出ること」を要求すると本題と無関係な理由で赤くなるため(Day113 (d) と同じ)、
  //   ①OG の段が何も言わないこと（指摘も未反映の ⓘ も無い）
  //   ②サマリ行が出た回は必ず 4/4 であること（出ない回は判定しない）
  // の2点で見る。
  const ogSummary = rOk.stdout.match(/OG配信 (\d+)\/(\d+)件が image\/\*/)
  const ogSilent = !/\[OG配信\]/.test(rOk.stdout) && !/ⓘ OG配信/.test(rOk.stdout)
  if (ogSilent && (!ogSummary || (ogSummary[1] === '4' && ogSummary[2] === '4'))) {
    ok('配線: OG が image/* で配信されていれば何も言わず、数えるときは 4/4 と報告する(偽陽性なし)')
  } else bad(`正常な OG 配信で誤検知/計上漏れ: silent=${ogSilent} summary=${ogSummary?.[0] ?? '(出ず)'}`)

  // (b) 200 だが HTML＝Day104 が直した欠陥そのもの（中身が画像でないのに 200 なので res.ok では見えない）。
  serve = { [OG_UNDER_TEST]: { type: 'text/html; charset=utf-8', body: '<!doctype html><html></html>' } }
  const rHtml = await run()
  if (rHtml.status === 1 && ogBlamed(rHtml.stdout) && rHtml.stdout.includes(`${BASE}${OG_UNDER_TEST}`)) {
    ok('配線: OG が 200 でも画像でなければ exit 1 で URL を名指しする(型なしの検査が本体に届いている)')
  } else bad(`OG 型なしガードが本体で効いていない: status=${rHtml.status}`)

  // (c) content-type ヘッダそのものが無い形（実測された本番の壊れ方。ヘッダ欠落は
  //     「別の型で返る」とは別経路で、null を image/* 判定に通すと素通りしうる）。
  serve = { [OG_UNDER_TEST]: { type: null, body: 'x' } }
  const rNoType = await run()
  if (rNoType.status === 1 && ogBlamed(rNoType.stdout) && /content-type=\(無し\)/.test(rNoType.stdout)) {
    ok('配線: content-type ヘッダが無い OG も exit 1(実測された本番の壊れ方をそのまま再現)')
  } else bad(`型ヘッダ欠落が致命化されていない: status=${rNoType.status}`)

  // (d) 404＝本番未反映。人間ゲートのデプロイ待ちで red にしない（致命の理由に挙がらない）。
  serve = { [OG_UNDER_TEST]: { status: 404, body: 'not found' } }
  const rPending = await run()
  const pendingNoted = /ⓘ OG配信 1\/4 件が本番未反映\(404\)/.test(rPending.stdout)
  // 「ok の実数を偽らない」は**否定形**で見る。`OG配信 n/4件が image/*` のサマリ行は非致命の
  // 経路でしか出ないため、`3/4 が出ること`を要求すると外部ドメイン(gtag 等)の一時失敗で
  // 致命側へ落ちた回に、本題と無関係な理由でこのケースだけが赤くなる(実際に一度そうなった)。
  // 出るか出ないかに関わらず成り立つ「4/4 とは名乗らない」を固定する。
  const claimsAllOk = /OG配信 4\/4件が image\/\*/.test(rPending.stdout)
  if (pendingNoted && !ogBlamed(rPending.stdout) && !claimsAllOk) {
    ok('配線: 未反映(404)は警告に留まり致命の理由にならず、サマリも 4/4 とは名乗らない')
  } else bad(`未反映の扱いが想定外: pending=${pendingNoted} blamed=${ogBlamed(rPending.stdout)} claims4/4=${claimsAllOk}`)

  // (e) 5xx＝瞬断。恒久欠陥と混ぜない（リトライ後も 5xx なら警告のみ）。
  serve = { [OG_UNDER_TEST]: { status: 503, body: 'oops' } }
  const rDown = await run()
  if (/⚠ 503\s+\[OG配信\]/.test(rDown.stdout) && !ogBlamed(rDown.stdout)) {
    ok('配線: 5xx の OG は警告のみ(瞬断を恒久欠陥と混ぜない)')
  } else bad(`5xx の扱いが想定外: ${rDown.stdout.split('\n').filter((l) => /OG配信/.test(l)).join(' / ')}`)

  server.closeAllConnections?.()
  server.close()
  fs.rmSync(fx, { recursive: true, force: true })
}

// 56 bot 対策のチャレンジ(Day116・純関数)。「403 が返った」だけでは、本物の権限エラーと
//   「実ユーザーには見えているのに監視だけが弾かれている」を区別できない。実測: portal が
//   3箇所から張る https://nomishugy.vercel.app/coming-soon はブラウザ UA では 200、監視の
//   UA では 403 + `x-vercel-mitigated: challenge`。恒常的な false-red は本物のリンク切れを
//   埋もれさせるので分ける必要があるが、**403 を丸ごと許す形にはしない**(公開停止を見逃す)。
{
  const cases = [
    [{ status: 403, challengeHeaders: { 'x-vercel-mitigated': 'challenge' } }, true, 'Vercel の Attack Challenge(実測された形)'],
    [{ status: 403, challengeHeaders: { 'x-vercel-challenge-token': 'abc' } }, true, 'チャレンジトークンだけが付く形'],
    [{ status: 503, challengeHeaders: { 'cf-mitigated': 'challenge' } }, true, 'Cloudflare のチャレンジ(503)'],
    [{ status: 429, challengeHeaders: { 'cf-chl-bypass': '1' } }, true, 'Cloudflare のチャレンジページ(429)'],
    [{ status: 403, challengeHeaders: {} }, false, '素の 403 は本物の権限エラー＝許さない'],
    [{ status: 404, challengeHeaders: { 'x-vercel-mitigated': 'challenge' } }, false, '404 はチャレンジの有無に関わらずリンク切れ'],
    [{ status: 200, challengeHeaders: { 'x-vercel-mitigated': 'challenge' } }, false, '中身が返っているなら判定不能ではない'],
    [{ status: 403, challengeHeaders: { 'x-vercel-mitigated': 'block' } }, false, 'block(恒久遮断)はチャレンジではない'],
  ]
  const bads = []
  for (const [res, want, why] of cases) {
    if (isBotChallenge(res) !== want) bads.push(`${why}: 期待${want}`)
  }
  if (bads.length === 0) ok('bot対策: チャレンジ応答だけを「判定不能」と認め、素の 403/404/200 は従来どおり扱う')
  else bad(`チャレンジ判定がずれている: ${bads.join(' / ')}`)

  // fetchWithRetry がヘッダを拾って challenged を立てるか（本体はこのフラグしか見ない）。
  const chalFetch = async () => ({ status: 403, ok: false, headers: { get: (h) => (h === 'x-vercel-mitigated' ? 'challenge' : null) } })
  const r = await fetchWithRetry('https://x.test/', { fetchImpl: chalFetch, sleep: noSleep })
  if (r.challenged === true && r.status === 403) ok('bot対策: fetch 層がチャレンジヘッダを拾って challenged を立てる')
  else bad(`fetch 層が challenged を立てていない: ${JSON.stringify(r)}`)

  // 素の 403 は challenged にしない（fetch 層が緩いと下流の分類が全部意味を失う）。
  const plain403 = async () => ({ status: 403, ok: false, headers: { get: () => null } })
  const r2 = await fetchWithRetry('https://x.test/', { fetchImpl: plain403, sleep: noSleep })
  if (r2.challenged === false) ok('bot対策: 素の 403 は challenged にしない(検知力を落とさない)')
  else bad('素の 403 が challenged になっている')

  // 例外の原因コードまで持つか。素の TypeError だけでは「相手が落ちている」「DNS」「自分の回線」を
  // 区別できず、監視ログを見ても次の手が決まらない(実測: gtag が TypeError(ECONNREFUSED) で落ちた)。
  const boom = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e }
  const r3 = await fetchWithRetry('https://x.test/', { fetchImpl: boom, sleep: noSleep, retries: 0 })
  if (r3.err === 'TypeError' && r3.errCode === 'ECONNREFUSED') ok('bot対策: 例外の原因コード(ECONNREFUSED 等)を持ち帰る(壊れ方に名前をつける)')
  else bad(`原因コードが落ちている: ${JSON.stringify(r3)}`)
}

// 57 死活結果の振り分け(Day116・純関数)。誰が直せるかで分ける規則そのものを固定する。
//   条件が1つずれて「全部警告」に倒れても出力は緑のまま変わらないため、本体のフィルタ式に
//   散らしたままにはできない。
{
  const R = (o) => ({ ok: false, url: 'u', cat: 'c', ...o })
  const okR = { ok: true, owner: 'external', url: 'u', cat: 'c' }

  const a = partitionLinkResults([R({ owner: 'external', challenged: true }), okR], { externalCount: 2 })
  if (a.hardBad.length === 0 && a.challengedExternal.length === 1 && !a.externalBlind) {
    ok('振り分け: 外部のチャレンジは致命にせず「判定不能」として別に数える(相手側の設定は直せない)')
  } else bad(`外部チャレンジの振り分けが想定外: ${JSON.stringify({ hard: a.hardBad.length, chal: a.challengedExternal.length })}`)

  const b = partitionLinkResults([R({ owner: 'portal', challenged: true })], { externalCount: 1 })
  if (b.hardBad.length === 1) {
    ok('振り分け: 自前のチャレンジは致命（自分のサイトの死活が測れない状態を緑にしない・設定は自分で直せる）')
  } else bad(`自前チャレンジが致命化されていない: ${JSON.stringify(b.hardBad)}`)

  const c = partitionLinkResults([R({ owner: 'external', status: 403 })], { externalCount: 1 })
  if (c.hardBad.length === 1 && c.challengedExternal.length === 0) {
    ok('振り分け: チャレンジでない外部の失敗は従来どおり致命(403 を丸ごと許す形にしない)')
  } else bad(`素の外部失敗の扱いが想定外: ${JSON.stringify(c.hardBad.length)}`)

  // Day119 の修正点。**元のテストはここで「softBad にも hardBad にも入らない」ことだけを
  // 確かめており、どこにも入らないことを許していた**（無いことだけを確かめるテストは、
  // 存在しないことを検知できない）。専用の箱に入ることまで要求する。
  const d = partitionLinkResults([R({ owner: 'egtype', soft: true, challenged: true })], { externalCount: 1, softCount: 1 })
  if (d.softBad.length === 0 && d.hardBad.length === 0 && d.challengedSoft.length === 1 && d.unclassified.length === 0) {
    ok('振り分け: soft のチャレンジは未到達にも致命にもせず、専用の「判定不能」として必ず数える')
  } else bad(`soft チャレンジの扱いが想定外: ${JSON.stringify({ soft: d.softBad.length, hard: d.hardBad.length, chalSoft: d.challengedSoft.length, un: d.unclassified.length })}`)

  // floor: 外部が全件判定不能なら、外部リンクについて監視は何も言えていない。
  const e = partitionLinkResults(
    [R({ owner: 'external', challenged: true }), R({ owner: 'external', challenged: true })], { externalCount: 2 })
  if (e.externalBlind) ok('振り分け: 外部が全件判定不能なら floor が立つ(逃がし弁の空洞化を緑にしない)')
  else bad('外部全件判定不能の floor が立たない')

  if (!partitionLinkResults([], { externalCount: 0 }).externalBlind) {
    ok('振り分け: 外部リンクが0件のときは floor を立てない(母集団ゼロを異常と混同しない)')
  } else bad('外部0件で floor が誤爆')

  // --- Day119: 分類の網羅そのものを固定する ---
  // 今日の欠陥は「規則が間違っていた」のではなく **組合せが1つ抜けていた** ことだった。
  // 個々の規則をいくら足しても、抜けは「どの箱にも入らない＝どこにも出ない」形で現れるので、
  // 規則の外側に「失敗の総数と箱の合計が一致する」検算を置く。
  const OWNERS = ['portal', 'external', 'egtype']
  const uncovered = []
  for (const owner of OWNERS) {
    for (const challenged of [false, true]) {
      const soft = owner === 'egtype'   // owner と soft の対応は classifyTargetUrl の契約
      const r = R({ owner, soft, challenged, status: 403 })
      const p = partitionLinkResults([r], { externalCount: owner === 'external' ? 1 : 0, softCount: soft ? 1 : 0 })
      const boxed = p.hardBad.length + p.softBad.length + p.challengedExternal.length + p.challengedSoft.length
      if (boxed !== 1 || p.unclassified.length !== 0) uncovered.push(`${owner}/challenged=${challenged}(箱=${boxed} 未分類=${p.unclassified.length})`)
    }
  }
  if (uncovered.length === 0) {
    ok('振り分け: owner×判定不能の全6組合せがちょうど1つの箱に入る(分類の網羅＝集計の嘘を作らない)')
  } else bad(`どの箱にも入らない/二重に入る組合せがある: ${uncovered.join(' ')}`)

  // 未知の組合せ（将来 owner を増やした等）は unclassified として顕在化すること。
  // floor: この検算自体が空洞化すると、抜けはまた無言で緑になる。
  const g = partitionLinkResults([R({ owner: 'partner', soft: true, challenged: true })], { externalCount: 0, softCount: 0 })
  if (g.unclassified.length === 0 && g.challengedSoft.length === 1) {
    ok('振り分け: soft である限り owner が未知でも判定不能として拾う(取りこぼさない)')
  } else bad(`未知 owner の soft チャレンジを取りこぼす: ${JSON.stringify({ un: g.unclassified.length, cs: g.challengedSoft.length })}`)

  // floor: soft が全件判定不能なら egtype 配信について監視は何も言えていない
  const h = partitionLinkResults(
    [R({ owner: 'egtype', soft: true, challenged: true }), R({ owner: 'egtype', soft: true, challenged: true })],
    { externalCount: 0, softCount: 2 })
  if (h.softBlind) ok('振り分け: soft が全件判定不能なら floor が立つ(外部の floor と同じ思想)')
  else bad('soft 全件判定不能の floor が立たない')

  if (!partitionLinkResults([], { externalCount: 0, softCount: 0 }).softBlind) {
    ok('振り分け: soft が0件のときは floor を立てない(母集団ゼロを異常と混同しない)')
  } else bad('soft 0件で floor が誤爆')

  // 成功は箱に入らない(失敗だけを分類する)。ok を混ぜると件数がすべてずれる。
  const i = partitionLinkResults([okR, okR], { externalCount: 2, softCount: 0 })
  if (i.hardBad.length + i.softBad.length + i.challengedExternal.length + i.challengedSoft.length + i.unclassified.length === 0) {
    ok('振り分け: 成功した結果はどの箱にも入らない(失敗だけを数える)')
  } else bad('成功が箱に混ざっている')
}

// 58 配線(Day119): **soft × bot対策の判定不能**が本体で数に現れるか。
//   純関数(57)が正しく challengedSoft に入れても、本体が受け取らず / 表示せず / fatal にも
//   floor にも足さなければ、出力は元のまま「✓ 全N件 OK」に戻る。Day113/116 と同じ
//   ローカルサーバ＋`--base` のハーネスで、egtype 配信の1本だけをチャレンジ応答にして
//   本体の反応を固定する（他の段は正常にしておく＝exit の理由が読めなくなるため）。
{
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'links-d119-'))
  const O = 'https://egshugy.com'  // 正本 app/layout.tsx の metadataBase
  const sitemapXml = (locs) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>${locs.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`
  const robotsTxt = `User-agent: *\nAllow: /\nSitemap: ${O}/sitemap.xml\n`
  const robotsPath = path.join(fx, 'robots.txt')
  fs.writeFileSync(robotsPath, robotsTxt)
  const publicDir = path.join(fx, 'public')
  fs.mkdirSync(publicDir, { recursive: true })
  fs.writeFileSync(path.join(publicDir, 'sitemap.xml'), sitemapXml([`${O}/`, `${O}/stamps/`]))

  // 既定は全部正常。検査したい1本だけを差し替える。
  let serve = {}
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0]
    const custom = serve[url]
    if (custom) {
      res.writeHead(custom.status ?? 200, { 'content-type': custom.type ?? 'text/plain; charset=utf-8', ...(custom.headers ?? {}) })
      res.end(custom.body ?? '')
      return
    }
    if (url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(robotsTxt); return }
    if (url === '/sitemap.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(sitemapXml([`${O}/`, `${O}/stamps/`])); return }
    if (url === '/egtype/sitemap.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(sitemapXml([`${O}/egtype/`])); return }
    if (/opengraph-image|twitter-image|\.png$|\.webp$/.test(url)) { res.writeHead(200, { 'content-type': 'image/png' }); res.end('x'); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html><body>ok</body></html>')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const BASE = `http://127.0.0.1:${server.address().port}`
  const run = (args = []) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--base', BASE, ...args],
      { env: { ...process.env, LINKS_ROBOTS: robotsPath, LINKS_PUBLIC_DIR: publicDir } })
    let stdout = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stdout += d })
    child.on('close', (status) => resolve({ status, stdout }))
  })

  // Vercel の Attack Challenge と同じ形（403 + x-vercel-mitigated: challenge）
  const CHALLENGE = { status: 403, headers: { 'x-vercel-mitigated': 'challenge' }, body: 'challenge' }
  const SOFT_PATH = '/egtype/characters/GMCK.webp'   // classifyTargetUrl で owner=egtype/soft=true

  // (a) 偽陽性の対照。正常な配信で **egtype 配信について** 判定不能を名乗らないこと。
  //     判定基準を「stdout に 判定不能 の文字があるか」に置くと、check-links が実際に叩く
  //     外部ドメイン(nomishugy 等)が bot 対策を返した回に本題と無関係で落ちる——実測で一度
  //     踏んだ（Day113(d)/Day116 が「status ではなく名指しで見る」と書き残したのと同じ罠）。
  //     この段が名指ししたかどうかだけを見る。
  const softBlamed = (out) => /egtype配信 \d+\/\d+ 件が bot 対策で判定不能/.test(out)
    || new RegExp(`⚠ bot対策\\s+\\[[^\\]]+\\] ${BASE}/egtype/`).test(out)
  serve = {}
  const rOk = await run()
  if (!softBlamed(rOk.stdout)) ok('配線: 正常な配信では egtype 配信を「判定不能」と名乗らない(偽陽性なし)')
  else bad(`正常配信で判定不能が誤検知: ${rOk.stdout.split('\n').filter((l) => /判定不能/.test(l)).join(' / ')}`)

  // (b) 本題。soft の1本がチャレンジ応答のとき——
  //     修正前は ✗ にも ⚠ にも出ず softBad にも入らず「✓ 全N件 OK」で exit 0 だった。
  serve = { [SOFT_PATH]: CHALLENGE }
  const rSoft = await run()
  const named = new RegExp(`⚠ bot対策\\s+\\[[^\\]]+\\] ${BASE}${SOFT_PATH}`).test(rSoft.stdout)
  const counted = /egtype配信 1\/\d+ 件が bot 対策で判定不能/.test(rSoft.stdout)
  const claimsAllOk = /✓ 全\d+件 OK/.test(rSoft.stdout)
  if (named && counted && !claimsAllOk) {
    ok('配線: soft のチャレンジは URL を名指しし件数にも現れる(「全件 OK」と名乗らない)')
  } else bad(`soft チャレンジが本体に届いていない: 名指し=${named} 件数=${counted} 全件OK=${claimsAllOk}`)

  // (c) それでも致命にはしない（相手側の設定で portal では直せない＝毎日 red にしない）。
  //     判定は status ではなく **この段が致命の理由として名指しされたか**。check-links は実在の
  //     外部ドメインも叩くので、そこが落ちた回に status=1 になり本題と無関係にこのケースだけ
  //     赤くなる（実測で踏んだ。Day113(d) と同じ作法へ揃える）。
  const softFatal = (out) => /致命.*egtype配信/.test(out)
    || new RegExp(`✗ [^\\n]*\\s${BASE}${SOFT_PATH}`).test(out)
  if (!softFatal(rSoft.stdout)) ok('配線: soft のチャレンジは致命の理由にならない(相手側の設定で false-red を作らない)')
  else bad(`soft チャレンジが致命化している: ${rSoft.stdout.split('\n').filter((l) => /致命|✗/.test(l)).join(' / ')}`)

  // (d) --strict は「デプロイ後の厳格確認」用なので、そこで測れないのは致命に格上げする。
  //     ここも「exit 1 になったか」ではなく **strict の致命理由に名指しされたか** で見る。
  const rStrict = await run(['--strict'])
  if (rStrict.status === 1 && /\+ egtype配信の判定不能 1件/.test(rStrict.stdout)) {
    ok('配線: --strict では soft のチャレンジを致命に格上げし理由として名指しする')
  } else bad(`--strict で soft チャレンジが理由に出ない: status=${rStrict.status} / ${rStrict.stdout.split('\n').filter((l) => /致命/.test(l)).join(' / ')}`)

  // (e) 対照: strict でも、チャレンジが無ければ「egtype配信の判定不能」を理由に挙げないこと
  //     （常に名指しする実装なら (d) は無条件で通ってしまう＝独立した対照を置く）。
  serve = {}
  const rStrictClean = await run(['--strict'])
  if (!/egtype配信の判定不能/.test(rStrictClean.stdout)) {
    ok('配線: チャレンジが無い回は strict でも egtype配信の判定不能を理由に挙げない(偽陽性なし)')
  } else bad('チャレンジ無しでも判定不能を名指ししている')

  server.closeAllConnections?.()
  server.close()
  fs.rmSync(fx, { recursive: true, force: true })
}

// 59 レイアウト既定メタをそのまま名乗るルート(Day104 起票 → Day119 実装・純関数)。
//   既存の noindex ガードは即リダイレクトのスタブしか見ておらず、同じ欠陥が
//   「自前メタを宣言していない普通のルート」で起きるのを誰も見ていなかった。
{
  const D = (route, files) => ({ route, files })
  const F = (rel, src) => ({ rel, src })
  const CLIENT_PAGE = '"use client"\nexport default function P(){return null}'

  const a = findRoutesNamingLayoutDefault([D('/noxa/', [F('noxa/page.tsx', CLIENT_PAGE)])])
  if (a.length === 1 && a[0].route === '/noxa/') {
    ok('既定メタ: 自前の title/description が無いルートを違反として名指しする')
  } else bad(`既定メタの検知漏れ: ${JSON.stringify(a)}`)

  const b = findRoutesNamingLayoutDefault([D('/noxa/', [
    F('noxa/page.tsx', CLIENT_PAGE),
    F('noxa/layout.tsx', 'export const metadata = { title: "NOXA", description: "…" }'),
  ])])
  if (b.length === 0) ok('既定メタ: 同階層の layout.tsx が自前メタを持てば違反にしない(正本 /noxa/ の形)')
  else bad(`layout.tsx の自前メタを見落としている: ${JSON.stringify(b)}`)

  const c = findRoutesNamingLayoutDefault([D('/', [F('page.tsx', CLIENT_PAGE)])])
  if (c.length === 0) ok('既定メタ: トップは既定が自分の identity なので対象外(誤検知しない)')
  else bad('トップを違反にしている')

  // Day123 PM: 「自前のメタ」の判定が **UI データの title:** で満たされていた。
  // 実測で `app/page.tsx` と `app/noxa/page.tsx` は metadata を1つも宣言していないのに
  // 朝の規則では白（noxa は layout.tsx が本物のメタを持つので結果だけは正しかった）。
  // カード配列を持つページを1つ足せば、メタが無くても静かに合格する形だった。
  const UI_CARDS_PAGE = `"use client"
const cards = [
  { title: 'ぺかりんチンチロ', description: '最下位回避ロジック搭載' },
  { title: 'ワードウルフ', description: 'みんなで遊べる' },
]
export default function Page() { return cards.map((c) => c.title) }`
  const d2 = findRoutesNamingLayoutDefault([D('/games/', [F('games/page.tsx', UI_CARDS_PAGE)])])
  if (d2.length === 1 && d2[0].route === '/games/') {
    ok('既定メタ: UI データの title:/description: を「自前のメタ」と読み違えない(宣言の有無まで見る)')
  } else bad(`UI データを自前メタと誤認している: ${JSON.stringify(d2)}`)

  // 対照: 本物の宣言（generateMetadata 形式も含む）は従来どおり合格させる（厳しくしすぎない）
  const d3 = findRoutesNamingLayoutDefault([D('/games/', [
    F('games/page.tsx', `${UI_CARDS_PAGE}
export async function generateMetadata() { return { title: 'ゲーム一覧', description: '…' } }`),
  ])])
  if (d3.length === 0) ok('対照: generateMetadata で宣言していれば従来どおり合格(過剰厳格化していない)')
  else bad(`本物のメタ宣言を違反にしている: ${JSON.stringify(d3)}`)


  const d = findRoutesNamingLayoutDefault([D('/workspaces/', [
    F('workspaces/page.tsx', CLIENT_PAGE),
    F('workspaces/layout.tsx', 'export const metadata = { robots: { index: false, follow: false } }'),
  ])])
  if (d.length === 0) ok('既定メタ: noindex を宣言していれば索引されない＝重複コンテンツにならないので対象外')
  else bad(`noindex を無視している: ${JSON.stringify(d)}`)

  // page が無いディレクトリ(コンポーネント置き場等)はルートではないので対象外
  const e = findRoutesNamingLayoutDefault([D('/_parts/', [F('_parts/card.tsx', 'export const x = 1')])])
  if (e.length === 0) ok('既定メタ: page.* が無いディレクトリはルートでないので対象外')
  else bad('非ルートを違反にしている')

  // 正本の app/ を実走査して現時点の違反が0件であること(退行の基準線)。
  // 「今たまたま違反が無い」と「見ている」は別なので、上の検知テストと必ず対で置く。
  {
    const appDir = path.join(__dirname, '..', 'app')
    const byDir = new Map()
    const walk = (dir, prefix = '') => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${ent.name}` : ent.name
        if (ent.isDirectory()) walk(path.join(dir, ent.name), rel)
        else if (/\.tsx?$/.test(ent.name)) {
          const d = rel.split('/').slice(0, -1).join('/')
          if (!byDir.has(d)) byDir.set(d, [])
          byDir.get(d).push({ rel, src: fs.readFileSync(path.join(dir, ent.name), 'utf8') })
        }
      }
    }
    walk(appDir)
    const dirs = [...byDir.entries()].map(([d, files]) => ({ route: `/${d ? `${d}/` : ''}`, files }))
    const real = dirs.filter((d) => d.files.some((f) => /(?:^|\/)page\./.test(f.rel)))
    const off = findRoutesNamingLayoutDefault(dirs)
    if (real.length > 0 && off.length === 0) {
      ok(`既定メタ: 正本 app/ の実ルート ${real.length}件はいずれも既定メタを名乗っていない(退行の基準線)`)
    } else bad(`正本 app/ に違反あり or 母集団が空: 母集団=${real.length} 違反=${JSON.stringify(off.map((o) => o.route))}`)
  }
}

// 60 接続段の失敗の切り分け（Day122・純関数）。
//   Day119 起票の false-red: 毎日の cron が回によって赤くなる（実測で変更前の HEAD でも
//   4回中2回が gtag への ECONNREFUSED で exit 1）。直し方は「外部の接続失敗を許す」ではなく
//   **状態を増やす**——届かなかった理由（一過性 / 相手が落ちている / こちらの回線）を分ける。
{
  if (isUnreachableResult({ status: 0, ok: false }) && !isUnreachableResult({ status: 403, ok: false })) {
    ok('接続段: HTTP 応答が返らなかった失敗(status 0)だけを「届かなかった」として扱う(403 等は混ぜない)')
  } else bad('unreachable の判定が status 0 以外まで拾っている/拾えていない')

  if (hostOf('https://www.googletagmanager.com/gtag/js?id=G-X') === 'www.googletagmanager.com' && hostOf('not a url') === null) {
    ok('接続段: ホストは URL から取り、壊れた URL は null(ホスト数の勘定に混ぜない)')
  } else bad(`hostOf が想定外: ${hostOf('https://www.googletagmanager.com/gtag/js?id=G-X')} / ${hostOf('not a url')}`)

  // 本題(a): 他が通っているのに単独ホストだけ不通 → 相手の障害か一過性。再確認へ回す。
  if (diagnoseConnectFailures({ unreachableHosts: ['www.googletagmanager.com'], okCount: 89 }) === 'peer') {
    ok('接続段: 単独ホストだけ不通で他は通っている回は peer(再確認で一過性かを分ける)')
  } else bad('単独ホスト不通を peer と診断しない')

  // 本題(b): 1件も通っていない → こちらの回線。リンク切れと名乗ってはいけない。
  if (diagnoseConnectFailures({ unreachableHosts: ['a.example', 'a.example'], okCount: 0 }) === 'local-network') {
    ok('接続段: 1件も成功していない回はこちらの回線を疑う(観測できていないことを観測したと言わない)')
  } else bad('成功0件でも相手のせいにしている')

  // 本題(c): 無関係な複数ホストが同時に不通 → 単独ホストの障害では説明できない。
  if (diagnoseConnectFailures({ unreachableHosts: ['a.example', 'b.example'], okCount: 5 }) === 'local-network') {
    ok('接続段: 無関係な複数ホストが同時に不通ならこちらの回線を疑う(Day119 の指示どおりの切り分け)')
  } else bad('複数ホスト同時不通をこちらの回線と診断しない')

  // 同一ホストが何件不通でも「複数ホスト」ではない(1つの相手が落ちているだけ)。
  if (diagnoseConnectFailures({ unreachableHosts: ['a.example', 'a.example', 'a.example'], okCount: 5 }) === 'peer') {
    ok('接続段: 同じホストが何件不通でも「複数ホスト」と数えない(1つの相手の障害と区別する)')
  } else bad('同一ホストの複数件をこちらの回線と誤診している')

  // 偽陽性の対照: 接続段の失敗が無い回は、このフェーズごと走らせない。
  if (diagnoseConnectFailures({ unreachableHosts: [], okCount: 90 }) === 'none') {
    ok('接続段: 接続段の失敗が無い回は none(再確認フェーズも診断も走らせない)')
  } else bad('失敗0件でも診断を名乗っている')

  if (classifyRecheck({ ok: true }) === 'recovered' && classifyRecheck({ ok: false }) === 'peer-down') {
    ok('接続段: 再確認で通れば一過性、依然不通なら相手が落ちている(名前で分ける)')
  } else bad('再確認の名前が想定外')

  // 振り分け: こちらの回線で測れなかった分は、リンクを名指しする箱に**入れない**。
  // ただし「どこにも入らない」ことも許さない（Day119 の教訓＝否定形には肯定形の相方）。
  const ln = partitionLinkResults(
    [{ ok: false, url: 'u', cat: 'c', owner: 'portal', status: 0, localNetwork: true }],
    { externalCount: 0, softCount: 0 })
  if (ln.hardBad.length === 0 && ln.localNetwork.length === 1 && ln.unclassified.length === 0) {
    ok('振り分け: こちらの回線で測れなかった失敗は hardBad に混ぜず、専用の箱で必ず数える')
  } else bad(`回線の箱が想定外: ${JSON.stringify({ hard: ln.hardBad.length, ln: ln.localNetwork.length, un: ln.unclassified.length })}`)

  // 外部へ再確認しても届かない失敗の扱い(Day122・実測で残った false-red)。
  //   Day119 の指示どおり「複数ホスト同時不通＝こちらの回線」を実装したうえで本番実走を
  //   繰り返すと、**単独ホスト(gtag)の接続拒否が再確認をも跨ぐ回**が残った(4回に1回ほど exit 1)。
  //   この失敗は「リンクが壊れている」証拠にならない(相手の一時障害 or こちらの egress・
  //   どちらも portal では直せない)ので、403 のチャレンジと同じ「到達性が判定不能」に置く。
  //   ただし丸ごと許すのではなく、**名前解決の失敗(ENOTFOUND)＝ドメインが消えた**は致命のまま。
  {
    const U = (o) => ({ ok: false, status: 0, url: 'https://x.example/y', cat: 'c', ...o })
    if (isUnmeasurableExternal(U({ owner: 'external', errCode: 'ECONNREFUSED' }))) {
      ok('到達不能: 外部への接続拒否は「判定不能」(リンクが壊れている証拠にはならない)')
    } else bad('外部の接続拒否を判定不能として扱えていない')

    if (!isUnmeasurableExternal(U({ owner: 'external', errCode: 'ENOTFOUND' }))) {
      ok('到達不能: 名前解決の失敗(ENOTFOUND)は恒久失敗なので判定不能に逃がさない(死んだドメインは検知する)')
    } else bad('ENOTFOUND まで判定不能に逃がしている')

    if (!isUnmeasurableExternal(U({ owner: 'portal', errCode: 'ECONNREFUSED' }))) {
      ok('到達不能: 自前(portal)へ届かないのは致命のまま(自分のサイトの死活は逃がさない)')
    } else bad('自前の接続失敗まで逃がしている')

    if (!isUnmeasurableExternal(U({ owner: 'external', status: 404, ok: false }))) {
      ok('到達不能: 応答が返った失敗(404 等)は対象外(接続段だけを分ける)')
    } else bad('応答のある失敗まで接続段として扱っている')

    const p1 = partitionLinkResults([U({ owner: 'external', errCode: 'ECONNREFUSED' })], { externalCount: 2 })
    if (p1.hardBad.length === 0 && p1.unreachableExternal.length === 1 && p1.unclassified.length === 0 && !p1.externalBlind) {
      ok('振り分け: 外部の到達不能は致命にせず専用の箱で必ず数える(OK にも未分類にもしない)')
    } else bad(`到達不能の振り分けが想定外: ${JSON.stringify({ h: p1.hardBad.length, u: p1.unreachableExternal.length, un: p1.unclassified.length })}`)

    const p2 = partitionLinkResults([U({ owner: 'external', errCode: 'ENOTFOUND' })], { externalCount: 1 })
    if (p2.hardBad.length === 1 && p2.unreachableExternal.length === 0) {
      ok('振り分け: ENOTFOUND は従来どおり致命(外部の接続失敗を丸ごと許す形にしていない)')
    } else bad(`ENOTFOUND の扱いが想定外: ${JSON.stringify({ h: p2.hardBad.length, u: p2.unreachableExternal.length })}`)

    // floor: 判定不能の理由が混ざっても「外部について一件も測れていない」なら空洞化。
    const p3 = partitionLinkResults(
      [U({ owner: 'external', errCode: 'ECONNREFUSED' }), U({ owner: 'external', challenged: true, status: 403 })],
      { externalCount: 2 })
    if (p3.externalBlind) {
      ok('振り分け: 外部が「チャレンジ＋到達不能」で全件測れないなら floor が立つ(理由が混ざっても空洞は空洞)')
    } else bad('理由が混ざると外部の floor が立たない')
  }

  // 順序（本 Day の核心）: **測り直してから診断する**。一過性で回復した分を診断の入力に
  //   残すと、無関係な2ホストが**たまたま同時に瞬断した**だけの回まで「こちらの回線」と
  //   名乗る（＝新しい false-red を自分で作る）。recheck を注入して決定的に固定する。
  {
    const R = (url) => ({ ok: false, status: 0, err: 'TypeError', errCode: 'ECONNREFUSED', url, owner: 'external', cat: 'c' })
    const results = [R('https://a.example/x'), R('https://b.example/y'), { ok: true, url: 'https://c.example/z', status: 200 }]
    // a だけが回復 → 残る不通は b の1ホストだけ＝相手の障害（回線のせいにしない）
    const one = await resolveConnectFailures(results.map((r) => ({ ...r })), {
      recheck: async (url) => ({ ok: url.includes('a.example'), status: url.includes('a.example') ? 200 : 0 }),
    })
    if (one.recovered.length === 1 && one.stillDown.length === 1 && one.diagnosis === 'peer') {
      ok('接続段: 回復した分を診断の入力から外す(同時に瞬断しただけの回を「こちらの回線」と言わない)')
    } else bad(`順序が想定外: ${JSON.stringify({ rec: one.recovered.length, down: one.stillDown.length, d: one.diagnosis })}`)

    // どちらも回復しない → 無関係な2ホストが不通のまま＝こちらの回線。印まで付くこと。
    const both = await resolveConnectFailures(results.map((r) => ({ ...r })), { recheck: async () => ({ ok: false, status: 0 }) })
    if (both.recovered.length === 0 && both.diagnosis === 'local-network' && both.stillDown.every((r) => r.localNetwork)) {
      ok('接続段: 再確認しても複数ホストが不通なら回線と診断し、結果に印を付ける(箱から外す根拠)')
    } else bad(`回線の診断が想定外: ${JSON.stringify({ d: both.diagnosis, marked: both.stillDown.map((r) => Boolean(r.localNetwork)) })}`)

    // 回復したら成功として扱う（黙って落とさない・二重に数えない）
    const rec = await resolveConnectFailures(results.map((r) => ({ ...r })), { recheck: async () => ({ ok: true, status: 200 }) })
    if (rec.stillDown.length === 0 && rec.diagnosis === 'none' && rec.recovered.every((r) => r.ok && r.recoveredFromUnreachable)) {
      ok('接続段: 全部回復した回は診断そのものが none になり、結果は成功へ置き換わる')
    } else bad(`回復の反映が想定外: ${JSON.stringify({ down: rec.stillDown.length, d: rec.diagnosis })}`)

    // 再確認で**応答が返った**回（Day123 PM）: ok でなくてもその応答を採用する。
    // 朝の実装は ok の回だけ取り込み、404 の回は status 0(届かなかった)のまま残していた
    // ＝**強い観測を捨てて弱い観測を名乗る**形。外部リンクは status 0 だと
    // isUnmeasurableExternal で警告に落ちるので、**死んだ外部リンクが致命から警告へ格下げ**される。
    const r404 = await resolveConnectFailures(results.map((r) => ({ ...r })), {
      recheck: async (url) => (url.includes('a.example') ? { ok: false, status: 404, err: null, errCode: null } : { ok: true, status: 200 }),
    })
    const adopted = r404.responded[0]
    if (r404.responded.length === 1 && adopted.status === 404 && adopted.respondedOnRecheck && r404.recovered.length === 1) {
      ok('接続段: 再確認で応答が返った回はその応答を採用する(404 を「届かなかった」に畳まない)')
    } else bad(`応答の採用が想定外: ${JSON.stringify({ resp: r404.responded.length, st: adopted?.status, rec: r404.recovered.length })}`)
    // 採用した結果が**致命の箱に戻る**ことまで見る（格下げが実際に消えていること）
    const pd404 = partitionLinkResults([adopted], { externalCount: 1, softCount: 0 })
    if (pd404.hardBad.length === 1 && pd404.unreachableExternal.length === 0) {
      ok('接続段: 応答を採用した外部の404は到達不能(警告)ではなく従来どおり致命の箱に入る')
    } else bad(`404 の格下げが残っている: ${JSON.stringify({ hard: pd404.hardBad.length, un: pd404.unreachableExternal.length })}`)
    // 応答が返ったホストを「不通」に数えると、回線の診断が誤って倒れる（もう一方が本当に不通のとき）
    if (r404.diagnosis === 'none' && r404.stillDown.length === 0) {
      ok('接続段: 応答が返ったホストを不通に数えない(こちらの回線と誤診しない)')
    } else bad(`応答済みホストを不通に数えている: ${JSON.stringify({ d: r404.diagnosis, down: r404.stillDown.length })}`)
    // 対照: 応答が返らない回は従来どおり「まだ届かない」として扱う（採用の口が広がりすぎていない）
    const rDown = await resolveConnectFailures(results.map((r) => ({ ...r })), { recheck: async () => ({ ok: false, status: 0, errCode: 'ECONNREFUSED' }) })
    if (rDown.responded.length === 0 && rDown.stillDown.length === 2) {
      ok('対照: 応答が返らない回は従来どおり stillDown（採用の口は応答があるときだけ）')
    } else bad(`応答なしの回まで採用している: ${JSON.stringify({ resp: rDown.responded.length, down: rDown.stillDown.length })}`)

    // 接続段の失敗が無ければ recheck を一度も呼ばない（正常な回に余計な叩き直しをしない）
    let called = 0
    const clean = await resolveConnectFailures([{ ok: true, url: 'https://c.example/z', status: 200 }], {
      recheck: async () => { called++; return { ok: true } },
    })
    if (called === 0 && clean.diagnosis === 'none') {
      ok('接続段: 失敗が無い回は再確認を一度も叩かない(平常時のコストを増やさない)')
    } else bad(`平常時に再確認している: called=${called}`)
  }

  // 対照: localNetwork の印が無い接続失敗は従来どおり致命（「status 0 を丸ごと許す」形にしない）。
  const pd = partitionLinkResults(
    [{ ok: false, url: 'u', cat: 'c', owner: 'portal', status: 0 }], { externalCount: 0, softCount: 0 })
  if (pd.hardBad.length === 1 && pd.localNetwork.length === 0) {
    ok('振り分け: 印の無い接続失敗は従来どおり致命(接続段の失敗を丸ごと許す形にしない)')
  } else bad(`印無しの接続失敗の扱いが想定外: ${JSON.stringify({ hard: pd.hardBad.length, ln: pd.localNetwork.length })}`)
}

// 61 配線(Day122): 接続段の失敗に本体がどう反応するか。
//   純関数(60)が正しく診断しても、本体が再確認を走らせず / 回復を反映せず / 回線の箱を
//   致命に足さなければ、出力は元のまま「✗ 致命 [外部] …」に戻る。Day113/116/119 と同じ
//   ローカルサーバ＋`--base` のハーネスで、**接続を切る**応答（socket destroy）を使って固定する。
{
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'links-d122-'))
  const O = 'https://egshugy.com'
  const sitemapXml = (locs) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>${locs.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`
  const robotsTxt = `User-agent: *\nAllow: /\nSitemap: ${O}/sitemap.xml\n`
  const robotsPath = path.join(fx, 'robots.txt')
  fs.writeFileSync(robotsPath, robotsTxt)
  const publicDir = path.join(fx, 'public')
  fs.mkdirSync(publicDir, { recursive: true })
  fs.writeFileSync(path.join(publicDir, 'sitemap.xml'), sitemapXml([`${O}/`, `${O}/stamps/`]))

  // 接続を切る（fetch は例外＝status 0 になる）。
  //   dropAlways … ずっと切る（恒常的に届かない相手）
  //   dropWindow … **最初の1回が来てから WINDOW_MS の間だけ**切る（瞬断そのもの）
  // 「最初の N 回だけ切る」という回数の数え方は使わない: socket を落とすと同じ接続に
  // 相乗りしていた別リクエストも巻き添えで落ちるため、サーバ側の回数とクライアント側が
  // 見る失敗回数が一致せず、テストが回によって緑にも赤にもなった（実測）。
  // 時間窓なら本走(fetchWithRetry の3試行＝計1.2秒)は必ず窓の内側、再確認(下の
  // LINKS_RECHECK_DELAY_MS)は必ず窓の外側に来るので、どちらの側からも決定的になる。
  // 窓は本走(3試行)を確実に覆う長さにする。90件同時のうえ実在の外部も叩くので、
  // retry の backoff(400/800ms)に**待ち行列の遅れ**が乗り、3試行目が 1.5 秒を越える回があった
  // (実測でこのケースだけが回によって緑になった＝テスト側の false-green)。余裕を広く取る。
  const WINDOW_MS = 6000
  let dropAlways = new Set()
  let dropWindow = null   // { path, since }
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0]
    let inWindow = false
    if (dropWindow && dropWindow.path === url) {
      if (dropWindow.since === null) dropWindow.since = Date.now()
      inWindow = Date.now() - dropWindow.since < WINDOW_MS
    }
    if (dropAlways.has(url) || inWindow) {
      req.socket.destroy()
      return
    }
    if (url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(robotsTxt); return }
    if (url === '/sitemap.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(sitemapXml([`${O}/`, `${O}/stamps/`])); return }
    if (url === '/egtype/sitemap.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(sitemapXml([`${O}/egtype/`])); return }
    if (/opengraph-image|twitter-image|\.png$|\.webp$/.test(url)) { res.writeHead(200, { 'content-type': 'image/png' }); res.end('x'); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html><body>ok</body></html>')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const BASE = `http://127.0.0.1:${server.address().port}`
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--base', BASE],
      { env: { ...process.env, LINKS_ROBOTS: robotsPath, LINKS_PUBLIC_DIR: publicDir, LINKS_RECHECK_DELAY_MS: '8000' } })
    let stdout = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stdout += d })
    child.on('close', (status) => resolve({ status, stdout }))
  })

  const TARGET = '/stamps/'   // portal 自前の実ルート（owner=portal・hard）

  // (a) 偽陽性の対照。接続段の失敗が無い回は、再確認も回線の診断も名乗らない。
  //     判定は「stdout に語があるか」ではなく **この段が名指ししたか**（Day113(d)/Day116/119 の作法。
  //     check-links は実在の外部ドメインも叩くので、そこが落ちた回に本題と無関係で赤くなる）。
  const blamedLocalNet = (out) => /こちらの回線を疑う形/.test(out) || /✗ 回線 {2}\[こちらのネットワーク\]/.test(out)
  //     回復の名指しも **このフィクスチャの URL について** 言われたかだけを見る。実行環境の回線が
  //     細って実在の外部(gtag 等)が一過性で落ちた回に、本題と無関係で赤くなるのを避けるため
  //     （実測で一度踏んだ。Day113(d)/Day116/119 が三度書き残したのと同じ罠を、また踏んだ）。
  const blamedRecovery = (out) => new RegExp(`再確認で回復[^\\n]*${BASE}`).test(out)
  dropAlways = new Set(); dropWindow = null
  const rClean = await run()
  if (!blamedLocalNet(rClean.stdout) && !blamedRecovery(rClean.stdout)) {
    ok('配線: 接続段の失敗が無い回は再確認も回線の診断も名乗らない(偽陽性なし)')
  } else bad(`正常な回で接続段の診断が誤爆: ${rClean.stdout.split('\n').filter((l) => /回線|再確認/.test(l)).join(' / ')}`)

  // (b) 本題。**1回目だけ**接続を切られた1本（＝瞬断そのもの）。
  //     修正前は fetchWithRetry の3試行(計1.2秒)を使い切って hardBad＝「✗ 致命」で exit 1 だった。
  //     ここでは再確認で回復し、緑のまま、しかも**黙って緑にせず**回復を名乗ること。
  //     このケースだけは**実行環境の回線が生きていること**を前提にする（回線が細っていれば
  //     診断は「こちらの回線」になり、それはその環境における正しい答え＝本題を測れない）。
  //     測れない回は黙って緑にせず、環境が復するまで数回だけやり直し、駄目なら赤で報告する。
  let rFlaky = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    dropAlways = new Set(); dropWindow = { path: TARGET, since: null }
    const r = await run()
    if (!blamedLocalNet(r.stdout)) { rFlaky = r; break }
    console.log(`    (実行環境の回線が不通と診断されたため測り直す ${attempt}/3)`)
  }
  if (rFlaky === null) {
    bad('瞬断のケースを測れなかった（実行環境の回線が3回とも不通と診断された＝環境側の問題）')
  } else {
    // 件数(`1件`)ではなく **このフィクスチャの URL が回復として名指しされたか** で見る(Day123 PM)。
    // 朝の実装は `接続不能だった 1件は …` と件数を焼き込んでおり、**実行環境の回線が細って
    // 実在の外部(gtag 等)が同じ回に一過性で落ちる**と「2件」になって本題と無関係に赤くなる
    // （実測で 9回中1回。この段の (a) と blamedRecovery では同じ罠を避けているのに、
    //  本題のアサートにだけ件数が残っていた＝**自分で書いた作法から本命だけが漏れていた**）。
    const namedRecovered = new RegExp(`再確認で回復[^\\n]*${BASE}${TARGET}`).test(rFlaky.stdout)
    const blamedTarget = new RegExp(`✗ [^\\n]*\\s${BASE}${TARGET}`).test(rFlaky.stdout)
    if (namedRecovered && !blamedTarget) {
      ok('配線: 一過性の瞬断は再確認で回復し、リンクを致命として名指ししない(かつ回復したことを名乗る)')
    } else {
      // 失敗したときに**何が起きたか**を読めるようにする（「false false」だけでは次に踏んだ
      // 人が原因へ辿れない＝Day108「壊れ方は名前を言えるかで評価する」の、テスト側の版）。
      const evidence = rFlaky.stdout.split('\n').filter((l) => /接続不能|再確認|回線|✗/.test(l)).slice(0, 4).join(' / ')
      bad(`瞬断の扱いが想定外: 回復の名指し=${namedRecovered} 致命の名指し=${blamedTarget} — 実出力: ${evidence || '(該当行なし)'}`)
    }
  }

  // (c) 対照: **ずっと**接続できない1本は緑にならず、その URL が名指しされる。
  //     (b) と入力の形は同じで「続くかどうか」だけが違う＝再確認が一過性だけを吸収し、
  //     恒常的な不通は素通ししないことの対。「接続失敗を丸ごと許す」形にしていない floor。
  //     ここで peer/回線 のどちらと名乗るかまでは要求しない——check-links は実在の外部ドメインも
  //     叩くので、実行環境の回線が細った回には「こちらの回線」が**正しい診断**になる
  //     （環境に依存する断定を配線テストに書くと Day113(d)/Day116 と同じ false-red を作る）。
  //     peer と回線の切り分けそのものは 60 の純関数テストで決定的に固定している。
  dropWindow = null; dropAlways = new Set([TARGET])
  const rDown = await run()
  const named = new RegExp(`✗ [^\\n]*\\s${BASE}${TARGET}`).test(rDown.stdout)
  const claimsAllOk = /✓ 全\d+件 OK/.test(rDown.stdout)
  if (named && !claimsAllOk) {
    ok('配線: ずっと接続できない相手は再確認でも回復せず、URL を名指しして緑にしない')
  } else bad(`恒常的な不通の扱いが想定外: 名指し=${named} 全件OK=${claimsAllOk}`)

  server.closeAllConnections?.()
  server.close()
  fs.rmSync(fx, { recursive: true, force: true })
}

// 62 配線(Day125・Day116 起票の消化): **抽出層まで含めて**フィクスチャで固定する。
//
// これまでの配線テストは「何を叩くか」を決める抽出層（featured-apps / EXPERIMENTS /
// app の JSX / live components）に override の口が無く、**正本の app/ をそのまま読む**しか
// なかった。その結果、配線テストは実在の外部ドメイン(x.com・tiktok・googletagmanager)を
// 本当に叩いており、実行環境の回線状態で結果が変わる——実測で **9回に1回**、本題と
// 無関係な赤が出ていた(Day123 PM)。`LINKS_SRC_DIR` を足し、外へ一歩も出ずに
// 「抽出 → 振り分け → 判定 → 終了コード」の全段を踏めるようにする。
//
// 併せて `http://` の抽出(本 Day)も、ここで**実際に監視対象へ載る**ことを見る
// （純関数テストは「拾えること」しか見ない。載っても叩かれなければ意味がない）。
{
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'links-d125-'))
  fs.mkdirSync(path.join(fx, 'app'), { recursive: true })
  fs.mkdirSync(path.join(fx, 'public'), { recursive: true })
  const O = 'https://egshugy.com'
  fs.writeFileSync(path.join(fx, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${O}/sitemap.xml\n`)
  fs.writeFileSync(path.join(fx, 'public/sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset><url><loc>${O}/</loc></url></urlset>`)
  fs.writeFileSync(path.join(fx, 'app/layout.tsx'), [
    `export const metadata = { metadataBase: new URL('${O}'), title: 'fx', description: 'fx' }`,
    'export default function RootLayout({ children }) {',
    '  return (<html><body>{children}',
    // SW ブートストラップの母集団 floor を満たす最小形（登録だけ・巻き添えなし）
    "    <script dangerouslySetInnerHTML={{ __html: `if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js')}` }} />",
    '  </body></html>)',
    '}',
  ].join('\n'))
  fs.writeFileSync(path.join(fx, 'app/opengraph-image.tsx'), 'export default function OG() { return null }\n')
  // ソースルートを名乗るなら public/ の実体も持つ(Day128 PM)。layout の register('/sw.js') は
  // 「ローカル静的資産の参照」として抽出されるので、実体が無ければ欠落として正しく落ちる
  // （朝までは実在判定だけが正本の public/ を見ていたため、フィクスチャに無くても素通りしていた）。
  fs.copyFileSync(path.join(__dirname, '..', 'public/sw.js'), path.join(fx, 'public/sw.js'))

  const hits = []
  const server = http.createServer((req, res) => {
    hits.push(req.url.split('?')[0])
    const u = req.url.split('?')[0]
    if (u === '/external-404') { res.writeHead(404); res.end('nope'); return }
    if (u === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(fs.readFileSync(path.join(fx, 'robots.txt'), 'utf8')); return }
    if (u === '/sitemap.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(fs.readFileSync(path.join(fx, 'public/sitemap.xml'), 'utf8')); return }
    if (/opengraph-image|twitter-image|\.png$|\.webp$/.test(u)) { res.writeHead(200, { 'content-type': 'image/png' }); res.end('x'); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html><body>ok</body></html>')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const PORT = server.address().port
  const BASE = `http://127.0.0.1:${PORT}`

  // 外部リンクは**平文 http でフィクスチャのサーバを指す**。これは Day116 起票の
  // 「https:// 限定」を解いたからこそ書ける形で、逆に言えば従来はローカルに閉じた
  // 外部リンクの配線テストが**原理的に書けなかった**（外部＝実在ドメインしか作れない）。
  const writePage = (externalPath) => fs.writeFileSync(path.join(fx, 'app/page.tsx'), [
    'const ALL_CHARACTERS = [{ id: "GMCK", name: "ぶるとら" }]',
    "export const metadata = { title: 'fx top', description: 'fx',",
    `  alternates: { canonical: '${O}/' },`,
    `  openGraph: { url: '${O}/', title: 'fx top', description: 'fx' } }`,
    'export default function Page() {',
    '  return (<main>',
    '    <a href="/">home</a>',
    '    {ALL_CHARACTERS.map((c) => <span key={c.id}>{c.name}</span>)}',
    `    <a href="${BASE}${externalPath}">外部</a>`,
    '  </main>)',
    '}',
  ].join('\n'))

  const runFx = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--base', BASE], {
      env: {
        ...process.env,
        LINKS_SRC_DIR: fx,
        // SW 本体の母集団も実体も正本を見せる（この段の検査対象ではない＝specific > general の実演）。
        // `LINKS_SW_FILE` は Day128 で必要になった: それまで SW 本体の既定が `ROOT` 直書きで、
        // general の口を渡してもフィクスチャではなく正本を読んでいた（＝層が届いていなかった）。
        LINKS_SW_DIR: path.join(__dirname, '..', 'app'),
        LINKS_SW_FILE: path.join(__dirname, '..', 'public/sw.js'),
        LINKS_ROBOTS: path.join(fx, 'robots.txt'),
        LINKS_PUBLIC_DIR: path.join(fx, 'public'),
      },
    })
    let stdout = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stdout += d })
    child.on('close', (status) => resolve({ status, stdout }))
  })

  // (a) 生きている外部リンク → 緑。かつ**外へ一歩も出ていない**こと。
  hits.length = 0
  writePage('/external-ok')
  const rOk = await runFx()
  const listedExternal = new RegExp(`${BASE}/external-ok`).test(rOk.stdout) || hits.includes('/external-ok')
  if (rOk.status === 0 && listedExternal) {
    ok('抽出層: フィクスチャの app/ から外部リンクを拾い、緑で終わる(LINKS_SRC_DIR が効いている)')
  } else bad(`抽出層の override が効いていない: exit=${rOk.status} 外部を叩いた=${listedExternal} / ${rOk.stdout.split('\n').slice(-2).join(' ')}`)
  if (hits.includes('/external-ok')) {
    ok('抽出層: 平文 http の外部リンクが**実際に監視対象として叩かれる**(https 限定の解消が配線まで届いている)')
  } else bad(`http の外部リンクが叩かれていない: ${[...new Set(hits)].join(' ')}`)

  // (b) 死んでいる外部リンク → 致命。URL を名指しすること。
  hits.length = 0
  writePage('/external-404')
  const rNg = await runFx()
  const named = new RegExp(`✗ [^\\n]*${BASE}/external-404`).test(rNg.stdout)
  const claimsAllOk = /✓ 全\d+件 OK/.test(rNg.stdout)
  if (rNg.status === 1 && named && !claimsAllOk) {
    ok('抽出層: フィクスチャの死んだ外部リンクを名指しして exit 1(振り分けの配線が生きている)')
  } else bad(`死んだ外部リンクの扱いが想定外: exit=${rNg.status} 名指し=${named} 全件OK=${claimsAllOk}`)

  // (c) **この段の肝**: 第三者ドメインへ一度も出ていない＝結果が回線状態に左右されない。
  //     自オリジン(metadataBase)の表記は --list では正規URLのまま出るが、取得時には --base へ
  //     書き換えられる（上の (a) で実際にフィクスチャのサーバへ来ていることを確認済み）。
  //     壊れるのは**第三者ホスト**を叩いてしまう形なので、そこだけを見る。
  const listOf = (env) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--base', BASE, '--list'], { env })
    let stdout = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.on('close', () => resolve(stdout))
  })
  const fxEnv = { ...process.env, LINKS_SRC_DIR: fx, LINKS_SW_DIR: path.join(__dirname, '..', 'app'),
                  LINKS_SW_FILE: path.join(__dirname, '..', 'public/sw.js'),
                  LINKS_ROBOTS: path.join(fx, 'robots.txt'), LINKS_PUBLIC_DIR: path.join(fx, 'public') }
  const thirdPartyHosts = (out) => {
    const urls = out.split('\n').flatMap((l) => l.match(/https?:\/\/[^\s\t]+/g) || [])
    return [...new Set(urls.map((u) => hostOf(u)).filter((h) => h && !h.startsWith('127.0.0.1') && h !== 'egshugy.com'))]
  }
  const fxList = await listOf(fxEnv)
  const fxThird = thirdPartyHosts(fxList)
  if (fxList.trim() && fxThird.length === 0) {
    ok('抽出層: フィクスチャの母集団に第三者ホストが1件も無い（実行環境の回線状態に左右されない）')
  } else bad(`フィクスチャなのに第三者ホストを叩く: ${fxThird.join(' ')}`)

  //     対照: 正本(既定)の母集団には第三者ホストが**実際に居る**。これが0件なら上の検査は
  //     「そもそも外部が居ないだけ」で何も言っていないことになる（規則の空振り検知）。
  const realList = await listOf({ ...process.env, LINKS_ROBOTS: path.join(fx, 'robots.txt'), LINKS_PUBLIC_DIR: path.join(fx, 'public') })
  const realThird = thirdPartyHosts(realList)
  if (realThird.length > 0) {
    ok(`対照: 正本の母集団には第三者ホストが ${realThird.length}件居る＝フィクスチャの0件は override の効果`)
  } else bad('正本にも第三者ホストが居ない＝この検査は何も区別できていない')

  server.closeAllConnections?.()
  server.close()
  fs.rmSync(fx, { recursive: true, force: true })
}

// 63 抽出層の口が**全ガードに届いている**こと(Day128・Day125 の層の完成)。
//   Day125 は「specific > general > 既定」の層を作ったが、general(`LINKS_SRC_DIR`)を既定に
//   したのは app/ 起点のガードだけで、components/ と public/ 配下を見る4つ——a11y・sitemap・
//   robots・SW 本体——は `ROOT` 直書きのまま残っていた。
//   実測(Day128・修正前): `LINKS_SRC_DIR` だけを渡すと、**フィクスチャの components/ に置いた
//   a11y 違反も、壊した public/sitemap.xml も検出されず rc=0**。専用の口を1つずつ名指しすれば
//   検出される＝規則は生きていて、届いていなかったのは general の口だった。
//   害は両方向にある: ①フィクスチャの内容が検査されない（テストを書いたつもりで空振り）
//   ②**正本の状態がフィクスチャ実行に混ざる**——正本の components/ に違反が入った日に
//   Day125 の配線テストが本題と無関係に赤くなる（Day125 が消したはずの flaky の作り直し）。
{
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'links-d128-'))
  const O = 'https://egshugy.com'
  const w = (rel, src) => {
    const full = path.join(fx, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, src)
    return full
  }
  // 最小のフィクスチャ「ソースルート」: app/ + components/ + public/ を自分で持つ。
  w('app/layout.tsx', [
    `export const metadata = { metadataBase: new URL('${O}'), title: 'fx', description: 'fx' }`,
    'export default function RootLayout({ children }) {',
    '  return (<html><body>{children}',
    "    <script dangerouslySetInnerHTML={{ __html: `if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js')}` }} />",
    '  </body></html>)',
    '}',
  ].join('\n'))
  w('app/page.tsx', [
    'const ALL_CHARACTERS = [{ id: "GMCK", name: "ぶるとら" }]',
    "export const metadata = { title: 'fx top', description: 'fx',",
    `  alternates: { canonical: '${O}/' },`,
    `  openGraph: { url: '${O}/', title: 'fx top', description: 'fx' } }`,
    'export default function Page() {',
    '  return (<main><a href="/">home</a>{ALL_CHARACTERS.map((c) => <span key={c.id}>{c.name}</span>)}</main>)',
    '}',
  ].join('\n'))
  w('app/opengraph-image.tsx', 'export default function OG() { return null }\n')
  w('public/robots.txt', `User-agent: *\nAllow: /\nSitemap: ${O}/sitemap.xml\n`)
  w('public/sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset><url><loc>${O}/</loc></url></urlset>`)
  // SW 本体はフィクスチャにも実体が要る（無ければ「配信されている /sw.js が消えた」で致命＝正しい）
  fs.copyFileSync(path.join(__dirname, '..', 'public/sw.js'), path.join(fx, 'public/sw.js'))
  // SW ブートストラップの母集団だけは正本を見せる（register だけの最小 layout では floor を
  // 満たせないため。specific > general の実演で、この段は今回の検査対象ではない）。
  const SW_DIR = path.join(__dirname, '..', 'app')
  const runFx = (extra = {}) => spawnSync(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--list'],
    { encoding: 'utf8', env: { ...process.env, LINKS_SRC_DIR: fx, LINKS_SW_DIR: SW_DIR, ...extra } })

  // (a) 下限: この最小ソースルートは general の口だけで緑になる（フィクスチャが不完全でないこと）。
  const rBase = runFx()
  if (rBase.status === 0) ok('抽出層: LINKS_SRC_DIR だけでフィクスチャの全段が緑になる（口が届いている）')
  else bad(`最小フィクスチャが緑にならない: status=${rBase.status} ${rBase.stdout.split('\n').filter((l) => l.includes('✗')).slice(0, 2).join(' / ')}`)

  // (b) components/ の a11y: general の口だけでフィクスチャ側が読まれること。
  //     修正前はここで**正本の components/** が読まれ、フィクスチャの違反は素通りしていた。
  w('components/widget.tsx', 'export default function W() {\n  return <button onClick={x}><Icon className="w-4" /></button>\n}\n')
  const rA11y = runFx()
  if (rA11y.status === 1 && /\[a11y\] components\/widget\.tsx/.test(rA11y.stdout)) {
    ok('抽出層→a11y: フィクスチャの components/ が読まれる（正本を読み続けない）')
  } else bad(`a11y に general の口が届いていない: status=${rA11y.status}`)
  fs.rmSync(path.join(fx, 'components/widget.tsx'))

  // (c) sitemap: 同上。フィクスチャの sitemap と実ルートの不整合を捕まえること。
  w('public/sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<urlset><url><loc>https://egshugy.com/nowhere/</loc></url></urlset>')
  const rMap = runFx()
  // 判定は**フィクスチャ由来の理由**に締める(Day128 PM)。`[sitemap]` だけを見ると、
  // 別の段が落ちた回でも緑になりうる（テストが別の理由で通る＝何も証明していない状態）。
  if (rMap.status === 1 && /索引対象の実ルートなのに sitemap に載っていない/.test(rMap.stdout)) {
    ok('抽出層→sitemap: フィクスチャの public/sitemap.xml が読まれる（正本を読み続けない）')
  } else bad(`sitemap に general の口が届いていない: status=${rMap.status}`)
  w('public/sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset><url><loc>${O}/</loc></url></urlset>`)

  // (d) robots: 同上。フィクスチャの robots.txt が読まれること。
  w('public/robots.txt', 'User-agent: *\nDisallow: /\n')
  const rRobots = runFx()
  // 「robots」の語は正常出力にも出る。**どのファイルを読んで何に失敗したか**で判定する。
  if (rRobots.status === 1 && /\[robots\][^\n]*から Sitemap 宣言を1件も抽出できない/.test(rRobots.stdout)
      && rRobots.stdout.includes(path.basename(fx))) {
    ok('抽出層→robots: フィクスチャの public/robots.txt が読まれる（正本を読み続けない）')
  } else bad(`robots に general の口が届いていない: status=${rRobots.status}`)
  w('public/robots.txt', `User-agent: *\nAllow: /\nSitemap: ${O}/sitemap.xml\n`)

  // (e) SW 本体: 同上。フィクスチャ側の sw.js が読まれること（壊した版を置いて実測する）。
  //     activate が自分の旧版を消さない形＝Day110 の floor に引っかかる版を置く。
  w('public/sw.js', [
    "const CACHE_NAME = 'portal-v1'",
    'self.addEventListener("install", () => self.skipWaiting())',
    'self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()) })',
    'self.addEventListener("fetch", (event) => {',
    '  if (event.request.method !== "GET") return',
    '  event.respondWith(fetch(event.request).then((r) => { caches.open(CACHE_NAME).then((c) => c.put(event.request, r.clone())); return r }))',
    '})',
  ].join('\n'))
  const rSw = runFx()
  // 3つの語のどれかではなく、**フィクスチャの sw.js を名指しして落ちている**ことを見る。
  if (rSw.status === 1 && /\[SW実走\]/.test(rSw.stdout) && rSw.stdout.includes(path.basename(fx))
      && /旧版キャッシュ/.test(rSw.stdout)) {
    ok('抽出層→SW本体: フィクスチャの public/sw.js が読まれる（正本を読み続けない）')
  } else bad(`SW 本体に general の口が届いていない: status=${rSw.status}`)

  // (f) 逆向きの下限: specific は general より強い（専用の口で正本を見せ直せる）。
  const rSpecific = runFx({ LINKS_SW_FILE: path.join(__dirname, '..', 'public/sw.js') })
  if (rSpecific.status === 0) ok('層の順序: specific(LINKS_SW_FILE) が general(LINKS_SRC_DIR) を上書きする')
  else bad(`specific > general が効いていない: status=${rSpecific.status}`)

  // 以降の段は SW を検査対象にしないので、(e) で壊した sw.js を正本の内容へ戻す
  // （前の段の残骸を残すと、次の段が**別の理由で**赤くなり何を証明したのか読めなくなる）。
  fs.copyFileSync(path.join(__dirname, '..', 'public/sw.js'), path.join(fx, 'public/sw.js'))

  // (g) ローカル静的資産(Day128 PM で発見): 参照の抽出元は SRC_APP なのに、実在判定だけ
  //     `path.join(ROOT, 'public', …)` で**正本**を見ていた＝物差しが2つある状態。朝は
  //     「public/ 配下を見るガード」を数えたつもりで、書き方が違うこの1つを数え落としていた。
  //     両方向を見る: フィクスチャに在るものは緑（偽赤を出さない）/ 無いものは赤（偽緑にしない）。
  w('public/fx-only.png', 'PNG')
  w('app/page.tsx', [
    'const ALL_CHARACTERS = [{ id: "GMCK", name: "ぶるとら" }]',
    "export const metadata = { title: 'fx top', description: 'fx',",
    `  alternates: { canonical: '${O}/' },`,
    `  openGraph: { url: '${O}/', title: 'fx top', description: 'fx' } }`,
    'export default function Page() {',
    '  return (<main><a href="/">home</a><img src="/fx-only.png" alt="fx" />',
    '    {ALL_CHARACTERS.map((c) => <span key={c.id}>{c.name}</span>)}</main>)',
    '}',
  ].join('\n'))
  const rAssetOk = runFx()
  if (rAssetOk.status === 0) ok('抽出層→ローカル静的: フィクスチャに実在する資産を「無い」と言わない（偽赤なし）')
  else bad(`フィクスチャの資産が偽赤: status=${rAssetOk.status} ${rAssetOk.stdout.split('\n').filter((l) => l.includes('✗')).slice(0, 2).join(' / ')}`)

  //     逆向き: **正本にだけ在る**資産（icon-192.png）はフィクスチャでは欠落として捕まること。
  //     修正前はここが正本の public/ を見て素通りしていた（偽緑）。
  fs.rmSync(path.join(fx, 'public/fx-only.png'))
  const rAssetNg = runFx()
  // この段の致命化は fetch 段（`--list` はその手前で終わる）なので、**名指しの有無**で見る。
  // 「exit コードが変わらないから何も起きていない」ではなく、どこを見て何と言ったかを判定する。
  if (/\[ローカル静的\] public\/fx-only\.png が存在しない/.test(rAssetNg.stdout)
      && !/\[ローカル静的\] public\/fx-only\.png/.test(rAssetOk.stdout)) {
    ok('抽出層→ローカル静的: フィクスチャに無い資産を欠落として名指しする（正本の public/ で判定しない）')
  } else bad(`ローカル静的に general の口が届いていない: 欠落時の名指し=${/ローカル静的/.test(rAssetNg.stdout)}`)
  w('public/fx-only.png', 'PNG')


  fs.rmSync(fx, { recursive: true, force: true })
}

// 64 SW の**書く側**を実走で固定する(Day128・Day127 egtype からの横断)。
//   activate(消す側・Day110)と offline フォールバック(読む側・Day122)には実走の検査があるのに、
//   **書く側だけは一度も踏まれていなかった**。Day107 の「自オリジン かつ 成功応答 かつ opaque
//   でない」という規則はソースに在るが、`isCacheable` ごと消してもテストは全部緑のままだった。
//   緩むと: ①opaque を put すると仕様上 TypeError（表示のたびに未処理の拒否）②404 を保存すると
//   次のオフラインで**エラーページが焼き付く** ③第三者の応答でオリジン共有の Cache Storage を
//   同居アプリと奪い合う。規則ではなく結果を見る（Day110 と同じ理由）。
{
  const O = 'https://egshugy.com'
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/sw.js'), 'utf8')
  const CASES = [
    { label: '自オリジンの成功応答', url: `${O}/icon-192.png`, status: 200, type: 'basic', want: true },
    { label: '第三者の CORS 応答', url: 'https://www.googletagmanager.com/gtag/js', status: 200, type: 'cors', want: false },
    { label: '第三者の opaque 応答', url: 'https://static.cloudflareinsights.com/beacon.js', status: 200, type: 'opaque', want: false },
    { label: '自オリジンの 404', url: `${O}/nope`, status: 404, type: 'basic', want: false },
    { label: '自オリジンの 500', url: `${O}/boom`, status: 500, type: 'basic', want: false },
  ]
  const { written, hasFetch } = await simulateSwCacheWrites(src, { origin: O, cases: CASES })
  if (!hasFetch) bad('SW書込: fetch ハンドラが無い（書く側の検査が母集団ごと空振りする）')
  else {
    // floor: 1件も書かれない実装（＝常に何も保存しない）で「余計なものを保存していない」と
    // 言っても何も証明していない。まず保存されるべきものが保存されることを見る。
    const wantedCount = CASES.filter((c) => c.want).length
    if (written.length > 0 && wantedCount > 0) ok(`SW書込: 母集団 floor（保存されるべき ${wantedCount}件が候補にある）`)
    else bad('SW書込: floor が成立していない')
    for (const c of CASES) {
      const got = written.includes(c.url)
      if (got === c.want) ok(`SW書込: ${c.label}は${c.want ? '保存する' : '保存しない'}`)
      else bad(`SW書込: ${c.label}の扱いが想定外（保存=${got} 期待=${c.want}）`)
    }
  }

  // 逆向き: 規則を外した版では実際に赤くなる（この検査が空振りしていないことの裏取り）。
  const loosened = src.replace(/function isCacheable\([^)]*\)\s*\{[\s\S]*?\n\}/, 'function isCacheable() { return true }')
  if (loosened === src) bad('SW書込: 規則の空振り検知に失敗（isCacheable の形が変わっている）')
  else {
    const { written: w2 } = await simulateSwCacheWrites(loosened, { origin: O, cases: CASES })
    const leaked = CASES.filter((c) => !c.want && w2.includes(c.url))
    if (leaked.length >= 3) ok(`SW書込: 規則を外すと ${leaked.length}件が保存される（検知が働いている）`)
    else bad(`SW書込: 規則を外しても差が出ない（検査が空振り）: ${leaked.length}件`)
  }
}

// 65 層の取り残しを**数で**塞ぐ(Day128 PM)。
//   今日は同じ形を2回踏んだ: 朝に4つのガードが `ROOT` 直書きのまま取り残されているのを直し、
//   夕方に**5つ目**（ローカル静的資産の実在判定）を見つけた。5つ目を数え落とした理由は
//   `path.join(ROOT, 'public', p)` という**他とは違う書き方**だったこと——「使っている箇所が
//   正しい」ことの確認では、取り残しは永久に見えない。以後は個別に数えず、規則として禁じる。
//   表示用の `path.relative(ROOT, …)` と `SRC_ROOT` の定義/比較は対象外（読み取りではない）。
{
  const srcPath = path.join(__dirname, 'check-links.mjs')
  const src = fs.readFileSync(srcPath, 'utf8')
  // コメント行は対象外（この規則を説明する文そのものが違反として拾われる＝実際に踏んだ）。
  const detect = (code) => code.split('\n')
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(({ line }) => /path\.join\(\s*ROOT\s*,/.test(line))
  // 先に検知が働くことを確かめる（空振りしている検査の「0件」は無意味）。
  const probe = detect("const x = fs.existsSync(path.join(ROOT, 'public', p))")
  if (probe.length === 1) ok('層の floor: 検知が働いている（ROOT 直書きの読み取りを拾う）')
  else bad('層の floor が空振りしている')
  const probeOk = detect([
    'console.log(path.relative(ROOT, SW_FILE))',
    'const SRC_ROOT = env ? path.resolve(env) : ROOT',
    "// 以前は path.join(ROOT, 'public', p) だった、という説明文",
  ].join('\n'))
  if (probeOk.length === 0) ok('層の floor: 表示用の path.relative・SRC_ROOT の定義・コメントは拾わない（偽陽性なし）')
  else bad(`層の floor が違反でないものを拾っている: ${probeOk.map((o) => `L${o.n}`).join(' ')}`)
  const offenders = detect(src)
  if (offenders.length === 0) {
    ok('層の floor: check-links.mjs に ROOT 直書きの読み取りが0件（全ガードが抽出層の口に載っている）')
  } else {
    bad(`抽出層の口に載っていない読み取りが残っている: ${offenders.map((o) => `L${o.n}`).join(' ')}`)
  }
}

console.log(`\n[selftest-check-links] 結果: pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
