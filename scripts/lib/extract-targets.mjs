// check-links.mjs が「何を死活監視するか」を決める抽出層。純関数だけを置き、
// selftest-check-links.mjs から直接テストできるようにする(Day91)。
//
// 背景: 監視対象の抽出はこれまで check-links.mjs 本体に regex で直書きされており
// 一切テストされていなかった。抽出が黙って0件になったり、URL が途中で切れて別物を
// 叩いていても「✓ 全件OK」と出る = ガード自身が false-green/false-red を生む。
// 実測で以下3つの穴があった(Day91 で発見):
//   ① クエリ付き URL が `?` の手前で切れ、実 URL の死活を見ていない
//      (`https://www.googletagmanager.com/gtag/js?id=G-J5KGMEKCF4` を `.../gtag/js` として検査)
//      = Day45 で `@` について直したのとまったく同型の事故が `?` に残っていた。
//   ② テンプレートリテラル `https://host/@${VAR}` が `${` の手前で切れ、実在しない
//      `https://www.tiktok.com/@` を hard ターゲットとして叩いていた(phantom)。
//   ③ ローカル静的アセットの実在チェックがダブルクォートしか見ておらず、
//      app/layout.tsx が全面シングルクォートで書かれているため素通りしていた(Day82 の再発経路)。

// URL は空白・引用符・バッククォート・山括弧・閉じ括弧の手前まで貪欲に取る。
// こうするとクエリ(?a=b&c=d)・フラグメント(#x)・エンコード(%20)が自然に含まれる。
const URL_RE = /https:\/\/[^\s"'`<>\\)]+/g
// 文末の句読点は URL の一部でないことが多いので剥がす(「…は https://example.com/。」等)。
const TRAILING_PUNCT = /[.,;:!?)\]]+$/

/**
 * ソース文字列から外部 URL(https://) を抽出する。
 * テンプレートリテラルの補間 `${...}` を含む断片は「実 URL が組み立て時にしか
 * 定まらない動的 URL」なので、切れた前半を実在 URL と誤認しないよう捨てる。
 */
export function extractExternalUrls(src, { exclude = null } = {}) {
  const out = new Set()
  for (const m of src.matchAll(URL_RE)) {
    if (m[0].includes('${')) continue // 動的 URL: 切れた前半を叩かない
    const url = m[0].replace(TRAILING_PUNCT, '')
    if (!url || url === 'https://') continue
    if (exclude && exclude.test(url)) continue
    out.add(url)
  }
  return [...out]
}

