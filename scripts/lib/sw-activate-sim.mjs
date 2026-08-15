// Service Worker の activate を偽 ServiceWorkerGlobalScope 上で**実走**させ、
// 「オリジン上のどのキャッシュを消したか」を実測するためのシミュレータ(Day110)。
//
// なぜ静的検査(正規表現)ではなく実走なのか:
//   Day107 は同クラスの巻き添えを正規表現で固定したが、その規則は「caches.keys() の結果を
//   .filter を通さず .map へ流したら黒」という形だった。ところが実際に残っていた欠陥は
//   `keys.filter((key) => key !== CACHE_NAME)` ＝**filter はあるが、条件が「自分の現行以外は
//   全部消す」**という反転形で、規則の上では白に見える。「絞っているか」ではなく
//   「結果として他人のものを消したか」を見ないと、この形は永久に捕まらない。
//
// 所有判定もソースを読まずに決める: SW が fetch で `caches.open()` に渡す名前が、定義上
// その SW 自身のキャッシュ。そこから接頭辞を導くので、定数名や記法が変わっても追随する。
import vm from 'node:vm'

/** CACHE_NAME から所有接頭辞を導く(最後の "-" まで)。区切りが無ければ null＝所有が名前で判定不能。 */
export function ownPrefixOf(cacheName) {
  if (typeof cacheName !== 'string') return null
  const i = cacheName.lastIndexOf('-')
  return i > 0 ? cacheName.slice(0, i + 1) : null
}

/**
 * SW ソースを偽スコープで実走させ、自分のキャッシュ名と activate の削除対象を実測する。
 * @param swSource public/sw.js の中身
 * @param origin   配信オリジン(自オリジン判定に使われる)
 * @param foreignKeys 同居する子アプリのキャッシュ名(実在名を渡すこと)
 * @returns {Promise<{cacheName, ownPrefix, deleted, foreignDeleted, ownStaleKey, hasActivate, hasFetch}>}
 */
export async function simulateSwActivate(swSource, { origin, foreignKeys }) {
  const listeners = new Map()
  let openedName = null
  let keys = []
  const deleted = []

  const caches = {
    keys: async () => [...keys],
    delete: async (k) => { deleted.push(k); return true },
    open: async (name) => { openedName = name; return { put: async () => {} } },
    match: async () => undefined,
  }
  const self = {
    location: { origin },
    addEventListener: (type, fn) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  }
  const response = { ok: true, status: 200, type: 'basic', clone: () => ({ __clone: true }) }
  const ctx = { self, caches, URL, Promise, console, fetch: async () => response }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(swSource, ctx)

  const hasActivate = listeners.has('activate')
  const hasFetch = listeners.has('fetch')

  // ① 自分のキャッシュ名を実測する: 自オリジンの成功 GET を1本流すと、保存先として
  //    caches.open() に渡された名前が出る。これがこの SW の所有物。
  if (hasFetch) {
    const pending = []
    listeners.get('fetch')({
      request: { url: `${origin}/index.html`, method: 'GET' },
      respondWith: (p) => pending.push(p),
    })
    await Promise.all(pending).catch(() => {})
    // cache.put は respondWith の解決後に非同期で走るので1ティック待つ
    await new Promise((r) => setImmediate(r))
  }
  const cacheName = openedName
  const ownPrefix = ownPrefixOf(cacheName)

  // ② オリジンを「自分の現行 + 自分の旧版 + 同居アプリ」で埋めて activate を走らせる。
  //    自分の旧版を1件必ず混ぜるのは下限のため: 何も消さない no-op へ退化しても
  //    「他人のものを消していない」だけは満たされてしまい、検査が空洞になる。
  const ownStaleKey = ownPrefix ? `${ownPrefix}__stale__` : null
  keys = [...(cacheName ? [cacheName] : []), ...(ownStaleKey ? [ownStaleKey] : []), ...foreignKeys]

  if (hasActivate) {
    const waits = []
    listeners.get('activate')({ waitUntil: (p) => waits.push(p) })
    await Promise.all(waits)
  }

  return {
    cacheName,
    ownPrefix,
    ownStaleKey,
    deleted: [...deleted],
    foreignDeleted: deleted.filter((k) => foreignKeys.includes(k)),
    hasActivate,
    hasFetch,
  }
}

