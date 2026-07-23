// lib/uptime.ts の daysSince を検証する。
//
// 背景: 稼働日数カウンタ(トップ/NOXA)は同じ日数差ロジックを別々にインラインしており、
// トップ側だけ Math.max(0,…) の下限クランプが欠け、クライアント時計が起点日より過去に
// ずれていると「-N日」の負値を表示しうる穴があった(Day55)。両者を daysSince に集約した
// ので、その下限クランプと基本挙動をここで固定し、退行(クランプ削除・重複再発)を防ぐ。
//
// 実行: node scripts/check-uptime.mjs  （Node 22 の型ストリップで .ts を直接 import）

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { daysSince } from '../lib/uptime.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const D = 86400000
const ORIGIN = '2026-02-20T00:00:00+09:00'
const o = new Date(ORIGIN).getTime()

let failed = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failed++
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${actual}${ok ? '' : ` (期待 ${expected})`}`)
}

console.log('[check-uptime] daysSince の数値挙動')
check('起点ちょうど = 0', daysSince(ORIGIN, o), 0)
check('+10日 = 10', daysSince(ORIGIN, o + 10 * D), 10)
check('+0.9日は floor で 0', daysSince(ORIGIN, o + Math.floor(0.9 * D)), 0)
check('起点より過去(クロックずれ)は 0 に下限クランプ(負値を出さない)', daysSince(ORIGIN, o - 5 * D), 0)
check('大きく過去でも 0', daysSince(ORIGIN, o - 9999 * D), 0)
check('+365日 = 365', daysSince(ORIGIN, o + 365 * D), 365)

// ドリフト再発ガード: 両ページが daysSince に集約され、生の日数差インライン
// (getTime() を使った (now - origin)/86400000 直書き)が残っていないことを源から確認する。
console.log('[check-uptime] トップ/NOXA が daysSince に集約されているか(重複再発ガード)')
for (const rel of ['app/page.tsx', 'app/noxa/page.tsx']) {
  const src = readFileSync(path.join(ROOT, rel), 'utf8')
  const usesHelper = src.includes('daysSince(')
  // 稼働日数の生インライン計算(getTime() 差を 86400000 で割る)が残っていないか
  const hasInlineDateDiff = /getTime\(\)[\s\S]{0,80}1000\s*\*\s*60\s*\*\s*60\s*\*\s*24/.test(src)
  check(`${rel}: daysSince を使用`, usesHelper, true)
  check(`${rel}: 生の日数差インラインが残っていない`, hasInlineDateDiff, false)
}

if (failed > 0) {
  console.error(`[check-uptime] ✗ ${failed} 件失敗`)
  process.exit(1)
}
console.log('[check-uptime] ✓ 全チェック通過')
