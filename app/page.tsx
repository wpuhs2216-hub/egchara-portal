"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { daysSince } from "@/lib/uptime"

/**
 * エグキャラ — egshugy.com root portal
 *
 * デザイン言語: Egcharacter Clay (claymorphism)
 * - 粘土風のぷっくりカード（二重影 .clay / ぷにっとホバー .clay-hover / 押下スクイッシュ .clay-btn）
 * - 厚めボーダー(3px) + 大きめ角丸(2rem前後) + soft bounce イージング
 * - 見出し: Nunito Black(ラテン) + Noto Sans JP / 本文: DM Sans + Noto Sans JP
 * - 旧「ターミナル/モノスペース」の // コメント風ラベルは全廃（機械的な印象の排除）
 *
 * 構造:
 * Hero(+キャラ帯) → NOW → CHARACTERS図鑑 → (PRODUCTS:flag) → (PLAYGROUND:flag) → ABOUT → SHOP → FOLLOW
 *
 * NOTE: NOXA / ヨルログ / のみしゅぎ の夜職プロダクト導線は SHOW_PRODUCTS で一旦非表示。
 *       app/noxa/ ルート本体は残しているため /noxa/ への直URLアクセスは生きている。
 */

// === 夜職プロダクト(NOXA系)導線の表示フラグ。false で全非表示、true で復活 ===
const SHOW_PRODUCTS = false

// === PLAYGROUND(汎用ゲーム・ツール)の表示フラグ。エグキャラ無関係のため一旦非表示 ===
const SHOW_PLAYGROUND = false

type ProductStatus = "live" | "soon" | "preview"
type ExperimentCategory = "Diagnostic" | "Game" | "Tool"

interface Character {
  /** 2026-06 大改修で追加された新キャラ（図鑑で NEW バッジ表示） */
  isNew?: boolean
  id: string
  name: string
  animal: string
  theme: string
  catchphrase: string
  dangerRank: "S" | "A" | "B" | "C"
}

interface Experiment {
  id: string
  ja: string
  en: string
  category: ExperimentCategory
  status: "active" | "beta" | "soon"
  href?: string
}

interface Product {
  id: string
  jaName: string
  enName: string
  tagline: string
  description: string
  status: ProductStatus
  badge: string
  href: string
  external: boolean
  meta: { label: string; value: string }[]
}

