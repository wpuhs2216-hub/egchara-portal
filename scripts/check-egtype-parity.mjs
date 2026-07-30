// portal の 32 キャラ一覧(app/page.tsx の ALL_CHARACTERS)が egtype 正本
// (../egtype/src/data/types.ts + new-characters.ts)からドリフトしていないか照合する。
//
// 背景: portal は egtype とは別リポで、同じ 32 キャラの表示データ(name/animal/theme/
// catchphrase/dangerRank)と画像パス(/egtype/characters/<id>.webp)を独自にハードコード
// している。egtype 側でキャラ改名・テーマ変更・危険度調整をしても portal は自動追随
// しないため、放置すると送客ポータルだけ古い名前・テーマを出し続ける(Day29〜38 で
// egtype 内でも同種の再生成漏れ/取り残しが多発した)。factory は Day31 で Kit⇄egtype の
// 照合を恒久ガード化済み。本スクリプトはその portal 版。
//
// 判定: name/animal/theme/catchphrase/dangerRank は完全一致必須。portal の全 id が
// egtype 正本に実在し、かつ egtype public に <id>.webp があること。過不足も検出。
// egtype リポは portal の兄弟(../egtype)を既定で探す。EGTYPE_DIR で上書き可。
// egtype が見つからない環境(CI 等)では WARN + exit 0(非破壊)。ドリフト検出で exit 1。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORTAL_DIR = path.resolve(__dirname, '..')
const FIELDS = ['name', 'animal', 'theme', 'catchphrase', 'dangerRank']

function findEgtypeDir() {
  const cand = process.env.EGTYPE_DIR || path.join(path.dirname(PORTAL_DIR), 'egtype')
  return fs.existsSync(path.join(cand, 'src/data/types.ts')) ? cand : null
}

// egtype の TS データ(単一引用符)を id ブロックに分割して各フィールドを抽出する。
// dangerRank を持つブロックだけを採用し、型注釈(TypeGroup の id: 'GM' 等)を弾く。
function parseEgtype(file) {
  const src = fs.readFileSync(file, 'utf8')
  const idRe = /(?:^|\n)\s*id\s*:\s*'([A-Za-z0-9_]+)'/g
  const marks = []
  let m
  while ((m = idRe.exec(src))) marks.push({ id: m[1], start: m.index })
  const out = {}
  for (let i = 0; i < marks.length; i++) {
    const block = src.slice(marks[i].start, marks[i + 1]?.start ?? src.length)
    const rec = {}
    for (const f of FIELDS) {
      const fm = block.match(new RegExp(f + "\\s*:\\s*'((?:[^'\\\\]|\\\\.)*)'"))
      if (fm) rec[f] = fm[1]
    }
    if (rec.dangerRank && ['S', 'A', 'B', 'C'].includes(rec.dangerRank)) out[marks[i].id] = rec
  }
  return out
}

