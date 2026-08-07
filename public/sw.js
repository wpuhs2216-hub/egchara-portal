// サービスワーカー - ネットワークファースト + オフラインフォールバック
const CACHE_NAME = 'portal-v1'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  )
})

// 従来は GET というだけで応答を無条件に cache.put しており、偽 caches 上で実走させて
// 2つの欠陥を実測した(Day107):
//   ① cross-origin の no-cors 応答(type: 'opaque'。GA スクリプト・LINE スタンプ画像等)を
//      cache.put へ渡すと仕様上 TypeError で拒否される＝ページ表示のたびに未処理の拒否が出る。
//      拒否は握り潰されるのでキャッシュされないだけだが、ずっとエラーを出し続けていた。
//   ② 404 などのエラー応答もそのまま保存され、次にオフラインになると caches.match が
//      その404を返す＝**オフライン時にエラーページが焼き付く**。
// よって保存対象を「自オリジン かつ 成功応答 かつ opaque でないもの」に限定する。
// フォールバック(caches.match)側は据え置き＝オフライン時の挙動は退化させない。
// 自オリジンの /egtype/** は除外しない: ポータルのトップが図鑑カードで
// /egtype/characters/*.webp を実際に表示しており、これは**ポータル自身の表示資材**。
// egtype のページ自体は自前の SW(スコープ /egtype/)が握るのでここには来ない。
function isCacheable(request, response) {
  if (!response || !response.ok) return false
  if (response.type === 'opaque' || response.type === 'opaqueredirect') return false
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return false
  return true
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (isCacheable(event.request, response)) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {})
        }
        return response
      })
      .catch(() => caches.match(event.request))
  )
})
