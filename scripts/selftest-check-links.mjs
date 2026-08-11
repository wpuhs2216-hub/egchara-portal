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
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fetchWithRetry, isTransientStatus } from './fetch-with-retry.mjs'
//
// 追加(Day101): 「監視対象の致命度(hard/soft)を何で決めるか」の層も固定する。soft は
// 「portal 自身では直せない＝egtype のデプロイでしか解消しない失敗で cron を red にしない」
// ための逃がし弁で、従来はカテゴリごとの手書きリテラルだったため実際の配信主体とずれていた
// (同じ /egtype/ 依存で画像は hard・型ページは soft)。URL 由来の述語に変えた分、今度は
// 「接頭辞を広げれば自前のリンク切れまで警告のみにできる」経路が生まれるので、そこも押さえる。
import { extractExternalUrls, extractCharIds, extractLocalAssetRefs, routesFromPageFiles, normalizeRoutePath, findSelfUrlMismatches, extractMetadataBaseOrigin, classifyTargetUrl, canonicalizeTargetUrl, crossRepoRootFromRoster, findIconOnlyControlsWithoutName, findRedirectStubsWithoutNoindex, ogImageRoutesFromFiles, classifyOgDelivery, findSitemapCoverageGaps, findOriginWideSwWipes, findRobotsSitemapIssues, classifyServedRobots, parseRobotsGroups } from './lib/extract-targets.mjs'
//
// 追加(Day110): SW の後片付けを「書き方」ではなく「**実際に何を消したか**」で固定する。
// Day107 の静的規則は `caches.keys()` の結果を絞らず delete する形を黒としたが、実害として
// 残っていたのは `keys.filter((k) => k !== CACHE_NAME)` ＝ filter はあるのに他人のものを
// 全部消す反転形で、規則の上では白だった。SW は素の JS なので実走できる。
import { simulateSwActivate, ownPrefixOf } from './lib/sw-activate-sim.mjs'

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

console.log(`\n[selftest-check-links] 結果: pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