/**
 * オフライン時のフォールバックが **どのキャッシュから** 応答を取るかを実走で測る(Day122)。
 *
 * Day107/110/112 は delete / unregister の範囲を三度絞ったが、**読み出しの範囲**は
 * 一度も見ていなかった。無名の `caches.match(request)` は Cache Storage を**オリジン全体**
 * から探すので、同居する子アプリや、救済対象の端末に残った他所製 SW の孤児キャッシュが
 * 同じ URL を持っていれば、それが portal の応答として返る。書き方(正規表現)ではなく
 * 「結果としてどこから返したか」で見るのは activate のシミュレータと同じ理由。
 *
 * @returns {Promise<{source: 'origin-wide'|'none'|string}>} source は 'origin-wide'(全体検索)
 *          / 取り出したキャッシュ名 / 'none'(フォールバックが無い)
 */
export async function simulateSwOfflineFallback(swSource, { origin }) {
  const listeners = new Map()
  let openedForRead = null
  const caches = {
    keys: async () => [],
    delete: async () => true,
    // オリジン全体を検索する無名 match。ここから返ったら「他所のキャッシュも候補」の証拠。
    match: async () => ({ __from: 'origin-wide' }),
    open: async (name) => ({
      put: async () => {},
      match: async () => { openedForRead = name; return { __from: name } },
    }),
  }
  const self = {
    location: { origin },
    addEventListener: (type, fn) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  }
  // ネットワークは落ちている＝必ず catch 側(フォールバック)へ入る
  const ctx = { self, caches, URL, Promise, console, fetch: async () => { throw new Error('offline') } }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(swSource, ctx)

  if (!listeners.has('fetch')) return { source: 'none' }
  let responded = null
  listeners.get('fetch')({
    request: { url: `${origin}/`, method: 'GET' },
    respondWith: (p) => { responded = p },
  })
  const res = await Promise.resolve(responded).catch(() => null)
  if (!res) return { source: 'none' }
  return { source: res.__from ?? (openedForRead ? openedForRead : 'none') }
}

/**
 * SW を偽スコープで実走させ、**何をキャッシュに書いたか**を実測する(Day128)。
 *
 * activate(消す側)と offline フォールバック(読む側)には実走のシミュレータがあったが、
 * **書く側だけは一度も踏まれていなかった**——Day107 が置いた「自オリジン かつ 成功応答 かつ
 * opaque でない」という規則は、ソースを読めば確かにそこに在るが、`isCacheable` を消しても
 * 条件を1つ緩めても、テストは全部緑のままだった。規則ではなく結果を見る(Day110 と同じ理由)。
 *
 * 書く側が緩むと起きること: ①opaque 応答を put すると仕様上 TypeError＝ページ表示のたびに
 * 未処理の拒否 ②404 を保存すると次にオフラインになった回に**エラーページが焼き付く**
 * ③第三者の応答を保存すると、オリジン共有の Cache Storage を同居アプリと奪い合う。
 *
 * @param swSource public/sw.js の中身
 * @param origin   自オリジン
 * @param cases    [{ label, url, status, type }] 応答の種類。type は 'basic'|'cors'|'opaque' 等
 * @returns {Promise<{written: string[], hasFetch: boolean}>} written は put された URL のラベル
 */
export async function simulateSwCacheWrites(swSource, { origin, cases }) {
  const listeners = new Map()
  const written = []
  const caches = {
    keys: async () => [],
    delete: async () => true,
    match: async () => undefined,
    open: async () => ({
      put: async (req) => { written.push(typeof req === 'string' ? req : req.url) },
      match: async () => undefined,
    }),
  }
  const self = {
    location: { origin },
    addEventListener: (type, fn) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  }
  let current = null
  const ctx = {
    self, caches, URL, Promise, console,
    fetch: async () => ({
      ok: current.status >= 200 && current.status < 300,
      status: current.status,
      type: current.type,
      clone: () => ({ __clone: true }),
    }),
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(swSource, ctx)
  if (!listeners.has('fetch')) return { written, hasFetch: false }

  for (const c of cases) {
    current = c
    let responded = null
    listeners.get('fetch')({
      // destination はブラウザが与える値。既定は資産(script)として踏む。
      request: { url: c.url, method: c.method ?? 'GET', destination: c.destination ?? 'script' },
      respondWith: (p) => { responded = p },
    })
    await Promise.resolve(responded).catch(() => null)
    // put は respondWith の外で走る（await されていない）ので1ティック待つ
    await new Promise((r) => setImmediate(r))
  }
  return { written, hasFetch: true }
}
