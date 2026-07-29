// fetch-with-retry.mjs のセルフテスト（実ネットワーク不要・決定的）。
// 使い方: node scripts/selftest-check-links.mjs   → 最後に PASS/FAIL を出す
//
// 狙い(Day85): check-links の死活監視が一時失敗(タイムアウト/瞬断/5xx/429)を単発で
// 「致命」誤警報にしていた false-red を、リトライで吸収する挙動として固定する。
// 恒久失敗(404 等)はリトライせず即検知＝リンク切れの検知力は落とさないことも併せて固定。
import { fetchWithRetry, isTransientStatus } from './fetch-with-retry.mjs'

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log('  ✓', m) }
const bad = (m) => { fail++; console.log('  ✗', m) }
const noSleep = () => Promise.resolve()  // テストは実際に待たない

// n 回だけ失敗し、その後 200 を返す mock fetch。
//   mode='throw' → ネットワークエラー(catch されて status:0 相当)
//   mode=<数値>  → その HTTP ステータスで応答(ok=false)
function flakyFetch(failCount, mode = 'throw') {
  let n = 0
  return async () => {
    if (n++ < failCount) {
      if (mode === 'throw') { const e = new Error('boom'); e.name = 'TypeError'; throw e }
      return { status: mode, ok: false }
    }
    return { status: 200, ok: true }
  }
}

console.log('[selftest-check-links] fetchWithRetry の一時失敗リトライ挙動')

// ① ネットワークエラー2回 → 3回目成功。retries=2 で回復し ok(attempts=3)
{
  const r = await fetchWithRetry('u', { fetchImpl: flakyFetch(2, 'throw'), retries: 2, sleep: noSleep })
  if (r.ok && r.attempts === 3) ok('ネットワークエラー2回はリトライで回復(attempts=3, ok)')
  else bad(`ネットワークエラー回復失敗: ${JSON.stringify(r)}`)
}

// ② 503 一時失敗1回 → 2回目成功(attempts=2)
{
  const r = await fetchWithRetry('u', { fetchImpl: flakyFetch(1, 503), retries: 2, sleep: noSleep })
  if (r.ok && r.attempts === 2) ok('503一時失敗はリトライで回復(attempts=2)')
  else bad(`503回復失敗: ${JSON.stringify(r)}`)
}

// ③ 恒久404 はリトライしない(attempts=1・ok=false)＝リンク切れは即検知
{
  const r = await fetchWithRetry('u', { fetchImpl: async () => ({ status: 404, ok: false }), retries: 2, sleep: noSleep })
  if (!r.ok && r.attempts === 1 && r.status === 404) ok('恒久404はリトライせず即fail(attempts=1)')
  else bad(`404挙動が想定外: ${JSON.stringify(r)}`)
}

// ④ 恒久ネットワークエラーは retries を使い切って fail(attempts=3・status0)
{
  const r = await fetchWithRetry('u', { fetchImpl: flakyFetch(99, 'throw'), retries: 2, sleep: noSleep })
  if (!r.ok && r.attempts === 3 && r.status === 0) ok('恒久エラーはretries使い切りfail(attempts=3)')
  else bad(`恒久エラー挙動が想定外: ${JSON.stringify(r)}`)
}

// ⑤ isTransientStatus の分類（0/429/5xx=一時, 404/200=恒久）
if (isTransientStatus(0) && isTransientStatus(429) && isTransientStatus(503) &&
    !isTransientStatus(404) && !isTransientStatus(200)) {
  ok('isTransient分類(0/429/5xx=一時, 404/200=恒久)')
} else {
  bad('isTransient分類が想定外')
}

console.log(`\n[selftest-check-links] 結果: pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
