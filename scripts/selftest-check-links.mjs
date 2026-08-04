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
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fetchWithRetry, isTransientStatus } from './fetch-with-retry.mjs'
import { extractExternalUrls, extractCharIds, extractLocalAssetRefs, routesFromPageFiles } from './lib/extract-targets.mjs'

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

console.log('\n[selftest-check-links] 配線(check-links --list が実ルートを監視対象に載せているか)')

// ㉑ 本物の app/ を歩いた結果が targets に合流しているところまで固定する。
//   抽出層が正しくても本体で合流し損ねていれば監視は増えないまま「✓」で通る。
//   とくに /workspaces/ は **どこからもリンクされないことが仕様**の救済ルート(yorulog の
//   Service Worker が握った古いキャッシュから来た人をトップへ逃がす)で、リンク由来の抽出
//   だけでは永久に無監視になる。ここが落ちたら Day97 の退行。
{
  const r = spawnSync(process.execPath, [path.join(__dirname, 'check-links.mjs'), '--list'], { encoding: 'utf8' })
  const internal = r.stdout.split('\n').filter((l) => l.split('\t')[1] === '内部').map((l) => l.split('\t')[2])
  const pageDirs = fs.readdirSync(path.join(__dirname, '..', 'app'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(__dirname, '..', 'app', e.name, 'page.tsx')))
    .map((e) => `/${e.name}/`)
  const missing = ['/', ...pageDirs].filter((p) => !internal.some((u) => u.endsWith(p)))
  if (r.status === 0 && missing.length === 0 && internal.some((u) => u.endsWith('/workspaces/'))) {
    ok(`app の実ルート全${pageDirs.length + 1}件が監視対象に載っている(無リンクの /workspaces/ を含む)`)
  } else bad(`実ルートが監視対象から漏れている: missing=${JSON.stringify(missing)} status=${r.status}`)
}

console.log(`\n[selftest-check-links] 結果: pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
