// リンク死活チェッカー — featured-apps の内部リンク / 主要外部リンク / 32キャラ画像を実リクエストで確認する。
// 使い方:
//   node scripts/check-links.mjs             # 本番 (https://egshugy.com) に対して確認
//   node scripts/check-links.mjs --base http://192.168.0.77   # オリジン直叩き
// 終了コード: 全OK=0 / 失敗あり=1（cron・手動どちらでも使える）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const baseIdx = process.argv.indexOf('--base')
const BASE = baseIdx > -1 ? process.argv[baseIdx + 1].replace(/\/$/, '') : 'https://egshugy.com'

// 1) featured-apps.tsx から内部リンクを抽出（comingSoon=false のもののみ）
const featured = fs.readFileSync(path.join(ROOT, 'components/featured-apps.tsx'), 'utf8')
const internal = [...featured.matchAll(/href: "(\/[a-z0-9-]+\/)", comingSoon: (true|false)/g)]
  .filter((m) => m[2] === 'false')
  .map((m) => m[1])

// 2) page.tsx の ALL_CHARACTERS から32キャラ画像URLを生成
const page = fs.readFileSync(path.join(ROOT, 'app/page.tsx'), 'utf8')
const charIds = [...page.matchAll(/\{ id: "([A-Za-z]+)", name: "/g)].map((m) => m[1])
const charImages = charIds.map((id) => `/egtype/characters/${id}.webp`)

// 3) 主要外部リンク（tsx から https を素朴に抽出し、CDN/フォント等のノイズを除外）
const EXCLUDE = /w3\.org|fonts\.|line-scdn|embed\.js|placeholder/
const externals = [...new Set(
  [...(page + featured).matchAll(/https:\/\/[a-zA-Z0-9./_-]+/g)].map((m) => m[0])
)].filter((u) => !EXCLUDE.test(u))

async function check(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (egchara-linkcheck)' },
    })
    return { url, status: res.status, ok: res.ok }
  } catch (e) {
    return { url, status: 0, ok: false, err: e.name }
  }
}

const targets = [
  ...internal.map((p) => BASE + p),
  ...charImages.map((p) => BASE + p),
  ...externals,
]

console.log(`[check-links] base=${BASE} 内部${internal.length} + キャラ画像${charImages.length} + 外部${externals.length} = ${targets.length}件`)
const results = await Promise.all(targets.map(check))
const bad = results.filter((r) => !r.ok)

for (const r of results) {
  if (!r.ok) console.log(`  ✗ ${r.status || r.err}  ${r.url}`)
}
if (bad.length === 0) {
  console.log(`[check-links] ✓ 全${results.length}件 OK`)
  process.exit(0)
} else {
  console.log(`[check-links] ✗ ${bad.length}/${results.length} 件が失敗`)
  process.exit(1)
}
