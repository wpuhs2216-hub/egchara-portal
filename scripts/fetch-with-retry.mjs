// 死活チェック用の「一時失敗をリトライする fetch」。
//
// check-links.mjs は本番URLを生 fetch で叩く死活監視で、cron/grind ループから定期実行される。
// 従来 check() は1回叩くだけで、タイムアウト・瞬断(ECONNRESET)・一時的な 5xx/429 のような
// 「次の瞬間には回復している一過性の失敗」も hardBad=致命(exit 1) に落としていた。実際に
// portal自前75件のうち1件が単発でコケて「✗ 致命 1件」を出し、直後の再走では緑になる
// false-red が観測された(Day85)。恒久的な 404/リンク切れとは区別し、一時失敗だけを
// 数回リトライしてから判定することで、監視の信頼性(誤警報の排除)を上げる。
//
// fetchImpl / sleep を注入可能にしてあるのは、selftest-check-links.mjs が実ネットワーク無しで
// リトライ挙動を決定的に検証できるようにするため。

// そのステータスが「一時的(リトライで回復しうる)」か。
//   0     = catch されたネットワークエラー/タイムアウト(check が status:0 で表現)
//   429   = レート制限(時間を置けば通る)
//   >=500 = サーバ側一時障害(502/503/504 等)
// 404 等の 4xx(429を除く)は恒久失敗なのでリトライしない(無駄叩きを避け、リンク切れは即検知)。
export function isTransientStatus(status) {
  return status === 0 || status === 429 || status >= 500
}

// url を GET し、一時失敗なら retries 回まで指数バックオフでリトライする。
// 戻り値: { url, status, ok, err?, attempts }（attempts=実試行回数）。
export async function fetchWithRetry(url, {
  fetchImpl = fetch,
  retries = 2,
  timeoutMs = 15000,
  backoffMs = 400,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let attempt = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++
    let result
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': 'Mozilla/5.0 (egchara-linkcheck)' },
      })
      result = { url, status: res.status, ok: res.ok, attempts: attempt }
    } catch (e) {
      result = { url, status: 0, ok: false, err: e.name, attempts: attempt }
    }
    // 成功／恒久失敗／リトライ上限 のいずれかなら確定
    if (result.ok || !isTransientStatus(result.status) || attempt > retries) return result
    await sleep(backoffMs * attempt)
  }
}