// ALL_CHARACTERS の行から id を取る。`{ id: "X", name: "…"` の形だけを対象にし
// (EXPERIMENTS の `ja:` / PRODUCTS の `jaName:` は続くキー名が違うので拾わない)、
// 空白・改行の入り方には依存しないようにする(整形が入っただけで0件化しないため)。
const CHAR_ID_RE = /\{\s*id:\s*"([A-Za-z0-9_]+)"\s*,\s*name:\s*"/g

export function extractCharIds(pageSrc) {
  return [...pageSrc.matchAll(CHAR_ID_RE)].map((m) => m[1])
}

// ルート直下のローカル静的アセット参照。シングル/ダブル両方の引用符を見る
// (layout.tsx は全面シングルクォート)。PWA の必須資産 manifest.json / sw.js も対象に
// 含める — 消えるとインストール性と SW 登録が黙って壊れるが、拡張子が画像でないため
// 従来の画像限定スキャンでは無検査だった。
// /egtype/... のような多セグメント(別アプリが配信)は対象外＝単一セグメントのみ。
const LOCAL_ASSET_RE = /["'](\/[A-Za-z0-9_-]+\.(?:png|jpg|jpeg|webp|svg|gif|ico|json|js))["']/g

export function extractLocalAssetRefs(src) {
  return [...new Set([...src.matchAll(LOCAL_ASSET_RE)].map((m) => m[1]))]
}

// --- 実ルート列挙(Day97) ---
// これまで check-links の内部ターゲットは「どこかの href から辿れるパス」だけで組み立てて
// いた。つまり**リンクを監視していてルートを監視していない**。どこからもリンクされない
// ルートは静的エクスポートされ本番で配信されているのに、消えても壊れても「✓ 全件OK」の
// ままになる(Day91/94/96 と同じ false-green の、監視対象の選定層での現れ)。
// 実例: `/workspaces/` は yorulog の Service Worker が握った古いキャッシュから来た人を
// トップへ逃がすための救済ルートで、**リンクされないことが仕様**。ゆえにこの穴の直撃を
// 受けており、消えても誰も気づけないまま「SW に汚染された端末だけが永久に 404」になる。
//
// page ファイルの相対パス一覧(app/ 起点)から、静的エクスポートで実際に生える URL を出す。
// trailingSlash: true 前提なので末尾スラッシュ付き。
// URL を静的に決められないもの(動的セグメント・パラレルルート)は routes に混ぜず skipped に
// 分けて返す — 黙って捨てると「監視できていない」こと自体が見えなくなるため。
// PM(Day97): ページ拡張子は Next 既定の pageExtensions（js/jsx/ts/tsx）に加え、mdx 有効時の
// md/mdx も実際にルートを生む。朝の実装は tsx/ts/jsx/js だけを見ており、`app/blog/page.mdx` を
// **routes にも skipped にも載せず黙って捨てていた** — つまり本日封鎖したはずの
// 「監視対象に入らないルート」を、より狭い形で自分で作り直していた（Day96 の教訓
// 「skip の理由を区別できない実装は false-green を作る」の直系）。md/mdx を正式に routes へ
// 載せ、なお未知の単一拡張子(`page.<未知>`)は**理由付きで skipped に顕在化**する。
// `page.css` 等の明らかな非ルート資産だけは従来どおり静かに無視する(ⓘ ノイズを出さない)。
const PAGE_FILE_RE = /^page\.(?:tsx|ts|jsx|js|mdx|md)$/
const PAGE_LIKE_RE = /^page\.([A-Za-z0-9]+)$/
const NON_ROUTE_EXT = /^(?:css|scss|sass|less|styl|json|txt|map|snap)$/i
const ROUTE_GROUP_RE = /^\(.*\)$/
const DYNAMIC_SEG_RE = /^\[.*\]$/

// ディレクトリセグメント列(app/ 起点) → 配信URL。静的に決められない場合は理由を返す。
// `silent` はプライベートフォルダのように「ルーティングされないのが正しい」ケースで、
// 監視できていない旨を報告する必要が無いもの。
function routeFromSegments(parts) {
  const segs = []
  for (const s of parts) {
    if (ROUTE_GROUP_RE.test(s)) continue // ルートグループは URL に出ない
    if (s.startsWith('_')) return { skip: 'プライベートフォルダ(ルーティングされない)', silent: true }
    if (s.startsWith('@')) return { skip: 'パラレルルート(単独URLを持たない)' }
    if (DYNAMIC_SEG_RE.test(s)) return { skip: '動的セグメント(URLが実引数依存)' }
    segs.push(s)
  }
  return { route: segs.length ? `/${segs.join('/')}/` : '/' }
}

export function routesFromPageFiles(files) {
  const routes = new Set()
  const skipped = []
  for (const file of files) {
    const parts = file.split('/')
    const base = parts.pop()
    if (!PAGE_FILE_RE.test(base)) {
      const m = PAGE_LIKE_RE.exec(base)
      if (m && !NON_ROUTE_EXT.test(m[1])) {
        skipped.push({ file, reason: `未知のページ拡張子(.${m[1]})＝ルート化規則が追いついていない` })
      }
      continue
    }
    const r = routeFromSegments(parts)
    if (r.skip) { if (!r.silent) skipped.push({ file, reason: r.skip }) }
    else routes.add(r.route)
  }
  return { routes: [...routes], skipped }
}

// --- canonical / og:url の自己参照ずれ検知(PM Day97) ---
// metadata の canonical・openGraph.url は**自サイトの絶対URL**なので、死活監視から見ると
// ただの外部リンクで、200 を返す限り何も起きない。しかし「/noxa/ の canonical が / を
// 指している」ような取り違えは**別ルートでも 200 なので永久に検知されない**まま、
// 検索エンジンには正規URLの誤申告、SNS には別ページの共有カードとして出続ける。
// これは今日封鎖した穴と同じ構図＝「実ルートを母集団にして突合しないと分からない」。
// metadata を宣言するファイル(page/layout)の canonical・og:url のパスは、そのファイル自身の
// ルートと一致していなければならない。
// 自サイト origin の単一の出所は app/layout.tsx の metadataBase。ここを二重管理すると
// 「片方だけ変えて突合が黙って無効になる」ので、必ずソースから読む。読めなければ null を
// 返し、呼び出し側が致命として落とす(規約変更で突合が無言化するのを防ぐ)。
export function extractMetadataBaseOrigin(src) {
  const m = src.match(/metadataBase:\s*new URL\(\s*['"`](https?:\/\/[^'"`]+?)\/?['"`]\s*\)/)
  return m ? m[1] : null
}

// PM 再レビュー(Day97): 当初この関数は「ファイル中に現れる自サイト絶対URL」を無条件に
// そのファイルのルートと突合していた。これは名前(canonical/og:url)より遥かに広く、
// **正当な書き方を致命(exit 1)で殺す false-red** になる。実測で確認した誤検知2種:
//   ① `openGraph: { images: ['<origin>/og-image.png'] }` ＝ 絶対URLの OG 画像(ごく普通の書き方)
//   ② `<a href="<origin>/">トップへ戻る</a>` ＝ 別ルートを指す正当な絶対リンク
// しかも判定は HTTP 検査より前で即 exit 1 のため、**この誤検知1件で死活監視が丸ごと落ちる**
// (Day91 で塞いだ「phantom を hard 監視して cron が red」と同クラスの逆戻り)。
// よって突合対象を「宣言そのもの」に絞る＝キー `canonical` / `url`(alternates.canonical と
// openGraph.url / twitter の url)の値だけを見る。画像・任意の href は母集団に入れない。
// 併せて metadata が実際に効くファイル(page.* / layout.*)だけを対象にする。
// 絞った分「記法変更で突合が黙って無効になる」危険が増えるので、宣言件数を返して
// 呼び出し側が0件を致命にできるようにする(Day91/94/96 と同じ floor)。
const SELF_URL_FILE_RE = /^(?:page|layout)\.(?:tsx|ts|jsx|js|mdx|md)$/
export function findSelfUrlMismatches(entries, origin) {
  const esc = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`["'\`]?\\b(?:canonical|url)["'\`]?\\s*:\\s*["'\`]${esc}(/[^"'\`]*)?["'\`]`, 'g')
  const mismatches = []
  let declarations = 0
  for (const { file, src } of entries) {
    const parts = file.split('/')
    if (!SELF_URL_FILE_RE.test(parts.pop())) continue // metadata が効くのは page/layout だけ
    const r = routeFromSegments(parts)
    if (r.skip) continue // URL を静的に決められないルートは突合しない
    for (const m of src.matchAll(re)) {
      const declared = m[1]
      if (declared === undefined) continue // origin だけ(metadataBase)は自己参照ではない
      declarations++
      if (normalizeRoutePath(declared) !== r.route) mismatches.push({ file, declared, expected: r.route })
    }
  }
  return { mismatches, declarations }
}

// --- 監視ターゲットの配信主体による分類(Day101) ---
// check-links には hard(失敗=致命 exit 1) / soft(失敗=警告のみ) の2段がある。soft が存在する
// 理由はただ一つ、「**portal 自身では直せない**＝別リポ egtype のデプロイでしか解消しない
// 失敗で、portal の cron を常時 red にしない」ため(portal と egtype はセットでデプロイする運用)。
//
// ところが従来この2段は **どの配列から来たターゲットか** で手書きのリテラル(`soft: false` /
// `soft: true`)として決めており、**実際の配信主体と一致していなかった**。実測:
//   ・portal の `out/`(デプロイ物)に `egtype/` は含まれない＝`/egtype/**` は全て egtype の別デプロイ
//   ・にもかかわらず `/egtype/characters/*.webp` 32件と `/egtype/` は hard、
//     `/egtype/types/<id>/` 32件だけが soft ＝ **同じデプロイ依存が正反対の致命度**
// 実害2つ:
//   ① 33体目のキャラを足した瞬間、portal 側の `ALL_CHARACTERS` が先に増えるため
//      `/egtype/characters/<新>.webp` が hard で 404(実測: 存在しない画像は本番で実 404)
//      → egtype 未デプロイを理由に portal の cron が red。soft を作った目的そのものに反する。
//      同じ体の型ページは soft なので警告止まり＝同一原因で判定が割れる。
//   ② サマリが「portal自前 N/N 件 OK」と出すが、その N には egtype 配信の33件が混ざる＝集計の嘘。
// さらに false-green 側(Day94 が「残る同型」と明示して以来 open): soft はリテラル直書きで
// 何のガードも無く、`soft: false` → `true` を内部/外部ターゲットに一度書けば portal 自前の
// リンク切れが全て警告のみ・exit 0 になり「✓ portal自前 N/N OK」と出続ける。
//
// よって分類を「どの配列か」ではなく **URL がどこから配信されるか** から導く1つの述語にする。
// 手書きのリテラルが消えるので、①の割れ方も②の嘘も③の書き換えも構造的に起こせなくなる。
// egtype が配信するパス接頭辞。portal のデプロイ物(out/)に含まれず、別リポのデプロイでのみ
// 解消する領域。増える時はここだけを直せばよい(判定は全ターゲットで共有される)。
export const CROSS_REPO_PREFIXES = ['/egtype/']

/**
 * 監視ターゲット URL の配信主体を判定する。
 *   'portal'   … portal 自身がデプロイする(自前で直せる) → hard
 *   'egtype'   … 別リポ egtype のデプロイでしか解消しない → soft
 *   'external' … 他所のサービス。portal が貼ったリンクの責任は portal にあるので hard
 * base は監視先オリジン(末尾スラッシュ無し)。--base で別オリジンを指しても同じ規則で効く。
 * prefixes は selftest が「広げすぎると何が起きるか」を非破壊で実証するための注入口
 * (本体は既定の CROSS_REPO_PREFIXES を使う)。
 * 注意: `startsWith(base)` ではなく `base` 完全一致か `base + '/'` で判定する。前者だと
 * `https://egshugy.com.example.net/` のような**別ドメイン**を portal 自前(hard)と誤認する。
 */
export function classifyTargetUrl(url, base, prefixes = CROSS_REPO_PREFIXES) {
  if (url !== base && !url.startsWith(`${base}/`)) return { owner: 'external', soft: false }
  const p = url.slice(base.length) || '/'
  if (prefixes.some((pre) => p.startsWith(pre))) return { owner: 'egtype', soft: true }
  return { owner: 'portal', soft: false }
}

/**
 * 自オリジンの「素の origin」表記(https://egshugy.com)をルート表記(https://egshugy.com/)へ揃える。
 * next.config の `trailingSlash: true` によりポータルの正規表記は必ず末尾スラッシュ付きで、両者は
 * 同じ1ページ。ところが `app/layout.tsx` の metadataBase が `new URL('https://egshugy.com')` と
 * 素の origin を宣言しているため外部URL抽出がこれを拾い、内部由来の `/` とは**文字列が違うだけ**
 * なので重複排除をすり抜けて同じページを2回叩いていた(PM Day97 の重複排除の取りこぼし・PM Day101 実測)。
 * さらに owner 列(Day101)で見ると `cat=外部` なのに `owner=portal` という表示上の矛盾にもなっていた。
 */
export function canonicalizeTargetUrl(url, base) {
  return url === base ? `${base}/` : url
}

// リンク由来の内部パスをルート由来(末尾スラッシュ付き)と同じ表記に揃える。
// PM(Day97): next.config の `trailingSlash: true` により `/noxa` と `/noxa/` は同じルートだが、
// 朝の実装は両者を素の Set で統合していたため、JSX に `href="/noxa"` と書かれた瞬間に
// ①同一ルートを2回叩き ②「うち無リンクM」件数が実態より多く出る（リンク済みのルートを
// 無リンクと誤報する）という表示の嘘が生まれる。突合の前に必ずここを通す。
export function normalizeRoutePath(p) {
  return p.endsWith('/') ? p : `${p}/`
}
