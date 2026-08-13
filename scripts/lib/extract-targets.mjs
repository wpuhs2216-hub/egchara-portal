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
 * cross-repo 領域(egtype が配信する範囲)の根を、**ロスターから生成した実ターゲット**の
 * 最長共通ディレクトリから導く。実データでは `/egtype/characters/*.webp` と
 * `/egtype/types/<id>/` の共通部分＝`/egtype/`。
 *
 * これは分類そのもの(classifyTargetUrl)ではなく、**分類が実態と一致しているかを裏取りする側**の
 * 基準線。CROSS_REPO_PREFIXES は「宣言」なので定数の書き換えでも env override でも動くが、
 * こちらは監視ターゲットの生成物から導くので宣言をどう弄っても動かない＝双方向の floor
 * (soft ⇔ egtype 領域)の突合相手になる(PM Day101 の2本目)。
 *
 * 最終セグメント(ファイル名・キャラID)は共通に含めない。1体しか無い場合に
 * `/egtype/characters/pekarin.webp` 丸ごとが根になり、領域が1ファイルへ縮むのを防ぐ。
 * 共通部分が無い場合は `/`(＝全ターゲットが領域内という無意味な根)を返す。呼び出し側は
 * これを致命として扱うこと——`/` を根にすると portal 自前まで「egtype 領域」に化け、
 * floor が丸ごと空振りする。
 */