// エグタイプ 32 キャラ全員。正解データ: egtype/src/data/types.ts + new-characters.ts より
// dangerRank S → A → B → C 順に並べ替え（図鑑の主役）
const ALL_CHARACTERS: Character[] = [
  { id: "GMCK", name: "ぶるとら", animal: "トラ", theme: "全賭け冒険家", catchphrase: "次は取り返すから", dangerRank: "S" },
  { id: "GRCK", name: "ごりおし", animal: "ゴリラ", theme: "圧の王様", catchphrase: "お前のためを思って言ってるんだ", dangerRank: "S" },
  { id: "GRCT", name: "ぺかりん", animal: "ペリカン", theme: "確率の奴隷", catchphrase: "今日はツイてる気がする", dangerRank: "S" },
  { id: "BRWT", name: "らむむ", animal: "ラムネ（羊）", theme: "ふわふわの迷子", catchphrase: "いつでもやめられるし", dangerRank: "S" },
  { id: "GMWT", name: "ちゅーた", animal: "ネズミ", theme: "善意の布教者", catchphrase: "これ本当にいいものなの！", dangerRank: "A" },
  { id: "BMCT", name: "もぐらし", animal: "モグラ", theme: "永遠の充電中", catchphrase: "明日から本気出す", dangerRank: "A" },
  { id: "BRCT", name: "ぐびおに", animal: "鬼", theme: "酔いの仮面", catchphrase: "もう一杯、ちょっとだけ", dangerRank: "A" },
  { id: "GMCT", name: "うわきつね", animal: "キツネ", theme: "永遠の新人", catchphrase: "次こそ本物だから", dangerRank: "B" },
  { id: "GRWK", name: "くじゃりーぬ", animal: "クジャク", theme: "ハリボテ姫", catchphrase: "これは自分への投資だから", dangerRank: "B" },
  { id: "BMCK", name: "ふくめろ", animal: "フクロウ", theme: "孤高の覚醒者", catchphrase: "真実を知ってるのは僕だけ", dangerRank: "B" },
  { id: "BMWT", name: "めんたこ", animal: "タコ", theme: "浮き沈みの天才", catchphrase: "もう無理（明日には元気）", dangerRank: "B" },
  { id: "GMWK", name: "いいかも", animal: "カモ", theme: "都合のいい聖人", catchphrase: "私がやらなきゃ誰がやるの", dangerRank: "C" },
  { id: "GRWT", name: "ぱりぴよ", animal: "ひよこ", theme: "いいね中毒", catchphrase: "いいねが来ないと息ができない", dangerRank: "C" },
  { id: "BMWK", name: "うらぴょん", animal: "ウサギ", theme: "星の操り人形", catchphrase: "水星が逆行してるから仕方ない", dangerRank: "C" },
  { id: "BRCK", name: "しゃっちー", animal: "シャチ", theme: "過労の歯車", catchphrase: "休んだら迷惑かかるから", dangerRank: "C" },
  { id: "BRWK", name: "すりよりす", animal: "リス", theme: "空気の奴隷", catchphrase: "みんながそう言ってるし", dangerRank: "C" },
  // --- v2 追加の新16キャラ（2026-06 大改修。正解データ: egtype/src/data/new-characters.ts） ---
  { id: "usoron", name: "でまろう", animal: "オオカミ", theme: "ゼロから作る作話", catchphrase: "いやそれ、本当はこうだったんだって", dangerRank: "A", isNew: true },
  { id: "mayakashi", name: "とぼけろん", animal: "カメレオン", theme: "論点スライドの達人", catchphrase: "あー、それはそれとして、さ", dangerRank: "A", isNew: true },
  { id: "seigin", name: "せいぎん", animal: "ペンギン", theme: "氷上の正しさ王様", catchphrase: "それ、間違ってると思うけど", dangerRank: "A", isNew: true },
  { id: "sokubaku", name: "おもうま", animal: "ウマ", theme: "手綱を離せない愛", catchphrase: "好きだから、ちゃんと知っておきたいだけ", dangerRank: "A", isNew: true },
  { id: "koizaru", name: "さかりざる", animal: "サル", theme: "刺激を渡り歩く", catchphrase: "ちょっと刺激が足りないだけ", dangerRank: "A", isNew: true },
  { id: "unubon", name: "なるしし", animal: "ライオン", theme: "鏡に恋する王", catchphrase: "うん、今日のわたし、わるくない。", dangerRank: "B", isNew: true },
  { id: "oregatari", name: "かたりんこ", animal: "インコ", theme: "会話の横取り名人", catchphrase: "あー、それで言うと俺の場合さ——", dangerRank: "B", isNew: true },
  { id: "jishoun", name: "わけあるま", animal: "アルマジロ", theme: "事後の言い訳職人", catchphrase: "やったのは僕だよ、ただちょっと訳があってさ", dangerRank: "B", isNew: true },
  { id: "raberu", name: "だからす", animal: "カラス", theme: "事前の予防線", catchphrase: "言っとくけど俺、そういうの無理な人だから", dangerRank: "B", isNew: true },
  { id: "gossip", name: "こそづる", animal: "ツル", theme: "陰でこそこそ", catchphrase: "ここだけの話なんだけどさ", dangerRank: "B", isNew: true },
  { id: "kawaiso", name: "かわいそ", animal: "カワウソ", theme: "悲劇の主役", catchphrase: "でも自分なんて、もっと大変でさ", dangerRank: "B", isNew: true },
  { id: "netami", name: "うらやぎ", animal: "ヤギ", theme: "隣の芝は青い", catchphrase: "いいなあ、自分なんて何もないのに", dangerRank: "B", isNew: true },
  { id: "shinpai", name: "ふあんこう", animal: "アンコウ", theme: "最悪の未来を上映", catchphrase: "もし、こうなったらどうしよう…", dangerRank: "B", isNew: true },
  { id: "dokechi", name: "けちぞう", animal: "ゾウ", theme: "一円も出さない蔵", catchphrase: "いや、それもったいないでしょ", dangerRank: "B", isNew: true },
  { id: "mashidori", name: "まだましか", animal: "アシカ", theme: "比べて安心", catchphrase: "まあ、それに比べたら自分はまだマシな方かな。", dangerRank: "C", isNew: true },
  { id: "heibon", name: "とくなし", animal: "カバ", theme: "特徴ゼロの巨体", catchphrase: "まあ、自分は特にないかな", dangerRank: "C", isNew: true },
]

// PRODUCTS: 夜職事業の関連プロダクト（SHOW_PRODUCTS=false の間は非表示）
const PRODUCTS: Product[] = [
  {
    id: "yorulog",
    jaName: "ヨルログ",
    enName: "YORULOG",
    tagline: "ナイトワーク向け CRM",
    description: "ホスト/キャバ/スナック/バーの事業者・現場スタッフ・キャスト個人、それぞれに向けたプランを提供する顧客管理 CRM。iOS + Web。Waitlist 受付中。",
    status: "soon",
    badge: "COMING SOON",
    href: "https://yorulog.vercel.app/waitlist",
    external: true,
    meta: [
      { label: "TARGET", value: "事業者・個人 両対応" },
      { label: "STATUS", value: "Waitlist 受付中" },
    ],
  },
  {
    id: "nomishugy",
    jaName: "のみしゅぎ",
    enName: "NOMISHUGY",
    tagline: "バー業態特化の店舗ポータル",
    description: "大阪ミナミのバー業態に特化。店舗探し・利用者マッチング・バー求人・店舗運営支援を統合する構想で、現在は店舗側ポータルが先行稼働中。事前登録受付中。",
    status: "soon",
    badge: "COMING SOON",
    href: "https://nomishugy.vercel.app/coming-soon",
    external: true,
    meta: [
      { label: "AREA", value: "大阪ミナミ" },
      { label: "FOCUS", value: "バー業態特化" },
    ],
  },
]

function statusColor(status: ProductStatus): string {
  switch (status) {
    case "live": return "text-primary"
    case "soon": return "text-pop-orange"
    case "preview": return "text-muted-foreground"
  }
}

function statusDot(status: ProductStatus): string {
  switch (status) {
    case "live": return "bg-primary"
    case "soon": return "bg-pop-orange"
    case "preview": return "bg-muted-foreground"
  }
}

// 危険度ランク → ポップ色クラス
function rankColor(rank: Character["dangerRank"]): string {
  switch (rank) {
    case "S": return "text-rank-s"
    case "A": return "text-rank-a"
    case "B": return "text-rank-b"
    case "C": return "text-rank-c"
  }
}

