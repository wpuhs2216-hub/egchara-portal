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
const baseArg = baseIdx > -1 ? process.argv[baseIdx + 1] : null
if (baseIdx > -1 && !baseArg) { console.error('--base にはURLを指定してください'); process.exit(2) }
const BASE = (baseArg ?? 'https://egshugy.com').replace(/\/$/, '')

// 1) featured-apps.tsx から内部リンクを抽出（comingSoon=false のもののみ）
const featured = fs.readFileSync(path.join(ROOT, 'components/featured-apps.tsx'), 'utf8')
const internal = [...featured.matchAll(/href: "(\/[a-z0-9-]+\/)", comingSoon: (true|false)/g)]
  .filter((m) => m[2] === 'false')
  .map((m) => m[1])

// 2) page.tsx の ALL_CHARACTERS から32キャラ画像URLを生成
const page = fs.readFileSync(path.join(ROOT, 'app/page.tsx'), 'utf8')
const charIds = [...page.matchAll(/\{ id: "([A-Za-z]+)", name: "/g)].map((m) => m[1])
const charImages = charIds.map((id) => `/egtype/characters/${id}.webp`)

// 3) 主要外部リンク（components/ と app/ の全 tsx から抽出し、CDN/フォント等のノイズを除外）
const EXCLUDE = /w3\.org|fonts\.|line-scdn|embed\.js|placeholder|schema\.org/
function collectTsx(dir) {
  let out = ''
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out += collectTsx(full)
    else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) out += fs.readFileSync(full, 'utf8')
  }
  return out
}
const allSrc = collectTsx(path.join(ROOT, 'components')) + collectTsx(path.join(ROOT, 'app'))
const externals = [...new Set(
  [...allSrc.matchAll(/https:\/\/[a-zA-Z0-9./_-]+/g)].map((m) => m[0])
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