export function crossRepoRootFromRoster(paths) {
  if (paths.length === 0) return '/'
  const split = paths.map((p) => p.split('/').filter(Boolean))
  const head = split[0]
  let n = 0
  while (n < head.length && split.every((s) => s.length > n + 1 && s[n] === head[n])) n++
  return n === 0 ? '/' : `/${head.slice(0, n).join('/')}/`
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

// --- アイコンだけのリンク/ボタンのアクセシブル名(Day104) ---
// 実測: `app/stamps/page.tsx` の戻るリンクは lucide `<ArrowLeft>` だけを子に持ち、可視テキストも
// aria-label も title も無かった。**そのページ唯一の内部リンク**なので、スクリーンリーダーでは
// 名前の無いリンクが1つあるだけの行き止まりになる(WCAG 2.4.4 リンクの目的 / 4.1.2 名前・役割・値)。
// 同等のリンクがトップ(app/page.tsx)には aria-label 付きで存在しており、非対称＝書き忘れだった。
// HTTP 検査では 200 が返るので死活監視では永久に検知できない静的な欠陥で、check-links の
// 「自己URLずれ」と同じく**ネットワークを見ずに確定する種類**なのでここで押さえる。
//
// 判定: 開始タグに aria-label / aria-labelledby / title が無く、子に要素があるのに
// 可視テキストが1文字も無いもの。`{c.name}` のような式は「何か描画される」と見なして名前あり扱い
// (式の中身までは静的に読めない＝false-red を出さない側に倒す)。空白だけの {" "} は無視する。
const A11Y_NAME_ATTR_RE = /(?:aria-label|aria-labelledby|title)\s*=/
const JSX_COMMENT_RE = /\{\/\*[\s\S]*?\*\/\}/g
const JSX_BLANK_EXPR_RE = /\{\s*["'`]\s*["'`]\s*\}/g

// 開始タグの終端 `>` を返す。属性値の式に含まれる `>`(アロー関数 `() =>` 等)を終端と
// 誤認しないよう波括弧の深さを見る。
function endOfOpenTag(src, start) {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === '>' && depth === 0) return i
  }
  return -1
}

// 戻り値は { offenders, scanned }。scanned は「子を持つ Link/a/button を何個検査したか」で、
// 呼び出し側が0件を致命にできるようにするための floor 用(Day91/94/96 と同じ作法)。JSX の記法や
// 整形が変わってタグ走査が黙って0件になると、指摘0件＝「✓ 問題なし」と出続けてしまう。
export function findIconOnlyControlsWithoutName(src, { tags = ['Link', 'a', 'button'] } = {}) {
  const out = []
  let scanned = 0
  for (const tag of tags) {
    const openRe = new RegExp(`<${tag}\\b`, 'g')
    for (const m of src.matchAll(openRe)) {
      const gt = endOfOpenTag(src, m.index)
      if (gt === -1) continue
      const openTag = src.slice(m.index, gt + 1)
      if (openTag.endsWith('/>')) continue           // 子を持たない＝アイコンすら無い
      const close = src.indexOf(`</${tag}>`, gt)
      if (close === -1) continue
      const children = src.slice(gt + 1, close)
      if (new RegExp(`<${tag}\\b`).test(children)) continue // 入れ子は内側の走査で拾う
      scanned++
      if (A11Y_NAME_ATTR_RE.test(openTag)) continue
      const hasElement = /<[A-Za-z]/.test(children)
      const text = children
        .replace(JSX_COMMENT_RE, '')
        .replace(JSX_BLANK_EXPR_RE, '')
        .replace(/<[^>]*>/g, '')
        .trim()
      if (!hasElement || text.length > 0) continue
      out.push({ tag, snippet: openTag.replace(/\s+/g, ' ').slice(0, 90) })
    }
  }
  return { offenders: out, scanned }
}

// --- リダイレクトスタブの索引制御(Day104) ---
// 実測: `/workspaces/`(SW 汚染端末の救済スタブ)は `location.replace("/")` するだけの中身の無い
// ページなのに、metadata を一切宣言していなかったためレイアウト既定の title/description/OG
// (＝トップと完全同一)を名乗っていた。robots.txt は `Allow: /` なのでクローラは到達でき、
// JS を実行しない相手にはリダイレクトも起きない＝「トップと同じ名前の空ページ」が重複コンテンツ
// として索引されうる。sitemap 非掲載は索引されない保証にはならない。
// スタブ(=クライアント側で即リダイレクトするルート)には noindex 宣言を必須にする。
const CLIENT_REDIRECT_RE = /(?:window\s*\.\s*)?location\s*\.\s*(?:replace|assign)\s*\(|(?:window\s*\.\s*)?location\s*\.\s*href\s*=/
const NOINDEX_RE = /robots\s*:\s*\{[^}]*index\s*:\s*false/

/**
 * routeDirs: [{ route: '/workspaces/', files: [{ rel, src }] }]
 * ルートのディレクトリ内に即リダイレクトの実装がありながら、同ディレクトリのどこにも
 * robots.index:false の宣言が無いものを返す。
 */
export function findRedirectStubsWithoutNoindex(routeDirs) {
  const out = []
  for (const { route, files } of routeDirs) {
    if (!files.some((f) => CLIENT_REDIRECT_RE.test(f.src))) continue
    if (files.some((f) => NOINDEX_RE.test(f.src))) continue
    out.push({ route, files: files.map((f) => f.rel) })
  }
  return out
}

// --- レイアウト既定メタをそのまま名乗るルートの横断(Day104 起票 → Day119 実装) ---
// 上の findRedirectStubsWithoutNoindex は **即リダイレクトのスタブ**しか見ていない。
// しかし「レイアウト既定＝トップと同一の title/description/OG を名乗る」という欠陥は
// リダイレクトするかどうかとは無関係で、**自前の metadata を宣言していない全ルート**で起きる。
// とくに `"use client"` のページは `export const metadata` を書けないので、同じ階層に
// layout.tsx を足さない限り必ずこの状態になる（実測: /noxa/ は noxa/layout.tsx を持つので健全、
// / はトップ自身なので既定を名乗って正しい）。
// 現時点の違反は0件だが、「今たまたま違反が無い」と「見ている」は別（Day113 の a11y 母集団と
// 同じ）。ルートを1つ足した瞬間に静かに重複コンテンツが生えるので、母集団をルート全体へ広げる。
//
// 判定: そのルートの page.* / layout.* のどこにも title または description の宣言が無ければ違反。
//   - ルート直下(`/`)はレイアウト既定が自分自身の identity なので対象外
//   - noindex を宣言しているルートは索引されないので対象外（重複コンテンツにならない）
const OWN_META_RE = /(?:^|[\s{,])(?:title|description)\s*:/m

/**
 * routeDirs: [{ route: '/workspaces/', files: [{ rel, src }] }]
 * 自前の title/description を1つも宣言せず、noindex でもないルートを返す。
 */
export function findRoutesNamingLayoutDefault(routeDirs) {
  const out = []
  for (const { route, files } of routeDirs) {
    if (route === '/') continue                                   // トップは既定が自分の identity
    if (!files.some((f) => /(?:^|\/)page\.(?:tsx|ts|jsx|js|mdx|md)$/.test(f.rel))) continue // ルートでない
    if (files.some((f) => NOINDEX_RE.test(f.src))) continue        // 索引されないなら重複しない
    if (files.some((f) => OWN_META_RE.test(f.src))) continue       // 自前のメタを持っている
    out.push({ route, files: files.map((f) => f.rel) })
  }
  return out
}

// --- OG 画像の配信ヘッダ(Day104) ---
// 実測: `HEAD https://egshugy.com/opengraph-image` は 200・content-length 358903 を返すのに
// **content-type ヘッダが無い**(`/icon.png` は image/png)。`output: "export"` × ファイルベース OG は
// `out/opengraph-image`(拡張子なし)を吐き、静的配信側が拡張子から型を推定できないため。中身は
// 正しい PNG でヘッダだけの問題だが、型を見て弾くクローラでは共有カードの画像が出ない。
// `/twitter-image`・`/noxa/opengraph-image`・`/stamps/opengraph-image` も同じ。
// 配信物側は scripts/postbuild-og-ext.mjs が拡張子つきの複製(<path>.png)を出して解消する。
// ここではその「拡張子つきの配信物」が本番でどう返っているかを判定する述語を置く。
const OG_FILE_RE = /^(?:(.*)\/)?(opengraph-image|twitter-image)\.(?:tsx|ts|jsx|js)$/

/**
 * app/ 配下の相対ファイル一覧から、OG 画像ルートの「拡張子つき配信パス」を導く。
 * 例: ['opengraph-image.tsx', 'noxa/opengraph-image.tsx'] → ['/opengraph-image.png', '/noxa/opengraph-image.png']
 */
export function ogImageRoutesFromFiles(files) {
  const out = []
  for (const f of files) {
    const m = OG_FILE_RE.exec(f)
    if (!m) continue
    out.push(`/${m[1] ? `${m[1]}/` : ''}${m[2]}.png`)
  }
  return [...new Set(out)].sort()
}

/**
 * OG 画像の配信結果の分類。
 *   'ok'             … 200 かつ image/* → 期待どおり
 *   'bad-type'       … 200 なのに image/* でない/ヘッダ無し → **本 Day が直した欠陥そのもの**(致命)
 *   'pending-deploy' … 404 → 拡張子つきの配信物はビルドには入っているが本番未反映(人間ゲート)。
 *                      デプロイ待ちで cron を red にしないため非致命。配信物側の正しさは
 *                      postbuild のビルド時アサーションが担保する(そちらは build を落とす)。
 *   'unreachable'    … それ以外(5xx/瞬断) → 警告
 */
export function classifyOgDelivery({ status, contentType }) {
  if (status === 200) return /^image\//i.test(contentType || '') ? 'ok' : 'bad-type'
  if (status === 404) return 'pending-deploy'
  return 'unreachable'
}

// --- sitemap.xml の網羅性(Day107) ---
// 実測: `public/sitemap.xml` は手書きの静的ファイルで `/`・`/stamps/`・`/egtype/` の3件しか
// 載せていないが、`/noxa/` は **canonical と専用 OG 画像まで持つ索引対象の実ルート**(本番 200)。
// sitemap を作った後に増えたページが誰にも気づかれず落ちたまま、`/stamps/` だけが手で追記
// されていた＝手書き運用は既に一度失敗している。HTTP 検査は全ルートが 200 を返すので
// 死活監視には一生映らず、Day97(無リンクの実ルート)・Day104(索引制御)と同じ
// 「200 が返るせいで見えない索引の穴」。
//
// 判定は3方向。どれか一方向だけだと逆向きの嘘が残る:
//   missing       … 索引対象の実ルートなのに sitemap に無い(＝本 Day が直した欠陥そのもの)
//   stale         … sitemap に居るが実ルートでない(消したページを載せ続ける＝404 を索引へ差し出す)
//   contradictory … noindex を宣言しているのに sitemap に載せている(自己矛盾。クローラへ
//                   「索引するな」と「索引しろ」を同時に渡す)
// cross-repo 領域(既定 /egtype/)は別リポの配信物で app/ に page を持たないため stale から除く。
const SITEMAP_LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/g

/**
 * @param routeEntries [{ route: '/noxa/', src: 'そのルートの page/layout を連結したソース' }]
 * @param sitemapXml   public/sitemap.xml の中身
 * @param origin       自サイトの origin(末尾スラッシュ無し)。metadataBase から導いたもの。
 * @param crossRepoPrefixes stale 判定から除外する別リポ配信の接頭辞
 */
export function findSitemapCoverageGaps(routeEntries, sitemapXml, origin, crossRepoPrefixes = CROSS_REPO_PREFIXES) {
  const locs = [...sitemapXml.matchAll(SITEMAP_LOC_RE)].map((m) => m[1])
  // 自オリジンの loc だけをルートへ還元する。別オリジンの loc は portal のルート集合と
  // 突合できない(＝stale 判定の対象外)ので、そのまま素通りさせる。
  const ownPaths = new Set(
    locs.filter((u) => u === origin || u.startsWith(`${origin}/`))
      .map((u) => normalizeRoutePath(u.slice(origin.length) || '/')),
  )
  const known = new Set(routeEntries.map((e) => e.route))
  const missing = []
  const contradictory = []
  for (const { route, src } of routeEntries) {
    const noindex = NOINDEX_RE.test(src)
    if (noindex && ownPaths.has(route)) contradictory.push(route)
    if (!noindex && !ownPaths.has(route)) missing.push(route)
  }
  const stale = [...ownPaths]
    .filter((p) => !known.has(p))
    .filter((p) => !crossRepoPrefixes.some((pre) => p.startsWith(pre)))
  return { missing, stale, contradictory, locCount: locs.length }
}

// --- robots.txt の Sitemap 宣言(Day110) ---
// Day107 は sitemap.xml の**中身**(実ルートを網羅しているか)を固定したが、その sitemap を
// クローラへ知らせる唯一の宣言である robots.txt の `Sitemap:` 行は誰も検査していなかった。
// 実測では2行(自前 / egtype 配信)とも 200 だが、無検査ということは
//   ・申告した sitemap を誰も出力しなくなっても気づかない(死んだ入口を出し続ける)
//   ・sitemap を増やしても申告し忘れたまま気づかない(発見経路が1本減る)
//   ・オリジンを書き間違えても気づかない(別サイトの sitemap 宣言はクロールに使われない)
// のどれもが起きたまま「✓ 全件OK」と出る。sitemap 側と同じく**双方向**で突合する。
const ROBOTS_SITEMAP_RE = /^[^\S\r\n]*Sitemap[^\S\r\n]*:[^\S\r\n]*(\S+)[^\S\r\n]*$/gim

/**
 * @param robotsTxt          public/robots.txt の中身
 * @param origin             自サイトの origin(末尾スラッシュ無し)
 * @param publicSitemapPaths public/ に実在する sitemap のパス(['/sitemap.xml'] 形式)
 * @param crossRepoPrefixes  別リポ配信の接頭辞(実体を portal 側に持たないので実在検査から除く)
 * @returns { issues, declared } declared は宣言された URL 全件(0件を致命化する floor の根拠)
 */
export function findRobotsSitemapIssues(robotsTxt, { origin, publicSitemapPaths, crossRepoPrefixes = CROSS_REPO_PREFIXES }) {
  const declared = [...robotsTxt.matchAll(ROBOTS_SITEMAP_RE)].map((m) => m[1])
  const issues = []
  const declaredOwnPaths = []
  for (const u of declared) {
    let parsed
    try { parsed = new URL(u) } catch {
      issues.push({ url: u, kind: '不正', why: '絶対URLとして解釈できない(robots.txt の Sitemap は絶対URL必須＝この行は無視される)' })
      continue
    }
    if (parsed.origin !== origin) {
      issues.push({ url: u, kind: '別オリジン', why: `自サイト(${origin})の外を指している。robots.txt の Sitemap 宣言は同一サイトのものしかクロールに使われない` })
      continue
    }
    declaredOwnPaths.push(parsed.pathname)
    // 別リポ配信(/egtype/)の実体は portal のリポに無いので、実在検査ではなく HTTP 側(soft)で見る。
    if (crossRepoPrefixes.some((pre) => parsed.pathname.startsWith(pre))) continue
    if (!publicSitemapPaths.includes(parsed.pathname)) {
      issues.push({ url: u, kind: '実体なし', why: `portal 自前の配信物として申告しているのに public${parsed.pathname} が存在しない(誰も出力しない sitemap を入口として出し続ける)` })
    }
  }
  for (const p of publicSitemapPaths) {
    if (!declaredOwnPaths.includes(p)) {
      issues.push({ url: `${origin}${p}`, kind: '未宣言', why: `public${p} を配信しているのに robots.txt が申告していない(クローラへの発見経路が1本減る)` })
    }
  }
  return { issues, declared }
}

// --- 本番で「実際に配信されている」robots.txt(Day110) ---
// 上の findRobotsSitemapIssues はリポの public/robots.txt を見るが、実測でそれだけでは足りない
// ことが分かった: 本番 `https://egshugy.com/robots.txt` は **1949 バイト**で、リポの 113 バイトとは
// 別物だった。Cloudflare の Managed content(AI クローラ向けの Content-Signal と Disallow 群)が
// **前置**され、リポ由来の行はその後ろに残る形になっている。つまり
//   ・リポをどれだけ厳密に突合しても、本番の robots.txt の中身は保証できない
//   ・前置される側は portal のリポの外(Cloudflare の設定)でいつでも変わる
// robots.txt はサイト全体のクロール可否という**最も広い影響範囲**を持つ1ファイルなのに、
// Day109 まで死活監視の対象にすら入っていなかった(実測: 監視90件に robots.txt も sitemap.xml も
// 1件も無い)。しかも仮に対象へ入れても従来の検査は res.ok しか見ないので、
// **200 のまま中身が別物へ差し替わる**という今回の実態は永久に映らない(Day104 の OG content-type
// と同型)。よって「200 か」ではなく「**その robots.txt がクロールを許しているか / 申告が生きているか**」
// を見る。
//
// 判定(重い順):
//   blocks-all    … `User-agent: *` のグループに `Disallow: /` がある＝サイト全体が索引から消える
//   no-sitemap    … リポは Sitemap を宣言しているのに配信物には1行も無い。デプロイ待ちでは
//                   説明できない(デプロイすれば必ず出る)＝配信側が中身を落としている証拠
//   pending-deploy… リポの宣言の一部だけが未反映。人間ゲートの npm run deploy 待ちで説明できる
//   ok / unreachable
const ROBOTS_GROUP_SPLIT_RE = /\r?\n/
/**
 * robots.txt を「User-agent 行の連なり + 続くルール行」のグループへ分解する。
 * 連続する User-agent 行は同じグループを共有する(RFC 9309 §2.2.1)。
 * @returns [{ agents: ['*'], rules: [{ field: 'disallow', value: '/' }] }]
 */
export function parseRobotsGroups(robotsTxt) {
  const groups = []
  let cur = null
  for (const raw of robotsTxt.split(ROBOTS_GROUP_SPLIT_RE)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const field = m[1].toLowerCase()
    const value = m[2].trim()
    if (field === 'user-agent') {
      // 直前もエージェント宣言だけなら同じグループへ足す(ルールが1行でも入ったら別グループ)。
      if (cur && cur.rules.length === 0) cur.agents.push(value.toLowerCase())
      else { cur = { agents: [value.toLowerCase()], rules: [] }; groups.push(cur) }
      continue
    }
    // Sitemap はグループに属さない非グループディレクティブ(RFC 9309 §2.2.3)。直前の
    // User-agent の規則として混ぜると、rules を「そのエージェントへの指示」として読む
    // 側が実在しない指示を1件多く見ることになる(現状 disallow しか見ていないので実害は
    // 無いが、規則の集合そのものが嘘になっていると後から足す判定が必ず間違う)。
    if (field === 'sitemap') continue
    if (!cur) continue  // グループ外のその他ディレクティブもここでは扱わない
    cur.rules.push({ field, value })
  }
  return groups
}

/**
 * @param served  { status, body } 本番から取得した robots.txt
 * @param declaredSitemapUrls リポの public/robots.txt が宣言している Sitemap URL 全件
 * @returns { verdict, servedSitemaps, missingOnProd, blockedBy }
 */
export function classifyServedRobots({ status, body }, declaredSitemapUrls = []) {
  if (status !== 200 || typeof body !== 'string') {
    return { verdict: 'unreachable', servedSitemaps: [], missingOnProd: [], blockedBy: null }
  }
  const servedSitemaps = [...body.matchAll(ROBOTS_SITEMAP_RE)].map((m) => m[1])
  // `User-agent: *` を含むグループの Disallow: / を探す。値が厳密に '/' のときだけ全面禁止。
  // (`/foo` は部分的な禁止、空値は「何も禁止しない」の意＝ Allow: / と同義)
  const blocking = parseRobotsGroups(body).find(
    (g) => g.agents.includes('*') && g.rules.some((r) => r.field === 'disallow' && r.value === '/'),
  )
  if (blocking) {
    return { verdict: 'blocks-all', servedSitemaps, missingOnProd: [], blockedBy: blocking }
  }
  const missingOnProd = declaredSitemapUrls.filter((u) => !servedSitemaps.includes(u))
  if (declaredSitemapUrls.length > 0 && servedSitemaps.length === 0) {
    return { verdict: 'no-sitemap', servedSitemaps, missingOnProd, blockedBy: null }
  }
  if (missingOnProd.length > 0) {
    return { verdict: 'pending-deploy', servedSitemaps, missingOnProd, blockedBy: null }
  }
  return { verdict: 'ok', servedSitemaps, missingOnProd, blockedBy: null }
}

// --- 本番で配信されている sitemap.xml の中身(Day113) ---
// Day107 は sitemap.xml の**中身**を、Day110 はその**入口**(robots.txt の Sitemap 宣言)を固定した。
// だが固定したのはどちらも**リポの中身**で、実際に配信されている sitemap は誰も見ていなかった。
// Day110 で robots.txt について実測したとおり、本番の配信物はリポと同じとは限らない
// (前置きが入る／デプロイが遅れる／配信側が別物を返す)。しかも 200 は返るので、
// res.ok しか見ない従来の検査には永久に映らない（Day104 の OG content-type と同型）。
//
// 実測(Day113): 本番 `/sitemap.xml` の <loc> は3件で、リポにある `/noxa/` が**無い**
// （Day107 の修正が未反映＝人間ゲートのデプロイ待ち）。この状態は「壊れている」のではなく
// 「まだ届いていない」なので**警告**に留める。致命にすると毎日 red になり検査ごと捨てられる。
//
// 逆に、デプロイ遅れでは説明できない状態＝**配信側が壊している**ものだけを致命にする:
//   ・申告した入口が本番で取得できない(robots.txt は生きているのに sitemap だけ死んでいる)
//   ・200 なのに <loc> が1件も無い(空 or sitemap の体を成していない)
//   ・200 なのに HTML が返る(SPA フォールバックが拡張子付き URL まで飲み込んでいる形。
//     クローラは sitemap として読めないので、申告した意味が丸ごと消える)
//   ・自オリジン外の loc が混ざる(別サイトを索引へ差し出している)
const SITEMAP_HTML_RE = /<html[\s>]/i

/**
 * 本番で配信されている sitemap 1件を分類する。
 * @param res       fetchWithRetry({ wantBody: true }) の戻り（status/body/contentType）
 * @param repoLocs  リポの同じ sitemap が持つ <loc> 全件（stale 判定の基準。空なら比較しない）
 * @param origin    自サイトの origin（末尾スラッシュ無し）
 * @param crossRepoPrefixes 別リポ配信の接頭辞（自オリジン内なので foreign ではない）
 * @returns { verdict, servedLocs, missingOnProd, foreign }
 *   verdict: unreachable | not-xml | empty | foreign | pending-deploy | ok
 */
export function classifyServedSitemap({ status, body, contentType } = {}, { repoLocs = [], origin } = {}) {
  if (status !== 200 || typeof body !== 'string') {
    return { verdict: 'unreachable', servedLocs: [], missingOnProd: [], foreign: [], contentType }
  }
  const servedLocs = [...body.matchAll(SITEMAP_LOC_RE)].map((m) => m[1].trim())
  // <loc> が無い理由を分ける。HTML が返っているなら「配信側が別物を返した」と言い切れる。
  if (servedLocs.length === 0) {
    const verdict = SITEMAP_HTML_RE.test(body) ? 'not-xml' : 'empty'
    return { verdict, servedLocs, missingOnProd: [], foreign: [], contentType }
  }
  const foreign = origin
    ? servedLocs.filter((u) => u !== origin && !u.startsWith(`${origin}/`))
    : []
  if (foreign.length > 0) {
    return { verdict: 'foreign', servedLocs, missingOnProd: [], foreign, contentType }
  }
  // リポにあって本番に無い＝デプロイ待ち（逆向き＝本番にあってリポに無い、も同じくデプロイ遅れで
  // 説明がつく。どちらも「壊れている」ではないので警告側に置く）。
  const served = new Set(servedLocs)
  const missingOnProd = repoLocs.filter((u) => !served.has(u))
  if (missingOnProd.length > 0) {
    return { verdict: 'pending-deploy', servedLocs, missingOnProd, foreign, contentType }
  }
  return { verdict: 'ok', servedLocs, missingOnProd, foreign, contentType }
}

/** 配信 sitemap の verdict が「配信側の破損」か（デプロイ遅れでは説明できないか） */
export function isServedSitemapFatal(verdict) {
  return verdict === 'unreachable' || verdict === 'not-xml' || verdict === 'empty' || verdict === 'foreign'
}

// --- Service Worker ブートストラップの巻き添え(Day107) ---
// 実測: `app/layout.tsx` の SW ブートストラップは
//   getRegistrations().then(rs => Promise.all(rs.map(r => r.unregister())))
//     .then(() => caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))))
//     .then(() => register('/sw.js'))
// だった。`getRegistrations()` は**スコープに関係なくオリジン全体の登録**を返し、`caches.keys()` も
// **オリジン全体の Cache Storage** を返す。egshugy.com には子アプリが同居していて
// `/egtype/sw.js`(egtype の index.html が実際に register している)・`/pekarin-chinchiro/sw.js`・
// `/word-wolf/sw.js`・`/kingscup/sw.js` がいずれも本番 200。つまり **ポータルのトップを開くたびに
// 子アプリ全部の SW 登録とプリキャッシュが毎回消える**(オフライン能力の喪失＋再訪のたびに全再取得)。
// ポータル⇄子アプリは相互リンクなので通常動線でそのまま踏む。元は yorulog の SW 汚染端末の救済
// だったが、救済の副作用が**汚染の無い平常時にも常時**効いていた。
//
// 修正後の不変条件は「無条件の全消しをしないこと」の2点:
//   ①登録の列挙結果を絞らずに unregister へ流さない(スコープ or scriptURL で自分の領分に限定する)
//   ②caches.keys() の結果を絞らずに delete へ流さない
// HTTP 検査では何も起きない(全ルートが 200)ので、退行してもガードが無ければ永久に無検知。
const SW_ENUM_RE = /getRegistrations\s*\(\s*\)/
const SW_CACHE_KEYS_RE = /caches\s*\.\s*keys\s*\(\s*\)/
// 列挙結果 rs を .filter を通さずそのまま .map(r => r.unregister()) へ渡している形。
const SW_UNFILTERED_UNREGISTER_RE = /getRegistrations\s*\(\s*\)[\s\S]{0,200}?\.then\s*\(\s*(?:\(\s*)?([A-Za-z_$][\w$]*)\s*\)?\s*=>[\s\S]{0,200}?\1\s*\.\s*map\s*\(/
// キー列挙 ks を .filter を通さずそのまま .map(k => caches.delete(k)) へ渡している形。
const SW_UNFILTERED_CACHE_DELETE_RE = /caches\s*\.\s*keys\s*\(\s*\)[\s\S]{0,200}?\.then\s*\(\s*(?:\(\s*)?([A-Za-z_$][\w$]*)\s*\)?\s*=>[\s\S]{0,200}?\1\s*\.\s*map\s*\(/
// 反転形(Day110): filter はあるが条件が `k !== CACHE_NAME` だけ＝「自分の現行**以外は全部**消す」。
// caches.keys() はオリジン全体を返すので、これは絞り込みではなく他アプリの全消しそのもの。
// 上の2規則は「filter があれば白」と読むため、この形は素通りしていた。
// 肯定形の所有判定(`k.startsWith(PREFIX) && k !== CACHE_NAME`)は `=>` の直後が識別子の
// 比較で終わらないので一致しない＝修正形を誤検知しない。
const SW_NAME_ONLY_FILTER_RE = /caches\s*\.\s*keys\s*\(\s*\)[\s\S]{0,200}?\.filter\s*\(\s*(?:function\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*(?:=>|\{\s*return)\s*\1\s*!==?\s*[A-Za-z_$][\w$.]*\s*[)}]/

/**
 * SW ブートストラップが「オリジン全体を無条件に巻き込む」形に退行していないか。
 * @returns { offenders: [{kind, why}], scanned } scanned は SW を触るソースの数(母集団 floor 用)
 */
export function findOriginWideSwWipes(entries) {
  const offenders = []
  let scanned = 0
  for (const { file, src } of entries) {
    const touchesSw = SW_ENUM_RE.test(src) || SW_CACHE_KEYS_RE.test(src)
    if (!touchesSw) continue
    scanned++
    if (SW_UNFILTERED_UNREGISTER_RE.test(src)) {
      offenders.push({ file, kind: 'SW登録', why: 'getRegistrations() の結果を絞らず全件 unregister している（同一オリジンの子アプリ /egtype/ 等の SW まで毎回消える）' })
    }
    if (SW_UNFILTERED_CACHE_DELETE_RE.test(src)) {
      offenders.push({ file, kind: 'キャッシュ', why: 'caches.keys() の結果を絞らず全件 delete している（子アプリのプリキャッシュまで毎回消える）' })
    } else if (SW_NAME_ONLY_FILTER_RE.test(src)) {
      offenders.push({ file, kind: 'キャッシュ', why: 'caches.keys() を「自分の現行キャッシュ以外」で絞って delete している（絞り込みに見えて、同居する子アプリのプリキャッシュを全部消す形）' })
    }
  }
  return { offenders, scanned }
}

// --- bot 対策のチャレンジで阻まれた応答(Day116) ---
// 実測: portal がトップ・NOXA ページ・フッターの3箇所から張っている
// `https://nomishugy.vercel.app/coming-soon` は、ブラウザの UA では 200 を返すのに
// 死活監視の UA では **403 + `x-vercel-mitigated: challenge`**（Vercel の Attack Challenge）。
// リンクは生きていて実ユーザーには見えるのに、監視だけが恒常的に 403 を掴み hard 致命 →
// cron が毎日 red になる。false-red は「本物のリンク切れを埋もれさせる」ので、Day85 の
// 一時失敗と同じく**検知力を落とさずに分ける**必要がある。
//
// ただし「403 を許す」形にはしない。それでは本物の権限エラー・公開停止まで見逃す。
// **チャレンジであることを名乗るヘッダがある応答だけ**を別状態として持つ
// （Day114 の「異常を値として持てるか」・Day108 の「正常な空と壊れた空を同じ値で表さない」と同系列）。
// 到達性の判定は「不能」であって「OK」ではないので、呼び出し側は緑と混ぜず警告として出すこと。
export const CHALLENGE_HEADERS = [
  'x-vercel-mitigated',      // Vercel: challenge / block
  'cf-mitigated',            // Cloudflare: challenge
  'x-vercel-challenge-token',// Vercel: チャレンジ本体が返るときのトークン
  'cf-chl-bypass',           // Cloudflare: チャレンジページの目印
]
// チャレンジで返りうるステータス。200 は「中身が返っている」ので対象外
// （チャレンジ HTML を 200 で返す構成もあるが、それを含めると本物の 200 まで
//   判定不能に化けるため、ここでは踏み込まない）。
const CHALLENGE_STATUSES = new Set([401, 403, 429, 503])

/**
 * bot 対策のチャレンジに阻まれた応答か（＝リンクの生死が判定できない状態）。
 * @param status HTTP ステータス
 * @param challengeHeaders 上記ヘッダ名 → 値（小文字キー・無いものは省略/null）
 */
export function isBotChallenge({ status, challengeHeaders = {} } = {}) {
  if (!CHALLENGE_STATUSES.has(status)) return false
  const mitigated = (challengeHeaders['x-vercel-mitigated'] ?? challengeHeaders['cf-mitigated'] ?? '').toString().toLowerCase()
  if (mitigated === 'challenge') return true
  return Boolean(challengeHeaders['x-vercel-challenge-token'] || challengeHeaders['cf-chl-bypass'])
}

/**
 * 死活結果の振り分け(Day116 / Day119 で網羅化)。「失敗」を1つの箱に入れず、**誰が直せるか**で分ける。
 *   hardBad          … portal 自身が直せる失敗（判定不能な自前も含む＝死活が測れないのは異常）
 *   softBad          … egtype 配信待ち（既存の逃がし弁）
 *   challengedExternal … 外部が bot 対策で判定不能（相手側の設定＝portal では直せない・警告）
 *   challengedSoft   … egtype 配信が bot 対策で判定不能（このリポでは直せない・警告）
 *   externalBlind / softBlind … その領域が**全件**判定不能（逃がし弁が広がって検知が空洞化＝致命）
 * 分類を本体のフィルタ式に散らすと、条件が1つずれただけで「全部警告」に倒れても
 * 出力は緑のまま変わらない。ここに集約して規則そのものをテストできる形にする。
 *
 * Day119 の欠陥: Day116 は3つの箱を「外部×判定不能」「自前(非soft)」「soft×判定可」で書いたため、
 * **soft × 判定不能** の組合せがどの箱にも入らなかった。egtype 配信の1本が bot 対策で測れないと
 * それは ✗ にも ⚠ にも出ず、softBad にも数えられず、結果 `✓ 全N件 OK` と名乗って exit 0 する
 * ——**失敗が存在するのに全件 OK と言う**（実測で再現）。分類は網羅していなければ集計の嘘になる。
 * そこで `unclassified` を返し、**どの箱にも入らない失敗が出たら本体が致命化**する（次に規則を
 * 増やすときも、漏れは緑ではなく赤で出る）。
 */
export function partitionLinkResults(results, { externalCount = 0, softCount = 0 } = {}) {
  const failed = results.filter((r) => !r.ok)
  const challengedExternal = failed.filter((r) => r.challenged && r.owner === 'external')
  const challengedSoft = failed.filter((r) => r.challenged && r.soft)
  const hardBad = failed.filter((r) => !r.soft && !(r.challenged && r.owner === 'external'))
  const softBad = failed.filter((r) => r.soft && !r.challenged)
  // 網羅の検算。箱の合計と失敗の総数が合わなければ、どこにも入らなかった結果が居る。
  const boxed = new Set([...hardBad, ...softBad, ...challengedExternal, ...challengedSoft])
  const unclassified = failed.filter((r) => !boxed.has(r))
  return {
    hardBad,
    softBad,
    challengedExternal,
    challengedSoft,
    unclassified,
    externalBlind: externalCount > 0 && challengedExternal.length === externalCount,
    softBlind: softCount > 0 && challengedSoft.length === softCount,
  }
}
