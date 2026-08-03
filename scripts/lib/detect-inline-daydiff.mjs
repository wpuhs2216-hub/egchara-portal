// 稼働日数の「日数差を自前でインライン計算している箇所」を検知する純関数（Day94）。
//
// 背景: Day55 で、トップと NOXA が同じ日数差ロジックを別々にインラインし、片方だけ
// Math.max(0,…) の下限クランプを欠いて「-3日」を表示しうる穴があった。lib/uptime の
// daysSince へ集約し、再インライン化を check-uptime のガードで封じている。
//
// ところが旧ガードの検知規則は
//   /getTime\(\)[\s\S]{0,80}1000\s*\*\s*60\s*\*\s*60\s*\*\s*24/
// という「1日 = 1000*60*60*24 という1綴り」かつ「getTime() を経由する」書き方だけを見ており、
// 実測で以下がすべて素通りして「✓ 全チェック通過」と出た（＝ガードの false-green）:
//   - `/ 86400000` の直書き
//   - `Date.parse(...)` や `Date.now()` だけで getTime() を通らない書き方
//   - `24 * 60 * 60 * 1000` の逆順綴り
// 検知規則を抽出層として切り出し（Day91 の extract-targets と同じ方針）、綴り・時刻取得の
// 揺れを吸収したうえで selftest で固定する。

/** 1日のミリ秒の綴り違い（正規表現の断片）。 */
const DAY_MS_SPELLINGS = [
  '86_?400_?000', // 86400000 / 86_400_000
  '8\\.64e7', // 指数表記
  '1000\\s*\\*\\s*60\\s*\\*\\s*60\\s*\\*\\s*24',
  '24\\s*\\*\\s*60\\s*\\*\\s*60\\s*\\*\\s*1000',
  '60\\s*\\*\\s*60\\s*\\*\\s*24\\s*\\*\\s*1000',
  '1000\\s*\\*\\s*3600\\s*\\*\\s*24',
  '24\\s*\\*\\s*3600\\s*\\*\\s*1000',
  '3600\\s*\\*\\s*24\\s*\\*\\s*1000',
  '1000\\s*\\*\\s*86400',
  '86400\\s*\\*\\s*1000',
]

/** ミリ秒の時刻を取り出す式（これが除算の手前にあると「時刻の差を日数へ割っている」と見なす）。 */
const TIME_SOURCE = /getTime\s*\(\s*\)|Date\.now\s*\(\s*\)|Date\.parse\s*\(|valueOf\s*\(\s*\)|\+\s*new\s+Date\b/

/** 除算記号の手前どれだけ遡って時刻取得を探すか（空白正規化後の文字数）。 */
const WINDOW = 200

/**
 * ソース中の「時刻差を1日のミリ秒で割っている」箇所を返す。
 *
 * 判定は「除数が1日のミリ秒」かつ「その手前に時刻取得がある」の2条件。除算を必須にすることで
 * `revalidate: 86400` や `max-age=86400000` のような設定値の直書きは拾わない。
 * 空白を正規化してから走査するため、整形・改行の入り方に依存しない。
 *
 * @param {string} source 走査対象のソース
 * @returns {string[]} 検出箇所の抜粋（空配列なら検出なし）
 */
export function findInlineDayDiff(source) {
  const s = String(source).replace(/\s+/g, ' ')
  const hits = []
  for (const spelling of DAY_MS_SPELLINGS) {
    // 「/ 86400000」「/ (1000 * 60 * 60 * 24)」のように除数として現れる形だけを対象にする。
    const re = new RegExp(`/\\s*\\(?\\s*(?:${spelling})`, 'g')
    let m
    while ((m = re.exec(s)) !== null) {
      const from = Math.max(0, m.index - WINDOW)
      if (TIME_SOURCE.test(s.slice(from, m.index))) {
        hits.push(s.slice(from, m.index + m[0].length).trim())
      }
    }
  }
  return hits
}

/** 検知規則の綴り数（selftest が「規則が空になっていない」ことを確認するのに使う）。 */
export const DAY_MS_SPELLING_COUNT = DAY_MS_SPELLINGS.length
