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
if (issues === 0) {
  console.log(`[parity] ✓ portal ⇄ egtype 整合 (${total}体 name/animal/theme/catchphrase/dangerRank + 画像 全一致)`)
  process.exit(0)
} else {
  console.log(`\n[parity] ✗ ドリフト ${issues} 件 / portal ${total}体。egtype 正本に合わせて app/page.tsx の ALL_CHARACTERS を更新してください。`)
  process.exit(1)
}
