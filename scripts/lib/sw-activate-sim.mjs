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
