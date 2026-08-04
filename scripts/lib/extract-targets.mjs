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
const PAGE_FILE_RE = /^page\.(?:tsx|ts|jsx|js)$/
const ROUTE_GROUP_RE = /^\(.*\)$/
const DYNAMIC_SEG_RE = /^\[.*\]$/

export function routesFromPageFiles(files) {
  const routes = new Set()
  const skipped = []
  for (const file of files) {
    const parts = file.split('/')
    const base = parts.pop()
    if (!PAGE_FILE_RE.test(base)) continue
    // `_foo` はプライベートフォルダでルーティングされない(Next.js の規約)
    if (parts.some((s) => s.startsWith('_'))) continue

    const segs = []
    let skip = null
    for (const s of parts) {
      if (ROUTE_GROUP_RE.test(s)) continue // ルートグループは URL に出ない
      if (s.startsWith('@')) { skip = 'パラレルルート(単独URLを持たない)'; break }
      if (DYNAMIC_SEG_RE.test(s)) { skip = '動的セグメント(URLが実引数依存)'; break }
      segs.push(s)
    }
    if (skip) skipped.push({ file, reason: skip })
    else routes.add(segs.length ? `/${segs.join('/')}/` : '/')
  }
  return { routes: [...routes], skipped }
}
