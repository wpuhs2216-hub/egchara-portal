// リンク死活チェッカー — featured-apps の内部リンク / 主要外部リンク / 32キャラ画像を実リクエストで確認する。
// 使い方:
//   node scripts/check-links.mjs             # 本番 (https://egshugy.com) に対して確認
//   node scripts/check-links.mjs --base http://192.168.0.77   # オリジン直叩き
//   node scripts/check-links.mjs --strict    # egtype依存の型ページ(soft)404も致命扱い
// 終了コード: portal自前リンク失敗=1 / soft(egtype型ページ)失敗は既定で警告のみ(0)・--strictで1
//   (egtype と portal はセットでデプロイ。egtype 未デプロイ中の新16体型ページ404は想定内)
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

// 2) page.tsx の ALL_CHARACTERS から32キャラ画像URL + 図鑑カードのディープリンク先(types)を生成
const page = fs.readFileSync(path.join(ROOT, 'app/page.tsx'), 'utf8')
const charIds = [...page.matchAll(/\{ id: "([A-Za-z]+)", name: "/g)].map((m) => m[1])
const charImages = charIds.map((id) => `/egtype/characters/${id}.webp`)
// 図鑑カードは /egtype/types/<id>/ へディープリンクする（Day23）。リンク切れを死活監視する。
const charPages = charIds.map((id) => `/egtype/types/${id}/`)

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

// カテゴリ分離: portal自前で常時live であるべきもの(hard)と、egtype の別デプロイに
// 依存する型ページ・ディープリンク(soft)を分ける。type ページは egtype 本番デプロイ後に
// 有効化される(portal と egtype はセットでデプロイする運用)。egtype 未デプロイ中に
// 新16体の /egtype/types/<id>/ が404になるのは既知・想定内で、portal の cron 定点観測を
// 常時 red にしない。--strict 指定時のみ soft 失敗も致命(exit 1)にする。
const STRICT = process.argv.includes('--strict')
const targets = [
  ...internal.map((p) => ({ url: BASE + p, cat: '内部', soft: false })),
  ...charImages.map((p) => ({ url: BASE + p, cat: 'キャラ画像', soft: false })),
  ...charPages.map((p) => ({ url: BASE + p, cat: 'キャラ型頁', soft: true })),
  ...externals.map((u) => ({ url: u, cat: '外部', soft: false })),
]

console.log(`[check-links] base=${BASE} 内部${internal.length} + キャラ画像${charImages.length} + キャラ型頁${charPages.length}(soft) + 外部${externals.length} = ${targets.length}件${STRICT ? ' [strict]' : ''}`)
const results = await Promise.all(targets.map(async (t) => ({ ...t, ...(await check(t.url)) })))
const hardBad = results.filter((r) => !r.ok && !r.soft)
const softBad = results.filter((r) => !r.ok && r.soft)

for (const r of hardBad) console.log(`  ✗ ${r.status || r.err}  [${r.cat}] ${r.url}`)
for (const r of softBad) console.log(`  ⚠ ${r.status || r.err}  [${r.cat}] ${r.url}`)

if (softBad.length > 0) {
  console.log(`[check-links] ⚠ egtype依存(soft) ${softBad.length}/${charPages.length} 件が未到達 — egtype 本番デプロイ待ちなら想定内(portal と egtype はセットでデプロイ)。デプロイ後は --strict で厳格確認。`)
}

const fatal = hardBad.length > 0 || (STRICT && softBad.length > 0)
if (!fatal && hardBad.length === 0 && softBad.length === 0) {
  console.log(`[check-links] ✓ 全${results.length}件 OK`)
  process.exit(0)
} else if (!fatal) {
  console.log(`[check-links] ✓ portal自前 ${results.length - softBad.length}/${results.length - softBad.length} 件 OK（soft ${softBad.length}件は警告のみ）`)
  process.exit(0)
} else {
  console.log(`[check-links] ✗ 致命 ${hardBad.length}件${STRICT ? ` + soft ${softBad.length}件` : ''} / 全${results.length}件`)
  process.exit(1)
}
