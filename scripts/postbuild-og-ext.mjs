// OG 画像を「拡張子つき」でも配信できるようにするビルド後処理(Day104)。
//
// 問題: `output: "export"` × Next のファイルベース OG(app/**/opengraph-image.tsx) は
// `out/opengraph-image` のように **拡張子の無いファイル**を吐く。静的配信側は拡張子から
// MIME を推定するため型が決まらず、実測で本番は
//   HEAD https://egshugy.com/opengraph-image → 200 / content-length 358903 / **content-type 無し**
//   HEAD https://egshugy.com/icon.png        → 200 / content-type: image/png
// という状態だった(/twitter-image・/noxa/opengraph-image も同じ)。中身は正しい PNG なので
// 「壊れている」ようには見えないが、型を見て弾くクローラでは共有カードの画像が出ない。
// HTML 側の og:image:type は image/png と申告しており、HTTP ヘッダとの食い違いにもなっている。
//
// 方針: サーバ設定(.htaccess 等)には触らない。デプロイ先の既存設定を上書きする危険があり、
// 本番反映は人間ゲートで検証もできないため。代わりに **配信物の側を拡張子つきにする**:
//   ① out の拡張子なし OG を `<path>.png` として複製する
//   ② out の HTML/RSC ペイロード内の参照を `<path>.png` へ書き換える
//   ③ 拡張子なしの元ファイルは**残す**(既に配られた共有リンク・クローラのキャッシュが
//      指し続けるため。消すと従来 200 だったものが 404 になる＝退化)
//
// floor: この後処理は「静かに何もしなくなる」形で壊れうる(Next のファイル名規約変更・
// 出力先変更・regex のすり抜け)。その時ビルドは緑のまま本番だけが元の欠陥に戻るので、
// 期待と実態がずれたら **ビルドを落とす**。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ogImageRoutesFromFiles } from './lib/extract-targets.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT = process.env.POSTBUILD_OUT_DIR ? path.resolve(process.env.POSTBUILD_OUT_DIR) : path.join(ROOT, 'out')
const APP = process.env.POSTBUILD_APP_DIR ? path.resolve(process.env.POSTBUILD_APP_DIR) : path.join(ROOT, 'app')

const fail = (msg) => { console.error(`[postbuild-og] ✗ ${msg}`); process.exit(1) }

function walk(dir, prefix = '') {
  let out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out = out.concat(walk(path.join(dir, e.name), rel))
    else out.push(rel)
  }
  return out
}

if (!fs.existsSync(OUT)) fail(`出力ディレクトリが無い: ${OUT}(ビルドが失敗している)`)

// 期待は **ソース(app/)の OG 規約** から導く。out の走査結果だけを正とすると、
// 「Next が OG を吐かなくなった」時に対象0件で静かに成功してしまう。
const expected = ogImageRoutesFromFiles(walk(APP))
if (expected.length === 0) fail('app/ に OG 画像ルート(opengraph-image / twitter-image)が1件も無い(規約変更でこの後処理が空回りしている)')

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const rewrites = []
for (const pngRoute of expected) {
  const bare = pngRoute.replace(/\.png$/, '')            // 例: /noxa/opengraph-image
  const src = path.join(OUT, bare)
  if (!fs.existsSync(src)) fail(`ビルド物に ${bare} が無い(Next の出力規約が変わった可能性)`)
  const buf = fs.readFileSync(src)
  if (!buf.subarray(0, 4).equals(PNG_MAGIC)) fail(`${bare} が PNG ではない(.png として複製すると型を偽ることになる)`)
  fs.writeFileSync(path.join(OUT, pngRoute), buf)
  rewrites.push({ bare, pngRoute })
}

// 参照の書き換え。`/opengraph-image?<hash>` と `/opengraph-image"` の双方を拾い、
// 既に `.png` が付いているものは(直後が `.` なので)対象にならない＝再実行しても安全。
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const targetFiles = walk(OUT).filter((f) => /\.(html|txt)$/.test(f))
let rewritten = 0
for (const rel of targetFiles) {
  const full = path.join(OUT, rel)
  const before = fs.readFileSync(full, 'utf8')
  let after = before
  for (const { bare, pngRoute } of rewrites) {
    after = after.replace(new RegExp(`${escape(bare)}(?=[?"'\\\\\\s])`, 'g'), pngRoute)
  }
  if (after !== before) { fs.writeFileSync(full, after); rewritten++ }
}

// floor ①: 複製が実在すること。
for (const { pngRoute } of rewrites) {
  if (!fs.existsSync(path.join(OUT, pngRoute))) fail(`複製に失敗: ${pngRoute}`)
}
// floor ②: HTML に拡張子なし参照が残っていないこと。残っていれば書き換えがすり抜けており、
// 本番の共有カードは従来どおり型なしの URL を指し続ける＝この後処理が無意味になる。
const leftovers = []
for (const rel of targetFiles.filter((f) => f.endsWith('.html'))) {
  const src = fs.readFileSync(path.join(OUT, rel), 'utf8')
  for (const { bare } of rewrites) {
    if (new RegExp(`${escape(bare)}(?=[?"'\\s])`).test(src)) leftovers.push(`${rel} → ${bare}`)
  }
}
if (leftovers.length > 0) fail(`拡張子なしの OG 参照が残っている(書き換えのすり抜け): ${leftovers.join(' / ')}`)
// floor ③: 1ファイルも書き換わっていない＝参照の記法が変わって空振りしている。
if (rewritten === 0) fail('OG 参照を1件も書き換えられなかった(HTML の記法変更でこの後処理が空振りしている)')

console.log(`[postbuild-og] ✓ 拡張子つき OG ${rewrites.length}件を出力し、参照を ${rewritten} ファイルで書き換え（拡張子なしの元ファイルは互換のため保持）`)