// PLAYGROUND: ゲーム・ツール群。
// ぺかりんちんちろは CHARACTERS のスピンオフ作品として格上げしたためここから除外。
const EXPERIMENTS: Experiment[] = [
  { id: "wordwolf", ja: "ワードウルフ", en: "WORD WOLF", category: "Game", status: "active", href: "/word-wolf/" },
  { id: "kingscup", ja: "キングスカップ", en: "KINGS CUP", category: "Game", status: "active", href: "/kingscup/" },
  { id: "compat", ja: "相性診断", en: "COMPATIBILITY", category: "Diagnostic", status: "active", href: "/compatibility/" },
  { id: "nickname", ja: "あだ名メーカー", en: "NICKNAME GEN", category: "Tool", status: "active", href: "/nickname-gen/" },
  { id: "puzzle", ja: "6 ボールパズル", en: "6-BALL PUZZLE", category: "Game", status: "beta", href: "/ramune-puzzle/" },
  { id: "egramen", ja: "えぐラーメン食堂", en: "EGRAMEN", category: "Game", status: "beta", href: "/egramen/" },
  { id: "yamanote", ja: "山手線ゲーム", en: "YAMANOTE", category: "Game", status: "soon" },
]

// 稼働日数カウンタ（リリース起点を 2026-02-20 = egtype 初版日とする）
// 日数差の算出は lib/uptime の daysSince に集約（負値クランプを noxa と共有）。
function useUptimeDays(): number {
  const [days, setDays] = useState(0)
  useEffect(() => {
    setDays(daysSince("2026-02-20T00:00:00+09:00"))
  }, [])
  return days
}

// セクション見出しの上に付く、柔らかい丸ピルのラベル（旧 // モノラベルの置き換え）
function SectionPill({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-card border-[2px] border-border font-display font-extrabold text-[12px] tracking-wide clay"
      style={{ color }}
    >
      <span className="w-2 h-2 rounded-full shimmer" style={{ background: color }} />
      {children}
    </span>
  )
}

