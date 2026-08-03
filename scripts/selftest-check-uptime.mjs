// check-uptime のドリフト検知規則そのものを検証する selftest（Day94）。
//
// check-uptime は「稼働日数の日数差を自前でインラインしていない」ことを毎日見張るガードだが、
// その検知規則(旧: getTime() + 1000*60*60*24 の1綴り)が壊れていても出力は「✓ 全チェック通過」
// になるため、実行結果からは気づけない。実測で `/ 86400000` 直書き・`Date.parse()` 経由・
// 逆順綴り(24*60*60*1000)の3種がすべて素通りしていた。
//
// ここでは①検知規則(純関数)の陽性/陰性、②ガード本体への配線(違反ページを置くと exit 1 になる)
// の両方を固定する。②は UPTIME_APP_DIR override でフィクスチャを見せるだけなので正本は触らない。
//
// 実行: node scripts/selftest-check-uptime.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { findInlineDayDiff, DAY_MS_SPELLING_COUNT } from './lib/detect-inline-daydiff.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
function ok(label, cond) {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}`)
  }
}

// --- ① 検知規則: 陽性（どれも下限クランプが無く「-N日」を表示しうる書き方） ---
console.log('[selftest-check-uptime] 日数差インラインの検知(陽性)')
const POSITIVE = {
  '旧規則が唯一見ていた綴り(getTime + 1000*60*60*24)':
    'const days = Math.floor((Date.now() - new Date(O).getTime()) / (1000 * 60 * 60 * 24))',
  '86400000 の直書き':
    'const days = Math.floor((Date.now() - new Date(O).getTime()) / 86400000)',
  '数値区切り付き 86_400_000':
    'const days = Math.floor((Date.now() - new Date(O).getTime()) / 86_400_000)',
  '指数表記 8.64e7':
    'const days = Math.floor((Date.now() - new Date(O).getTime()) / 8.64e7)',
  'getTime() を経由しない Date.parse':
    'const days = Math.floor((Date.now() - Date.parse(O)) / (1000 * 60 * 60 * 24))',
  '単項プラスの +new Date':
    'const days = Math.floor((Date.now() - +new Date(O)) / 86400000)',
  '逆順綴り 24*60*60*1000':
    'const days = Math.floor((Date.now() - new Date(O).getTime()) / (24 * 60 * 60 * 1000))',
  '3600 を使う綴り':
    'const days = Math.floor((Date.now() - new Date(O).getTime()) / (1000 * 3600 * 24))',
  '改行で整形されていても検知する':
    'const days = Math.floor(\n  (Date.now() - new Date(O).getTime()) /\n    86400000\n)',
}
for (const [label, src] of Object.entries(POSITIVE)) {
  ok(label, findInlineDayDiff(src).length > 0)
}

// --- ② 検知規則: 陰性（誤検知させてはいけない書き方） ---
console.log('[selftest-check-uptime] 誤検知しない(陰性)')
const NEGATIVE = {
  'daysSince に集約された正しい呼び出し': 'setDays(daysSince("2026-02-20T00:00:00+09:00"))',
  '設定値としての 86400（秒・除算でない）': 'export const revalidate = 86400',
  'キャッシュ max-age の直書き（時刻取得が無い）': 'headers: { "Cache-Control": "max-age=86400000" }',
  '時刻差だが日数以外で割っている（時間表示）':
    'const hours = Math.floor((Date.now() - new Date(O).getTime()) / 3600000)',
  '日数のミリ秒だが乗算（期限の加算）':
    'const expires = new Date(Date.now() + 86400000)',
}
for (const [label, src] of Object.entries(NEGATIVE)) {
  ok(label, findInlineDayDiff(src).length === 0)
}
ok('検知規則の綴りが空になっていない', DAY_MS_SPELLING_COUNT >= 5)

// --- ③ ガード本体への配線（フィクスチャを見せて exit code を確認する） ---
console.log('[selftest-check-uptime] check-uptime 本体への配線')
const VALID_TOP = 'import { daysSince } from "@/lib/uptime"\nexport default function P() { return <p>{daysSince("2026-02-20")}</p> }\n'
const work = mkdtempSync(path.join(tmpdir(), 'uptime-selftest-'))
function runGuard(files) {
  const dir = mkdtempSync(path.join(work, 'app-'))
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'check-uptime.mjs')], {
    cwd: ROOT,
    env: { ...process.env, UPTIME_APP_DIR: dir },
    encoding: 'utf8',
  })
  return r.status
}
try {
  ok('健全なフィクスチャでは通過(exit 0)', runGuard({ 'page.tsx': VALID_TOP }) === 0)
  ok(
    '86400000 直書きの再インラインを検知して exit 1（旧規則では素通りしていた）',
    runGuard({
      'page.tsx': VALID_TOP,
      'workspaces/page.tsx': `export default function W() {\n  const days = Math.floor((Date.now() - new Date("2026-02-20").getTime()) / 86400000)\n  return <p>{days}</p>\n}\n`,
    }) === 1,
  )
  ok(
    '.ts ファイルの再インラインも検知して exit 1（旧実装は .tsx しか走査していなかった）',
    runGuard({
      'page.tsx': VALID_TOP,
      'lib-ish.ts': `export const days = Math.floor((Date.now() - Date.parse("2026-02-20")) / 86400000)\n`,
    }) === 1,
  )
  ok(
    '走査対象が0件なら致命(exit 1)＝監視の無言化を防ぐ',
    runGuard({ 'README.md': 'tsx が1件も無い構成' }) === 1,
  )
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n[selftest-check-uptime] 結果: pass=${pass} fail=${fail}`)
if (fail > 0) {
  console.error('[selftest-check-uptime] FAIL')
  process.exit(1)
}
console.log('[selftest-check-uptime] PASS')
