// lib/uptime.ts の daysSince を検証する。
//
// 背景: 稼働日数カウンタ(トップ/NOXA)は同じ日数差ロジックを別々にインラインしており、
// トップ側だけ Math.max(0,…) の下限クランプが欠け、クライアント時計が起点日より過去に
// ずれていると「-N日」の負値を表示しうる穴があった(Day55)。両者を daysSince に集約した
// ので、その下限クランプと基本挙動をここで固定し、退行(クランプ削除・重複再発)を防ぐ。
//
// 実行: node scripts/check-uptime.mjs  （Node 22 の型ストリップで .ts を直接 import）

import { readFileSync, readdirSync } from 'node:fs'
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

// ドリフト再発ガード(自己調整・Day70):
//  (1) 生の日数差インライン(getTime() 差を 86400000 で割る=負値ハザード)が どの app
//      ページにも残っていないことを全走査で確認する。トップ/NOXA 固定でなく stamps・
//      workspaces や将来の新ページも含め、再インライン化(=クランプ欠落で負値表示)を封じる。
//  (2) 稼働日数を"実際に描画している"ページ(app/page.tsx の「稼働日数」カウンタ)だけ
//      daysSince への集約を必須とする。← 描画しないページにまで daysSince 呼び出しを
//      強制すると、レンダーされない daysSince(=デッドコード)を温存する phantom ガードに
//      なる(Day58/64 の featured-apps 同クラス)。実際 NOXA は days を計算するだけで一度も
//      描画しておらず(全履歴で {days} レンダー無し)、旧ガードがその死蔵コードを支えていた。
//      Day70 で NOXA の死蔵フックを除去し、正の使用は表示ページ(トップ)にだけ課す。
const INLINE_DATE_DIFF = /getTime\(\)[\s\S]{0,80}1000\s*\*\s*60\s*\*\s*60\s*\*\s*24/
function collectAppTsx(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) collectAppTsx(full, out)
    else if (e.name.endsWith('.tsx')) out.push([path.relative(ROOT, full), readFileSync(full, 'utf8')])
  }
  return out
}
const appPages = collectAppTsx(path.join(ROOT, 'app'))
console.log(`[check-uptime] 生の日数差インラインが全 app ページ(${appPages.length})に残っていないか(負値再発ガード)`)
for (const [rel, src] of appPages) {
  check(`${rel}: 生の日数差インラインが無い`, INLINE_DATE_DIFF.test(src), false)
}

console.log('[check-uptime] 稼働日数を描画するページが daysSince に集約されているか')
const TOP = path.join('app', 'page.tsx')
const topEntry = appPages.find(([rel]) => rel === TOP)
check(`${TOP}: daysSince を使用(稼働日数カウンタの描画元)`, !!topEntry && topEntry[1].includes('daysSince('), true)

if (failed > 0) {
  console.error(`[check-uptime] ✗ ${failed} 件失敗`)
  process.exit(1)
}
console.log('[check-uptime] ✓ 全チェック通過')