function parsePortal(file) {
  const src = fs.readFileSync(file, 'utf8')
  const start = src.indexOf('const ALL_CHARACTERS')
  const block = src.slice(start, src.indexOf('\n]', start))
  const rowRe = /\{ id: "([^"]+)", name: "([^"]+)", animal: "([^"]+)", theme: "([^"]+)", catchphrase: "([^"]+)", dangerRank: "([^"]+)"/g
  const out = []
  let m
  while ((m = rowRe.exec(block))) {
    out.push({ id: m[1], name: m[2], animal: m[3], theme: m[4], catchphrase: m[5], dangerRank: m[6] })
  }
  return out
}

const egtypeDir = findEgtypeDir()
if (!egtypeDir) {
  console.warn('[parity] ⚠ egtype リポが見つからないためスキップ(EGTYPE_DIR 未設定 & ../egtype 不在)。CI 非破壊で exit 0。')
  process.exit(0)
}

const canon = {
  ...parseEgtype(path.join(egtypeDir, 'src/data/types.ts')),
  ...parseEgtype(path.join(egtypeDir, 'src/data/new-characters.ts')),
}
const portal = parsePortal(path.join(PORTAL_DIR, 'app/page.tsx'))
const charDir = path.join(egtypeDir, 'public/characters')

let issues = 0
const portalIds = new Set()
for (const p of portal) {
  portalIds.add(p.id)
  const c = canon[p.id]
  if (!c) {
    console.log(`✗ 未知ID: portal の ${p.id}(${p.name}) が egtype 正本に無い`)
    issues++
    continue
  }
  for (const f of FIELDS) {
    if (String(p[f]) !== String(c[f])) {
      console.log(`✗ ドリフト ${p.id} .${f}: portal="${p[f]}" / egtype="${c[f]}"`)
      issues++
    }
  }
  const img = path.join(charDir, `${p.id}.webp`)
  if (!fs.existsSync(img)) {
    console.log(`✗ 画像欠落: egtype public/characters/${p.id}.webp が無い(portal が参照)`)
    issues++
  }
}
for (const id of Object.keys(canon)) {
  if (!portalIds.has(id)) {
    console.log(`✗ 欠落: egtype の ${id}(${canon[id].name}) が portal ALL_CHARACTERS に無い`)
    issues++
  }
}

const total = portal.length

// --- 総数コピーの drift ガード ---
// ブランドタグライン「N体のエグかわ…」の N はキャラ総数を指す。メタ(layout.tsx)と
// OG(opengraph-image.tsx)は別モジュールで ALL_CHARACTERS を import できず数字をハード
// コードしているため、キャラ増減時にタグラインだけ stale 化しうる(page.tsx の UI は
// {ALL_CHARACTERS.length} 駆動化済み=Day49)。"1体" 等の別用途と混同しないよう
// 「N体のエグかわ」限定で総数一致を検査する。
const taglineFiles = ['app/layout.tsx', 'app/opengraph-image.tsx', 'app/page.tsx']
for (const rel of taglineFiles) {
  const src = fs.readFileSync(path.join(PORTAL_DIR, rel), 'utf8')
  const tagRe = /(\d+)\s*体のエグかわ/g
  let tm
  while ((tm = tagRe.exec(src))) {
    if (Number(tm[1]) !== total) {
      console.log(`✗ 総数コピー不一致 ${rel}: "${tm[1]}体のエグかわ…" だが実キャラ数=${total}`)
      issues++
    }
  }
}

// page.tsx は ALL_CHARACTERS を import できるため、レンダー本文の総数は必ず
// {ALL_CHARACTERS.length} で駆動すべき(Day49)。だが「N体のエグかわ」以外の言い回し
// 例「32 キャラに判定」(Day61 検出)はタグラインガードも動的化も外れてハードコードが
// 生き残りうる。コメントを除いた本文に 2桁の「N体/Nキャラ」リテラルが残っていないかを
// 検査し、静かな stale 化を封じる(メタ/OG は import 不可のため上のタグラインガード担当)。
{
  const rel = 'app/page.tsx'
  let body = fs.readFileSync(path.join(PORTAL_DIR, rel), 'utf8')
  body = body.replace(/\{\/\*[\s\S]*?\*\/\}/g, '') // JSX ブロックコメント除去
  body = body.replace(/^\s*\/\/.*$/gm, '')          // 行頭 JS コメント除去(URL の // は残す)
  const hardRe = /(\d{2})\s*(体|キャラ|種|人)/g
  let hm
  while ((hm = hardRe.exec(body))) {
    console.log(`✗ 総数ハードコード ${rel}: "${hm[1]}${hm[2]}" はレンダー本文に直書き。{ALL_CHARACTERS.length} で駆動すること`)
    issues++
  }

  // 実績カウンタの「あそべる実験」数は EXPERIMENTS.length 駆動が正(別所の「ぜんぶで N」も
  // {EXPERIMENTS.length})。stat 値だけ数値直書きだと EXPERIMENTS 増減で静かに stale 化する
  // (Day67 検出: value:"7" が直書きで残っていた)。数値直書きを禁じ動的化を強制する。
  const expStatRe = /label:\s*"あそべる実験",\s*value:\s*"(\d+)"/
  const em = expStatRe.exec(body)
  if (em) {
    console.log(`✗ 実験数ハードコード ${rel}: 「あそべる実験」value:"${em[1]}" は直書き。String(EXPERIMENTS.length) で駆動すること`)
    issues++
  }
}

// --- NOXA STATUS 実数コピーの drift ガード(Day73) ---
// NOXA トップ STATUS 帯の「SUB PRODUCTS」「PLANNED」は配列(SUB_PRODUCTS / FEATURES)の実数を
// 指す。stat 値を数値直書きにすると配列増減で静かに stale 化する(Day67「あそべる実験」・
// page.tsx 総数と同クラス)。SUB PRODUCTS は String(SUB_PRODUCTS.length)、PLANNED は FEATURES の
// item 総数 +"+" 駆動が正。数値直書き(quoted リテラル)を禁じ再ハードコードを exit1 で検知する。
{
  const rel = 'app/noxa/page.tsx'
  const src = fs.readFileSync(path.join(PORTAL_DIR, rel), 'utf8')
  const subStat = /label:\s*"SUB PRODUCTS",\s*value:\s*"(\d+)"/.exec(src)
  if (subStat) {
    console.log(`✗ NOXA STATUS ハードコード ${rel}: 「SUB PRODUCTS」value:"${subStat[1]}" は直書き。String(SUB_PRODUCTS.length) で駆動すること`)
    issues++
  }
  const planStat = /label:\s*"PLANNED",\s*value:\s*"(\d+\+?)"/.exec(src)
  if (planStat) {
    console.log(`✗ NOXA STATUS ハードコード ${rel}: 「PLANNED」value:"${planStat[1]}" は直書き。FEATURES の item 総数で駆動すること`)
    issues++
  }
}

// --- OG 画像フォント subset の網羅ガード(Day76) ---
// opengraph-image.tsx は Google Font を text=OG_TEXT で subset 取得する。OG_TEXT が実描画テキストの
// 文字を取りこぼすと、そのグリフ(「。」「×」「.」等)が OG/Twitter 共有カードで欠ける(実際に発生していた)。
// OG_TEXT を実描画定数(SUB_HEADLINE/SUB_TAGLINE/SITE_URL)の機械連結にし、JSX でも同じ定数を描画する
// ことで「描画文字 ⊆ subset」を構造的に保証する。ここではその構造(手動リテラルへの逆戻り)が
// 崩れていないかを固定する。
{
  const rel = 'app/opengraph-image.tsx'
  const src = fs.readFileSync(path.join(PORTAL_DIR, rel), 'utf8')
  // OG_TEXT が3定数の機械連結であること(手動リテラル直書きに戻すと subset 取りこぼしが再発)。
  if (!/const OG_TEXT = SUB_HEADLINE \+ SUB_TAGLINE \+ SITE_URL/.test(src)) {
    console.log(`✗ OG subset ${rel}: OG_TEXT が実描画定数の機械連結でない(手動リテラルは subset 取りこぼしを招く)`)
    issues++
  }
  // JSX が同じ定数を描画していること(インライン文字列に戻すと subset とドリフトする)。
  for (const name of ['SUB_HEADLINE', 'SUB_TAGLINE', 'SITE_URL']) {
    if (!src.includes(`{${name}}`)) {
      console.log(`✗ OG subset ${rel}: 描画に {${name}} を使っていない(subset と描画がドリフトしうる)`)
      issues++
    }
  }
}

// --- NOXA OG 画像フォント subset の網羅ガード(Day79) ---
// noxa/opengraph-image.tsx は Noto Sans JP と Geist Mono の2 font を text=subset で subset 取得する。
// 手動 subset リテラルが実描画文字を取りこぼすと、そのグリフ(「—」「構想」「Concept,」「/」等)が
// NOXA 共有カードで欠ける(実際に 23 字欠けていた・Day76 の主 OG と同クラス)。実描画テキストを
// font 別の OG_ 定数にし、OG_TEXT(Noto)/MONO_SUBSET(Mono) をそれらの機械連結にして JSX でも同定数を
// 描画することで「描画文字 ⊆ subset」を構造保証する。ここでは JSX が描画する全 OG_ 定数が
// いずれかの subset 連結に含まれること(＝新テキストを subset に足し忘れていないこと)を固定する。
{
  const rel = 'app/noxa/opengraph-image.tsx'
  const src = fs.readFileSync(path.join(PORTAL_DIR, rel), 'utf8')
  const notoExpr = (src.match(/const OG_TEXT = ([^\n]+)/) || [])[1] || ''
  const monoExpr = (src.match(/const MONO_SUBSET = ([^\n]+)/) || [])[1] || ''
  // subset は OG_ 定数の + 連結であること(手動リテラルに戻すと取りこぼしが再発)。
  if (!/\+/.test(notoExpr) || !/OG_[A-Z_]+/.test(notoExpr)) {
    console.log(`✗ NOXA OG subset ${rel}: OG_TEXT が OG_ 定数の機械連結でない`)
    issues++
  }
  if (!/\+/.test(monoExpr) || !/OG_[A-Z_]+/.test(monoExpr)) {
    console.log(`✗ NOXA OG subset ${rel}: MONO_SUBSET が OG_ 定数の機械連結でない`)
    issues++
  }
  // subset 連結に含まれる定数名の集合と、JSX が描画する定数名の集合。
  const inSubset = new Set([
    ...[...notoExpr.matchAll(/OG_[A-Z_]+/g)].map((m) => m[0]),
    ...[...monoExpr.matchAll(/OG_[A-Z_]+/g)].map((m) => m[0]),
  ])
  const rendered = [...new Set([...src.matchAll(/\{(OG_[A-Z_]+)\}/g)].map((m) => m[1]))]
  for (const name of rendered) {
    if (!inSubset.has(name)) {
      console.log(`✗ NOXA OG subset ${rel}: 描画定数 ${name} が subset 連結に無い(グリフ欠けの恐れ)`)
      issues++
    }
  }
}

// --- OG 画像 JSX に「定数を経由しない生 CJK テキスト」が無いことの共通ガード(Day79 PM) ---
// 上の2ガードは「subset 連結に足し忘れた定数」は検知するが、JSX に定数を経由せず生の日本語を
// 直接ベタ書きされた場合(例: 新チップ <div>新機能</div>)は素通りし、その文字は subset に載らず
// グリフ欠けになる。両 OG の JSX テキストノード(>...<)に生 CJK が無い(＝全て {定数} 経由)ことを
// 固定し、この最後の抜け道を塞ぐ。style/コメント/属性は {} を含むため対象外(自然に除外される)。
{
  const bareCjk = />([^<>{}]*[぀-ヿ一-鿿ー][^<>{}]*)</g
  for (const rel of ['app/opengraph-image.tsx', 'app/noxa/opengraph-image.tsx']) {
    const src = fs.readFileSync(path.join(PORTAL_DIR, rel), 'utf8')
    for (const m of src.matchAll(bareCjk)) {
      console.log(`✗ OG subset ${rel}: JSX に生 CJK テキスト「${m[1].trim()}」(定数化して subset 連結に足すこと)`)
      issues++
    }
  }
}

// --- 図鑑の危険度並び順ガード(Day88) ---
// app/page.tsx の ALL_CHARACTERS は 図鑑(CHARACTERS グリッド)を array 順そのままで描画する
// (ALL_CHARACTERS.map・client sort なし)。表示契約は「旧16体ブロック(危険度 S→A→B→C 降順)
// → 新16体(isNew)ブロック(同 S→A→B→C 降順)」の2コホート。将来キャラを誤った危険度位置に
// 挿入/追加すると 図鑑の S/A/B/C バッジがバラついて見えるが、従来はコメントで並べ替えと述べる
// だけで無検査だった。①旧ブロックが新ブロックより前に連続(old-first) ②各コホート内が危険度
// 非増加(S→A→B→C 降順) を固定する。
{
  const rel = 'app/page.tsx'
  const src = fs.readFileSync(path.join(PORTAL_DIR, rel), 'utf8')
  const start = src.indexOf('const ALL_CHARACTERS')
  const block = src.slice(start, src.indexOf('\n]', start))
  const RANK_ORDER = { S: 0, A: 1, B: 2, C: 3 }
  const rows = [...block.matchAll(/\{ id: "([^"]+)"[^\n]*?dangerRank: "([SABC])"([^\n]*?)\}/g)]
    .map((m) => ({ id: m[1], rank: m[2], isNew: m[3].includes('isNew: true') }))
  // ① 旧(isNew でない)が全て 新(isNew) より前＝コホートが連続で old-first
  const firstNew = rows.findIndex((r) => r.isNew)
  if (firstNew !== -1) {
    for (const r of rows.slice(firstNew).filter((r) => !r.isNew)) {
      console.log(`✗ 図鑑並び順 ${rel}: 旧キャラ ${r.id} が新16体ブロックより後にある(旧→新のコホート順が崩れている)`)
      issues++
    }
  }
  // ② 各コホート内が危険度 非増加(S→A→B→C 降順)
  for (const [label, list] of [['旧16', rows.filter((r) => !r.isNew)], ['新16', rows.filter((r) => r.isNew)]]) {
    for (let i = 1; i < list.length; i++) {
      if (RANK_ORDER[list[i].rank] < RANK_ORDER[list[i - 1].rank]) {
        console.log(`✗ 図鑑並び順 ${rel}: ${label}ブロックで危険度が S→A→B→C 降順でない(${list[i - 1].id}=${list[i - 1].rank} の後に ${list[i].id}=${list[i].rank})`)
        issues++
      }
    }
  }
}

if (issues === 0) {
  console.log(`[parity] ✓ portal ⇄ egtype 整合 (${total}体 name/animal/theme/catchphrase/dangerRank + 画像 全一致・図鑑並び順OK)`)
  process.exit(0)
} else {
  console.log(`\n[parity] ✗ ドリフト ${issues} 件 / portal ${total}体。egtype 正本に合わせて app/page.tsx の ALL_CHARACTERS を更新してください。`)
  process.exit(1)
}