export default function Home() {
  const [navOpen, setNavOpen] = useState(false)
  const uptimeDays = useUptimeDays()

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* ナビゲーション */}
      <nav className="sticky top-0 z-40 backdrop-blur bg-background/80 border-b-[2px] border-border">
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-4 flex justify-between items-center">
          <Link href="/" className="flex items-center" aria-label="エグキャラ ホーム">
            <img src="/egchara-logo.png" alt="エグキャラ" className="h-9 md:h-10 w-auto" />
          </Link>
          <ul className="hidden md:flex gap-7 text-[14px] font-display font-bold">
            <li><a href="#characters" className="hover:text-primary text-muted-foreground transition-colors">キャラクター</a></li>
            {SHOW_PRODUCTS && (
              <li><a href="#products" className="hover:text-primary text-muted-foreground transition-colors">プロダクト</a></li>
            )}
            {SHOW_PLAYGROUND && (
              <li><a href="#playground" className="hover:text-primary text-muted-foreground transition-colors">あそぶ</a></li>
            )}
            <li><a href="#shop" className="hover:text-primary text-muted-foreground transition-colors">ショップ</a></li>
            <li><a href="#about" className="hover:text-primary text-muted-foreground transition-colors">エグキャラとは</a></li>
          </ul>
          <button
            className="md:hidden bg-card border-[2px] border-border px-4 py-2 text-[13px] font-display font-bold rounded-full clay-btn"
            onClick={() => setNavOpen(!navOpen)}
            aria-label="メニュー"
          >
            {navOpen ? "とじる" : "メニュー"}
          </button>
        </div>
        {navOpen && (
          <div className="md:hidden border-t-[2px] border-border px-4 py-4 flex flex-col gap-4 text-[15px] font-display font-bold bg-background">
            <a href="#characters" onClick={() => setNavOpen(false)} className="text-muted-foreground hover:text-primary">キャラクター</a>
            {SHOW_PRODUCTS && (
              <a href="#products" onClick={() => setNavOpen(false)} className="text-muted-foreground hover:text-primary">プロダクト</a>
            )}
            {SHOW_PLAYGROUND && (
              <a href="#playground" onClick={() => setNavOpen(false)} className="text-muted-foreground hover:text-primary">あそぶ</a>
            )}
            <a href="#shop" onClick={() => setNavOpen(false)} className="text-muted-foreground hover:text-primary">ショップ</a>
            <a href="#about" onClick={() => setNavOpen(false)} className="text-muted-foreground hover:text-primary">エグキャラとは</a>
          </div>
        )}
      </nav>

      {/* Hero: 32体のエグかわ妖精たち */}
      <section className="relative max-w-6xl mx-auto px-4 md:px-6 pt-16 md:pt-28 pb-12 md:pb-16 overflow-hidden">
        {/* 装飾: 粘土風のふわふわブロブ */}
        <div
          className="absolute top-6 right-0 w-[460px] h-[460px] rounded-full opacity-50 blur-3xl pointer-events-none float-bob"
          style={{ background: "radial-gradient(circle, #ff5ca8, transparent 70%)" }}
        />
        <div
          className="absolute bottom-0 left-6 w-[340px] h-[340px] rounded-full opacity-40 blur-3xl pointer-events-none float-bob"
          style={{ background: "radial-gradient(circle, #22d3ee, transparent 70%)", animationDelay: "1.5s" }}
        />

        <div className="relative">
          {/* トップの大きいロゴ */}
          <img
            src="/egchara-logo.png"
            alt="エグキャラ"
            className="w-full max-w-md md:max-w-2xl mb-8 md:mb-10 float-bob"
          />

          <div className="inline-flex items-center gap-2 mb-7 px-4 py-2 rounded-full bg-card border-[2px] border-border text-[13px] font-display font-extrabold text-pop-pink clay">
            <span className="w-2.5 h-2.5 rounded-full bg-pop-pink shimmer" />
            エグくて、かわいい。
          </div>

          <h1 className="font-display font-black text-[clamp(46px,10vw,120px)] leading-[0.95] tracking-[-0.03em] mb-6">
            あなたは、どの
            <br />
            <span className="text-primary">エグキャラ</span>
            <span className="text-pop-pink">？</span>
          </h1>

          <p className="max-w-xl text-[clamp(15px,1.6vw,18px)] leading-[1.9] text-muted-foreground mb-10">
            <strong className="text-foreground font-bold">自虐 × 妖精語 × 匂わせポエム。</strong>
            <br />
            ちょっとダメで、やたら愛おしい妖精たち。
            <br />
            まずは診断で、自分の1体を見つけよう。
          </p>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/egtype/"
              className="inline-flex items-center gap-2 px-8 py-4 bg-primary text-white font-display font-extrabold text-[16px] rounded-full clay-btn"
            >
              診断してみる →
            </Link>
            <a
              href="#characters"
              className="inline-flex items-center gap-2 px-8 py-4 bg-card border-[3px] border-border text-foreground font-display font-extrabold text-[16px] rounded-full clay-btn"
            >
              {ALL_CHARACTERS.length}体を見る
            </a>
          </div>
        </div>

        {/* Hero 直下: 32体の顔を横スクロールマーキーで即見せ（キャラ主役の証明） */}
        <div className="relative mt-12 md:mt-16 -mx-4 md:-mx-6 overflow-hidden marquee-mask">
          <div className="flex gap-4 md:gap-5 marquee-track w-max py-2 px-4">
            {[...ALL_CHARACTERS, ...ALL_CHARACTERS].map((c, i) => (
              <div
                key={`${c.id}-${i}`}
                className="w-20 h-20 md:w-24 md:h-24 rounded-[1.4rem] overflow-hidden bg-card border-[3px] border-border flex-shrink-0 clay"
                title={c.name}
              >
                <img
                  src={`/egtype/characters/${c.id}.webp`}
                  alt={c.name}
                  loading="lazy"
                  className="w-full h-full object-cover"
                />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* NOW: ぷっくり粘土の実績カウンタ */}
      <section className="max-w-6xl mx-auto px-4 md:px-6">
        {(() => {
          const stats = [
            { label: "キャラクター", value: String(ALL_CHARACTERS.length), delta: "全員エグかわ", color: "var(--primary)" },
            ...(SHOW_PLAYGROUND ? [{ label: "あそべる実験", value: "7", delta: "PLAYGROUND", color: "var(--pop-cyan)" }] : []),
            { label: "スピンオフ", value: "1", delta: "ぺかりんちんちろ", color: "var(--pop-pink)" },
            { label: "稼働日数", value: `${uptimeDays}日`, delta: "2026-02-20 から", color: "var(--pop-orange)" },
          ]
          const mdCols = stats.length === 4 ? "md:grid-cols-4" : "md:grid-cols-3"
          return (
            <div className={`grid grid-cols-2 ${mdCols} gap-3 md:gap-5`}>
              {stats.map((cell, i) => (
                <div
                  key={i}
                  className="bg-card border-[3px] border-border rounded-[1.6rem] py-6 px-5 clay clay-hover"
                >
                  <div className="text-[12px] text-muted-foreground font-display font-bold mb-2">
                    {cell.label}
                  </div>
                  <div className="font-display font-black text-[clamp(30px,4vw,44px)] tracking-tight leading-none" style={{ color: cell.color }}>
                    {cell.value}
                  </div>
                  <div className="mt-2 text-[11px] text-muted-foreground font-medium">
                    {cell.delta}
                  </div>
                </div>
              ))}
            </div>
          )
        })()}
      </section>

      {/* CHARACTERS: 32体の図鑑（サイトの主役・全員を一覧表示） */}
      <section id="characters" className="max-w-6xl mx-auto px-4 md:px-6 py-16 md:py-24">
        <div className="flex items-end justify-between gap-6 mb-9 flex-col sm:flex-row">
          <div>
            <div className="mb-4">
              <SectionPill color="var(--pop-pink)">キャラクター</SectionPill>
            </div>
            <h2 className="font-display font-black text-[clamp(30px,5.5vw,54px)] tracking-[-0.02em] leading-tight">
              エグキャラ<span className="text-primary">図鑑</span>。全{ALL_CHARACTERS.length}体。
            </h2>
            <p className="mt-3 max-w-xl text-[15px] text-muted-foreground leading-relaxed">
              診断「エグタイプ」から生まれた妖精たち。危険度ランク S → C 順。あなたはどの子？
            </p>
          </div>
          <div className="text-[14px] text-muted-foreground font-display font-bold bg-card border-[2px] border-border rounded-full px-4 py-2 clay">
            <strong className="text-primary font-black">{ALL_CHARACTERS.length}</strong> / {ALL_CHARACTERS.length} そろってる
          </div>
        </div>

        {/* 図鑑グリッド: 32体を全員カード表示。これがサイトの中心 */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-5 mb-9">
          {ALL_CHARACTERS.map((c) => (
            <Link
              key={c.id}
              href={`/egtype/types/${c.id}/`}
              className="group relative bg-card border-[3px] border-border rounded-[1.8rem] p-4 clay clay-hover"
            >
              {/* 危険度ランクのぷっくりバッジ */}
              <span
                className={`absolute top-3 right-3 z-10 w-8 h-8 rounded-full bg-card border-[2.5px] border-current flex items-center justify-center font-display font-black text-[14px] clay ${rankColor(c.dangerRank)}`}
                title={`危険度 ${c.dangerRank}`}
              >
                {c.dangerRank}
              </span>
              {/* 新キャラは NEW バッジ（isNew フィールドで明示） */}
              {c.isNew && (
                <span className="absolute top-3 left-3 z-10 rounded-full bg-primary text-primary-foreground font-display font-black text-[11px] px-2.5 py-1 clay tracking-wider">
                  NEW
                </span>
              )}
              <div className="aspect-square rounded-[1.4rem] overflow-hidden bg-secondary border-[2.5px] border-border mb-3 group-hover:border-primary/40 transition-colors">
                <img
                  src={`/egtype/characters/${c.id}.webp`}
                  alt={c.name}
                  loading="lazy"
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                />
              </div>
              <div className="font-display font-black text-[16px] md:text-[18px] tracking-tight leading-tight">{c.name}</div>
              <div className="text-[12px] text-primary font-bold mb-1.5">{c.theme}</div>
              <p className="text-[12px] text-muted-foreground leading-snug line-clamp-2">
                「{c.catchphrase}」
              </p>
            </Link>
          ))}
        </div>

        {/* 診断 CTA バナー（図鑑の下に従える） */}
        <Link
          href="/egtype/"
          className="block bg-primary text-white rounded-[2rem] p-7 md:p-9 mb-6 clay-btn"
        >
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <span className="inline-block mb-3 px-3 py-1 rounded-full bg-white/20 text-white font-display font-extrabold text-[12px]">
                メイン診断・公開中
              </span>
              <h3 className="font-display font-black text-[clamp(22px,3.4vw,34px)] tracking-tight mb-2 leading-tight">
                エグタイプ診断で自分の1体を見つける
              </h3>
              <p className="text-[15px] text-white/85 leading-relaxed max-w-xl">
                悪癖×行動スタイルの状況診断で 32 キャラに判定。自虐 × 妖精語 × 匂わせポエムの 3 層構造。
              </p>
            </div>
            <span className="flex-shrink-0 inline-flex items-center gap-2 px-7 py-3.5 bg-white text-primary font-display font-black text-[16px] rounded-full">
              診断する →
            </span>
          </div>
        </Link>

        {/* スピンオフ: ぺかりんのちんちろ（GRCT モチーフのキャラ単独ゲーム） */}
        <a
          href="/pekarin-chinchiro/"
          className="block bg-card border-[3px] border-border rounded-[2rem] p-6 md:p-7 clay clay-hover group"
        >
          <div className="mb-4">
            <span className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-pop-pink/15 text-pop-pink font-display font-extrabold text-[12px]">
              <span className="w-2 h-2 rounded-full bg-pop-pink shimmer" />
              スピンオフ・公開中
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-[120px_1fr] gap-5 md:gap-7 items-center">
            <div className="w-28 h-28 rounded-[1.6rem] overflow-hidden bg-secondary border-[3px] border-border clay float-bob">
              <img
                src="/egtype/characters/GRCT.webp"
                alt="ぺかりん"
                loading="lazy"
                className="w-full h-full object-cover"
              />
            </div>
            <div>
              <h3 className="font-display font-black text-[clamp(22px,3vw,30px)] tracking-tight mb-1">
                ぺかりんのちんちろ
              </h3>
              <div className="text-[13px] text-muted-foreground font-display font-bold mb-3">サイコロ遊び・PWA</div>
              <p className="text-[15px] text-muted-foreground leading-relaxed mb-5">
                エグキャラの<strong className="text-foreground font-bold">ぺかりん</strong>
                がホストのチンチロリン。エグキャラ単独ゲーム化、第 1 弾。
              </p>
              <span className="inline-flex items-center gap-2 text-[15px] font-display font-black text-pop-pink group-hover:translate-x-1 transition-transform">
                プレイする →
              </span>
            </div>
          </div>
        </a>
      </section>

      {/* PRODUCTS: 夜職プロダクト(NOXA系) — SHOW_PRODUCTS=false の間は非表示 */}
      {SHOW_PRODUCTS && (
        <section id="products" className="max-w-6xl mx-auto px-4 md:px-6 py-16 md:py-24 border-t-[2px] border-border">
          <div className="flex items-end justify-between gap-6 mb-9 flex-col sm:flex-row">
            <div>
              <div className="mb-4">
                <SectionPill color="var(--primary)">プロダクト</SectionPill>
              </div>
              <h2 className="font-display font-black text-[clamp(30px,5.5vw,54px)] tracking-[-0.02em] leading-tight">
                夜職事業の<span className="text-primary">親ブランド</span>と、<br />
                並行プロダクト。
              </h2>
              <p className="mt-3 max-w-xl text-[15px] text-muted-foreground leading-relaxed">
                キャラクター作品とは別軸で、ひとりで動かしている夜職領域。
              </p>
            </div>
            <div className="text-[14px] text-muted-foreground font-display font-bold bg-card border-[2px] border-border rounded-full px-4 py-2 clay">
              <strong className="text-primary font-black">{PRODUCTS.length + 1}</strong> プロジェクト
            </div>
          </div>

          {/* メインカード: Noxa（親ブランド構想） */}
          <Link
            href="/noxa/"
            className="block bg-card border-[3px] border-border rounded-[2rem] p-6 md:p-8 mb-8 clay clay-hover group"
          >
            <div className="mb-4">
              <span className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-primary/15 text-primary font-display font-extrabold text-[12px]">
                <span className="w-2 h-2 rounded-full bg-primary" />
                構想中・未ローンチ
              </span>
            </div>

            <div className="flex items-center gap-4 md:gap-6 mb-5">
              <img
                src="/noxa-logo-192.png"
                alt=""
                aria-hidden
                className="w-16 h-16 md:w-20 md:h-20 rounded-[1.4rem] flex-shrink-0 clay"
              />
              <div>
                <h3 className="font-display font-black text-[clamp(28px,4.2vw,44px)] tracking-tight leading-none mb-1">
                  Noxa
                </h3>
                <div className="text-[13px] text-muted-foreground font-display font-bold">夜職 DX プラットフォーム・構想</div>
              </div>
            </div>

            <p className="text-muted-foreground text-[15px] leading-relaxed mb-6 max-w-2xl">
              夜職 DX プラットフォームの<strong className="text-foreground font-bold">構想</strong>。
              同じ Firebase プロジェクトと OAuth 同意画面で複数アプリを束ねる
              <strong className="text-foreground font-bold">共有ブランド名</strong>として運用中。
              独立サービスはまだ未着手。
            </p>

            <div className="grid grid-cols-3 gap-3 mb-6">
              {[
                { name: "Noxa Core", en: "本体（構想中）", color: "var(--pop-purple)", dashed: true },
                { name: "ヨルログ", en: "YORULOG", color: "var(--pop-cyan)", dashed: false },
                { name: "のみしゅぎ", en: "NOMISHUGY", color: "var(--pop-orange)", dashed: false },
              ].map((p) => (
                <div
                  key={p.name}
                  className={`rounded-[1.2rem] p-4 bg-secondary/50 border-[2.5px] ${p.dashed ? "border-dashed border-border" : "border-border"}`}
                >
                  <div className="text-[11px] font-display font-bold mb-1" style={{ color: p.color }}>
                    {p.en}
                  </div>
                  <div className="text-[13px] md:text-[15px] font-bold truncate">{p.name}</div>
                </div>
              ))}
            </div>

            <span className="inline-flex items-center gap-2 text-[15px] font-display font-black text-primary group-hover:translate-x-1 transition-transform">
              構想を見る →
            </span>
          </Link>

          {/* サブカード grid: 関連プロダクト 2 つ */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {PRODUCTS.map((p) => {
              const cardClass =
                "block bg-card border-[3px] border-border rounded-[2rem] p-6 md:p-7 clay clay-hover group relative overflow-hidden"
              const inner = (
                <>
                  <div className="mb-3">
                    <span className={`inline-flex items-center gap-2 font-display font-extrabold text-[12px] ${statusColor(p.status)}`}>
                      <span
                        className={`w-2 h-2 rounded-full ${statusDot(p.status)} ${p.status === "live" ? "shimmer" : ""}`}
                      />
                      {p.badge}
                    </span>
                  </div>
                  <h3 className="font-display font-black text-[clamp(20px,2.6vw,26px)] tracking-tight mb-1">
                    {p.jaName}
                  </h3>
                  <div className="text-[12px] text-muted-foreground font-display font-bold mb-3">{p.enName}</div>
                  <p className="text-[15px] text-foreground leading-relaxed mb-4">
                    <strong className="font-bold">{p.tagline}</strong>
                  </p>
                  <p className="text-[14px] text-muted-foreground leading-relaxed mb-6">
                    {p.description}
                  </p>
                  <div className="flex gap-3 flex-wrap">
                    {p.meta.map((m) => (
                      <div key={m.label} className="bg-secondary/50 border-[2px] border-border rounded-[1rem] px-3.5 py-2">
                        <div className="text-[10px] text-muted-foreground font-display font-bold uppercase tracking-wide">{m.label}</div>
                        <div className="text-[13px] font-bold mt-0.5">{m.value}</div>
                      </div>
                    ))}
                  </div>
                </>
              )
              return p.external ? (
                <a key={p.id} href={p.href} target="_blank" rel="noopener noreferrer" className={cardClass}>
                  {inner}
                </a>
              ) : (
                <Link key={p.id} href={p.href} className={cardClass}>
                  {inner}
                </Link>
              )
            })}
          </div>
        </section>
      )}

      {/* PLAYGROUND: 汎用ゲーム・ツール — SHOW_PLAYGROUND=false の間は非表示（エグキャラ無関係のため） */}
      {SHOW_PLAYGROUND && (
      <section id="playground" className="max-w-6xl mx-auto px-4 md:px-6 py-16 md:py-24 border-t-[2px] border-border">
        <div className="flex items-end justify-between gap-6 mb-9 flex-col sm:flex-row">
          <div>
            <div className="mb-4">
              <SectionPill color="var(--pop-cyan)">あそぶ</SectionPill>
            </div>
            <h2 className="font-display font-black text-[clamp(30px,5.5vw,54px)] tracking-[-0.02em] leading-tight">
              みんなで<span className="text-pop-cyan">あそぶ</span>。
            </h2>
            <p className="mt-3 max-w-xl text-[15px] text-muted-foreground leading-relaxed">
              ゲーム・診断・ツール。エグキャラと一緒に遊べる実験たち。
            </p>
          </div>
          <div className="text-[14px] text-muted-foreground font-display font-bold bg-card border-[2px] border-border rounded-full px-4 py-2 clay">
            ぜんぶで <strong className="text-pop-cyan font-black">{EXPERIMENTS.length}</strong>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {EXPERIMENTS.map((exp) => {
            const statusLabel = exp.status === "active" ? "あそべる" : exp.status === "beta" ? "ベータ" : "じゅんび中"
            const statusCls = exp.status === "active" ? "text-pop-green" : exp.status === "beta" ? "text-pop-cyan" : "text-muted-foreground"
            const content = (
              <>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[11px] text-muted-foreground font-display font-bold uppercase tracking-wide">{exp.category}</span>
                  <span className={`inline-flex items-center gap-1.5 text-[12px] font-display font-extrabold ${statusCls}`}>
                    <span className={`w-2 h-2 rounded-full bg-current ${exp.status === "active" ? "shimmer" : ""}`} />
                    {statusLabel}
                  </span>
                </div>
                <div className="font-display font-black text-[18px] tracking-tight mb-1">{exp.ja}</div>
                <div className="text-[12px] text-muted-foreground font-display font-bold">{exp.en}</div>
              </>
            )
            const cardCls = "bg-card border-[3px] border-border rounded-[1.6rem] p-5 clay"
            return exp.href ? (
              <a key={exp.id} href={exp.href} className={`${cardCls} clay-hover text-foreground`}>
                {content}
              </a>
            ) : (
              <div key={exp.id} className={`${cardCls} text-foreground opacity-55 cursor-not-allowed`}>
                {content}
              </div>
            )
          })}
        </div>
      </section>
      )}

      {/* ABOUT: エグキャラとは */}
      <section id="about" className="max-w-6xl mx-auto px-4 md:px-6 py-16 md:py-24 border-t-[2px] border-border">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_1.4fr] gap-10 md:gap-16 items-start">
          <div>
            <div className="mb-4">
              <SectionPill color="var(--primary)">エグキャラとは</SectionPill>
            </div>
            <h2 className="font-display font-black text-[clamp(30px,5.5vw,54px)] tracking-[-0.02em] leading-tight">
              エグキャラ、<br />
              <span className="text-primary">ってなに？</span>
            </h2>
          </div>
          <div className="space-y-5 text-[16px] leading-[1.9] text-muted-foreground">
            <p>
              <strong className="text-foreground font-bold">エグキャラ</strong> は、
              性格診断「エグタイプ」から生まれた {ALL_CHARACTERS.length} 体のキャラクターたちです。
            </p>
            <p>
              <span className="text-primary font-bold">自虐 × 妖精語 × 匂わせポエム</span>の 3 層構造で、
              ちょっとダメだけど、なぜか放っておけない。そんな&quot;エグかわ&quot;妖精ばかり。
            </p>
            <p>
              診断で自分のエグキャラを見つけて、ゲームで遊んで、スタンプで使う。
              キャラクターを主役に、ひとつずつ世界を広げています。
            </p>

            {/* 旧 // モノラベルのグリッド → 柔らかい粘土チップに再設計 */}
            <div className="grid grid-cols-2 gap-3 md:gap-4 pt-4">
              {[
                { label: "キャラクター", value: `${ALL_CHARACTERS.length}体（全員公開中）`, color: "var(--primary)" },
                { label: "あそびかた", value: "診断・ゲーム・スタンプ", color: "var(--pop-pink)" },
                { label: "つくってる人", value: "ひとり + AI", color: "var(--pop-cyan)" },
                { label: "うまれた国", value: "日本", color: "var(--pop-orange)" },
              ].map((chip) => (
                <div key={chip.label} className="bg-card border-[3px] border-border rounded-[1.4rem] p-4 clay">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: chip.color }} />
                    <span className="text-[12px] font-display font-bold text-muted-foreground">{chip.label}</span>
                  </div>
                  <div className="text-[15px] font-display font-black text-foreground leading-tight">{chip.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* SHOP: LINE スタンプ（既存） */}
      <section id="shop" className="max-w-6xl mx-auto px-4 md:px-6 py-16 md:py-24 border-t-[2px] border-border">
        <div className="mb-9">
          <div className="mb-4">
            <SectionPill color="var(--pop-orange)">ショップ</SectionPill>
          </div>
          <h2 className="font-display font-black text-[clamp(30px,5.5vw,54px)] tracking-[-0.02em] leading-tight">
            スタンプ<span className="text-pop-orange">ショップ</span>。
          </h2>
        </div>
        <Link
          href="/stamps/"
          className="block bg-card border-[3px] border-border rounded-[2rem] p-7 md:p-9 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-5 items-center clay clay-hover group"
        >
          <div>
            <span className="inline-block text-[12px] text-pop-orange font-display font-extrabold mb-2">LINE スタンプ</span>
            <h3 className="font-display font-black text-[24px] mb-1.5 tracking-tight">エグキャラ LINE スタンプ</h3>
            <p className="text-[15px] text-muted-foreground leading-snug">エグキャラたちの LINE スタンプを販売中。日常使いできるエグかわ表情がいっぱい。</p>
          </div>
          <span className="justify-self-start md:justify-self-auto inline-flex items-center gap-2 px-7 py-3.5 bg-pop-orange text-white text-[16px] font-display font-black rounded-full clay-btn">
            購入する →
          </span>
        </Link>
      </section>

      {/* FOLLOW: SNS 集約、最重要 CTA */}
      <section id="follow" className="max-w-6xl mx-auto px-4 md:px-6 py-16 md:py-24 border-t-[2px] border-border">
        <div className="mb-9">
          <div className="mb-4">
            <SectionPill color="var(--pop-pink)">フォロー</SectionPill>
          </div>
          <h2 className="font-display font-black text-[clamp(30px,5.5vw,54px)] tracking-[-0.02em] leading-tight">
            エグキャラを<span className="text-pop-pink">フォロー</span>。
          </h2>
          <p className="mt-3 max-w-xl text-[15px] text-muted-foreground leading-relaxed">
            新キャラ・制作の裏側・あそびの記録。SNS でフォローしてね。
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { label: "X", handle: "エグキャラ公式", url: "https://x.com/egtype_shindan", color: "var(--pop-pink)", soon: false },
            { label: "Instagram", handle: "準備中", url: "", color: "var(--pop-cyan)", soon: true },
            { label: "TikTok", handle: "準備中", url: "", color: "var(--pop-orange)", soon: true },
          ].map((sns) =>
            sns.soon ? (
              <div
                key={sns.label}
                className="bg-card border-[3px] border-dashed border-border rounded-[1.6rem] p-5 opacity-60 cursor-default"
                aria-disabled="true"
              >
                <div className="text-[12px] font-display font-bold text-muted-foreground mb-2">
                  {sns.label}
                </div>
                <div className="font-display font-black text-[17px]" style={{ color: sns.color }}>
                  {sns.handle}
                </div>
                <div className="mt-3 text-[12px] font-display font-bold text-muted-foreground">
                  COMING SOON
                </div>
              </div>
            ) : (
              <a
                key={sns.label}
                href={sns.url}
                target="_blank"
                rel="noopener noreferrer"
                className="bg-card border-[3px] border-border rounded-[1.6rem] p-5 clay clay-hover group"
              >
                <div className="text-[12px] font-display font-bold text-muted-foreground mb-2">
                  {sns.label}
                </div>
                <div className="font-display font-black text-[17px]" style={{ color: sns.color }}>
                  {sns.handle}
                </div>
                <div className="mt-3 text-[12px] font-display font-bold text-muted-foreground group-hover:text-foreground transition-colors">
                  フォロー →
                </div>
              </a>
            )
          )}
        </div>
      </section>

      {/* Footer */}
      <footer className="max-w-6xl mx-auto px-4 md:px-6 pt-12 pb-8 border-t-[2px] border-border mt-12">
        <div className={`grid grid-cols-1 gap-8 md:gap-10 pb-10 border-b-[2px] border-border ${SHOW_PRODUCTS ? "md:grid-cols-[1.5fr_1fr_1fr_1fr]" : "md:grid-cols-[1.5fr_1fr_1fr]"}`}>
          <div>
            <img src="/egchara-logo.png" alt="エグキャラ" className="h-10 mb-4 inline-block" />
            <p className="text-[13px] text-muted-foreground leading-relaxed max-w-xs">
              自虐 × 妖精語 × 匂わせポエムで生まれた、
              <br />
              {ALL_CHARACTERS.length} 体のエグかわキャラクター。
            </p>
          </div>
          <div>
            <h5 className="text-[13px] text-foreground font-display font-black mb-3.5">キャラクター</h5>
            <Link href="/egtype/" className="block text-[14px] mb-2 text-muted-foreground hover:text-primary transition-colors">エグタイプ診断</Link>
            <a href="/pekarin-chinchiro/" className="block text-[14px] mb-2 text-muted-foreground hover:text-pop-pink transition-colors">ぺかりんのちんちろ</a>
            <Link href="/stamps/" className="block text-[14px] mb-2 text-muted-foreground hover:text-pop-orange transition-colors">LINE スタンプ</Link>
          </div>
          {SHOW_PRODUCTS && (
            <div>
              <h5 className="text-[13px] text-foreground font-display font-black mb-3.5">プロダクト</h5>
              <Link href="/noxa/" className="block text-[14px] mb-2 text-muted-foreground hover:text-primary transition-colors">Noxa</Link>
              <a href="https://yorulog.vercel.app/waitlist" target="_blank" rel="noopener noreferrer" className="block text-[14px] mb-2 text-muted-foreground hover:text-accent transition-colors">ヨルログ</a>
              <a href="https://nomishugy.vercel.app/coming-soon" target="_blank" rel="noopener noreferrer" className="block text-[14px] mb-2 text-muted-foreground hover:text-pop-orange transition-colors">のみしゅぎ</a>
            </div>
          )}
          <div>
            <h5 className="text-[13px] text-foreground font-display font-black mb-3.5">フォロー</h5>
            <a href="https://x.com/egtype_shindan" target="_blank" rel="noopener noreferrer" className="block text-[14px] mb-2 text-muted-foreground hover:text-primary transition-colors">X / Twitter</a>
            <span className="block text-[14px] mb-2 text-muted-foreground/60">Instagram（準備中）</span>
            <span className="block text-[14px] mb-2 text-muted-foreground/60">TikTok（準備中）</span>
          </div>
        </div>
        <div className="pt-5 flex flex-wrap justify-between items-center gap-3 text-[12px] text-muted-foreground font-display font-bold">
          <span>© 2026 エグキャラ · EGSHUGY</span>
        </div>
      </footer>
    </div>
  )
}
