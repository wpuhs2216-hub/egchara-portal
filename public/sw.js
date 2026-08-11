// サービスワーカー - ネットワークファースト + オフラインフォールバック
// キャッシュ名は必ず CACHE_PREFIX で始める。egshugy.com には子アプリ(egtype /
// pekarin-chinchiro / word-wolf / kingscup)が同居していて Cache Storage は
// **オリジン単位で共有**されるため、「どれが自分のものか」を名前だけで判定できないと
// 後片付けが他所のアプリの破壊になる(下記 activate 参照)。
const CACHE_PREFIX = 'portal-'
const CACHE_NAME = `${CACHE_PREFIX}v1`

self.addEventListener('install', () => self.skipWaiting())

// 旧版の後片付け。従来は `keys.filter((key) => key !== CACHE_NAME)` ＝**自分の現行キャッシュ
// 以外を全部消す**形だった。caches.keys() はスコープではなく**オリジン全体**を返すので、
// これは「同居する子アプリのプリキャッシュを全部消す」と同義。偽 caches 上で実走させて
// 実測したところ、activate 1回で egtype-v136 / pekarin-chinchiro-v3 / word-wolf-v2 /
// kingscup-v1 の4件が消えた(Day110)。activate は初回インストール時と sw.js の内容が
// 変わるたび(install が skipWaiting するので即時)に走る＝デプロイのたびに全員のオフライン
// 能力を巻き添えで落とす。Day107 は app/layout.tsx のブートストラップ側だけを直しており、
// **恒久的に居座る SW 本体のこの行が残っていた**。
// 消してよいのは「自分の接頭辞を持つ かつ 現行ではない」キャッシュだけ。
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
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
