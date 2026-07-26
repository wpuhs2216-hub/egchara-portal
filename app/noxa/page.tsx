"use client"

import { useState } from "react"
import Link from "next/link"

/**
 * Noxa — 夜職 DX プラットフォームの構想（CONCEPT, NOT LAUNCHED YET）
 *
 * 現状: 独立サービスは未着手、OAuth 同意画面 + Firebase プロジェクト表示名として
 *       複数アプリのアカウント共有ブランド名として運用中。
 *
 * このページは「いまある構想」と「実装したい機能群」を可視化するための置き場。
 */

interface Feature {
  category: string
  categoryColor: string
  items: { name: string; desc: string }[]
}

const FEATURES: Feature[] = [
  {
    category: "AI",
    categoryColor: "#6D4FE8",
    items: [
      { name: "AI 席回し", desc: "限られたキャストをどの卓にどう配置するか、客層・指名・回転を考慮して AI が提案。" },
      { name: "来店予測", desc: "顧客の来店周期と離反兆候を学習、声がけタイミングを通知。" },
      { name: "AI レコメンド", desc: "客層に合わせたメニュー / ボトル / イベント / キャスト指名の提案。" },
    ],
  },
  {
    category: "DATA",
    categoryColor: "#A89BFF",
    items: [
      { name: "求人データ管理", desc: "応募・面接・体入・入店までのファネルを管理。" },
      { name: "発注データ管理", desc: "ボトル・備品・消耗品の在庫と発注履歴を見える化。" },
      { name: "業界ベンチマーク", desc: "本指名率・同伴率・離脱率を業界平均と比較。データ統合の出力として可視化。" },
      { name: "店舗間 NG 客共有", desc: "トラブル顧客情報を信頼関係のある店舗間で共有。法的配慮を前提に慎重設計。" },
    ],
  },
  {
    category: "ACCOUNTING",
    categoryColor: "#22d3ee",
    items: [
      { name: "給与計算", desc: "時給・指名バック・同伴バック・歩合を自動計算。" },
      { name: "税金関連", desc: "源泉・住民税・消費税の集計、年間取りまとめ。" },
      { name: "売上レポート", desc: "日次・週次・月次の売上を自動集計、グラフ化。" },
      { name: "歩合精算", desc: "キャスト別・店舗別の歩合を自動計算、明細出力。" },
      { name: "POS / 卓会計", desc: "卓ごとのオーダー入力・伝票・会計・レジ機能を統合。" },
    ],
  },
  {
    category: "OPERATIONS",
    categoryColor: "#FF9E3B",
    items: [
      { name: "物品発注ハブ", desc: "オリシャン・名刺・販促物・記念品など、業界向け制作・発注を Noxa 一本で完結。" },
      { name: "送迎管理", desc: "キャバ・ナイトワーク全般の送迎ルート・運転手・出退勤を一元管理。" },
      { name: "外部業者提携", desc: "撮影・PR・税理士・社労士・各種代行業者との連携先を一元管理、見積もり依頼まで。" },
      { name: "シフト・出勤管理", desc: "出退勤打刻、シフト希望、当日変更、欠勤連絡を一元化。" },
      { name: "CTI 連動", desc: "着信時に顧客台帳をポップアップ。電話と顧客情報をシームレスに連動。" },
    ],
  },
]

interface SubProduct {
  name: string
  enName: string
  desc: string
  accent: string
  href: string
  liveFeatures: string[]
  plannedFeatures: string[]
}

const SUB_PRODUCTS: SubProduct[] = [
  {
    name: "YoruLog",
    enName: "YORULOG",
    desc: "ホスト・キャバ・スナック・バーまで、ナイトワーク全般を対象とする顧客管理 CRM。事業者・現場スタッフ・キャスト個人、それぞれにプランを提供。iOS + Web。Noxa の AI / DATA 機能の先行実装が稼働中。",
    accent: "#A89BFF",
    href: "https://yorulog.vercel.app/waitlist",
    liveFeatures: [
      "顧客プロフィール / 好み記憶",
      "売上・指名・同伴の記録",
      "AI 営業文面生成",
      "目標売上の逆算ダッシュボード",
      "LINE 一斉送信",
    ],
    plannedFeatures: [],
  },
  {
    name: "nomishugy",
    enName: "NOMISHUGY",
    desc: "大阪ミナミのバー業態に特化した店舗ポータル。店舗探し・利用者マッチング・バー求人・店舗運営支援を統合する構想で、現在は店舗側ポータルが先行稼働。Noxa の OPERATIONS 領域の先行実装でもあり、ホスト・キャバの色が強くなりがちな夜職 DX の中で、バーの現場のための機能を補完する役割を担う。",
    accent: "#FF9E3B",
    href: "https://nomishugy.vercel.app/coming-soon",
    liveFeatures: [
      "バー店舗ポータル",
      "店舗 × 来店者の二軸",
      "店舗運営者向けの掲載・編集",
    ],
    plannedFeatures: [
      "バー求人 / スポット求人",
      "利用者 × 店舗のマッチング",
      "バーテンダー / スタッフのプロフィール",
      "イベント・コラボ情報",
      "予約・席状況の可視化",
    ],
  },
]

const PILLARS = [
  {
    no: "01",
    title: "店舗データと現場記録の双方向同期",
    body: "店舗側の数字と現場側の記録が別々に管理されている構造そのものが歪み。Noxa は同一データ基盤で双方を扱い、指名率・同伴率・リピート率を横串で可視化したい。",
    accent: "#6D4FE8",
  },
  {
    no: "02",
    title: "ホスト・キャバ・バーを横断する汎用性",
    body: "夜職 DX は「ホスト/キャバ向け」に寄りがちで、バーは置き去りにされがち。Noxa はホスト・キャバ・スナック・バーを横断して使える設計を最初から目指す。バーには nomishugy が先行実装として連携する。",
    accent: "#A89BFF",
  },
  {
    no: "03",
    title: "現場ユーザー発信による Bottom-up",
    body: "現場で働く人（事業者・現場スタッフ・キャスト個人）が日常的に使うツールから自然に広がる導入経路を設計したい。",
    accent: "#22d3ee",
  },
]

export default function NoxaPage() {
  const [navOpen, setNavOpen] = useState(false)

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* ナビ */}
      <nav className="sticky top-0 z-40 backdrop-blur bg-background/90 border-b border-border">
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors">
              ← EGSHUGY LAB
            </Link>
            <span className="text-muted-foreground/40 text-[11px] font-mono">/</span>
            <div className="flex items-center gap-2">
              <img src="/noxa-logo-192.png" alt="" aria-hidden className="w-6 h-6 rounded-md" />
              <span className="font-mono text-[15px] tracking-tight font-semibold">NOXA</span>
            </div>
          </div>
          <ul className="hidden md:flex gap-6 text-[12px] font-mono uppercase tracking-wide">
            <li><a href="#sub-products" className="hover:text-[#6D4FE8] text-muted-foreground transition-colors">// sub-products</a></li>
            <li><a href="#features" className="hover:text-[#6D4FE8] text-muted-foreground transition-colors">// features</a></li>
            <li><a href="#vision" className="hover:text-[#6D4FE8] text-muted-foreground transition-colors">// vision</a></li>
            <li><a href="#commitment" className="hover:text-[#6D4FE8] text-muted-foreground transition-colors">// commitment</a></li>
            <li><a href="#about" className="hover:text-[#6D4FE8] text-muted-foreground transition-colors">// about</a></li>
          </ul>
          <button
            className="md:hidden border border-border px-3 py-2 text-[12px] font-mono rounded-md hover:bg-[#6D4FE8] hover:text-white hover:border-[#6D4FE8] transition"
            onClick={() => setNavOpen(!navOpen)}
            aria-label="メニュー"
          >
            {navOpen ? "CLOSE" : "MENU"}
          </button>
        </div>
        {navOpen && (
          <div className="md:hidden border-t border-border px-4 py-4 flex flex-col gap-4 text-[13px] font-mono uppercase tracking-wide bg-background">
            <a href="#sub-products" onClick={() => setNavOpen(false)} className="text-muted-foreground hover:text-[#6D4FE8]">// sub-products</a>
            <a href="#features" onClick={() => setNavOpen(false)} className="text-muted-foreground hover:text-[#6D4FE8]">// features</a>
            <a href="#vision" onClick={() => setNavOpen(false)} className="text-muted-foreground hover:text-[#6D4FE8]">// vision</a>
            <a href="#commitment" onClick={() => setNavOpen(false)} className="text-muted-foreground hover:text-[#6D4FE8]">// commitment</a>
            <a href="#about" onClick={() => setNavOpen(false)} className="text-muted-foreground hover:text-[#6D4FE8]">// about</a>
          </div>
        )}
      </nav>

      {/* Hero */}
      <section className="relative max-w-6xl mx-auto px-4 md:px-6 pt-16 md:pt-28 pb-16 md:pb-24 overflow-hidden">
        <div
          className="absolute top-10 right-0 w-[560px] h-[560px] rounded-full opacity-25 blur-3xl pointer-events-none"
          style={{ background: "radial-gradient(circle, #6D4FE8, transparent 70%)" }}
        />
        <div
          className="absolute bottom-0 left-10 w-[360px] h-[360px] rounded-full opacity-15 blur-3xl pointer-events-none"
          style={{ background: "radial-gradient(circle, #A89BFF, transparent 70%)" }}
        />

        <div className="relative">
          <div className="flex gap-3 items-center mb-8 text-[11px] font-mono flex-wrap">
            <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[#A89BFF]/40 text-[#A89BFF]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#A89BFF]" />
              CONCEPT · NOT LAUNCHED YET
            </span>
            <span className="text-muted-foreground">// 2026</span>
          </div>

          {/* Hero: ロゴ画像 + ブランド名 */}
          <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-6 md:gap-10 items-center mb-10 md:mb-14">
            <img
              src="/noxa-logo-512.png"
              alt="NOXA ロゴ"
              className="w-32 h-32 md:w-44 md:h-44 rounded-3xl"
            />
            <div>
              <div className="font-mono text-[12px] uppercase tracking-[0.2em] text-[#6D4FE8] mb-3">
                夜職 DX プラットフォーム — 構想
              </div>
              <div className="font-sans font-black text-[clamp(56px,11vw,128px)] tracking-[-0.04em] leading-[0.9] text-foreground">
                NOXA
              </div>
            </div>
          </div>

          <h1 className="font-sans font-black text-[clamp(28px,5.5vw,52px)] leading-[1.15] tracking-[-0.03em] mb-8 max-w-3xl">
            夜の現場が、もっと<br />
            <span className="text-[#6D4FE8]">楽になる場所</span>を。
          </h1>

          <div className="max-w-2xl space-y-5 text-[clamp(15px,1.6vw,17px)] leading-[1.85] text-muted-foreground mb-10">
            <p>
              <strong className="text-foreground font-medium">Noxa は、まだ完成していません。</strong>
              これは構想です。
            </p>
            <p>
              現状は、複数アプリを束ねる<strong className="text-foreground font-medium">
              アカウント共有ブランド名</strong>として運用中。
              独立サービスとしてはまだ動いていません。
            </p>
            <p>
              このページは、Noxa が実装したい
              <strong className="text-foreground font-medium">機能群と方向性</strong>
              を可視化するための場です。
              使い手の希望をできる限り反映し、
              <strong className="text-foreground font-medium">「夜の現場が楽になる」を最大化したい</strong>
              というのが基本姿勢です。
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <a
              href="#features"
              className="inline-flex items-center gap-3 px-6 py-3.5 bg-[#6D4FE8] text-white font-mono text-[13px] uppercase tracking-wider font-semibold rounded-lg hover:bg-[#8068ef] hover:shadow-[0_0_24px_rgba(109,79,232,0.4)] transition-all"
            >
              実装したい機能 →
            </a>
            <a
              href="#commitment"
              className="inline-flex items-center gap-3 px-6 py-3.5 border border-border text-foreground font-mono text-[13px] uppercase tracking-wider font-semibold rounded-lg hover:border-[#A89BFF] hover:text-[#A89BFF] transition-all"
            >
              開発方針 →
            </a>
          </div>
        </div>
      </section>

      {/* STATUS / NOW */}
      <section className="max-w-6xl mx-auto px-4 md:px-6">
        <div className="border-y border-dashed border-border py-6 md:py-7 grid grid-cols-2 md:grid-cols-4 gap-y-5 md:gap-y-0 font-mono">
          {[
            { label: "STATUS", value: "CONCEPT", delta: "構想段階" },
            // SUB PRODUCTS / PLANNED は配列(SUB_PRODUCTS / FEATURES)の実数を指す。
            // 数値直書きだと配列増減で stat だけ stale 化するため実配列から駆動する(Day73)。
            { label: "SUB PRODUCTS", value: String(SUB_PRODUCTS.length), delta: "先行実装中" },
            { label: "PLANNED", value: `${FEATURES.reduce((n, c) => n + c.items.length, 0)}+`, delta: "本体の実装予定機能" },
            { label: "TARGET", value: "ALL", delta: "ホスト・キャバ・バー" },
          ].map((cell, i) => (
            <div
              key={i}
              className={`px-5 md:px-8 ${i < 3 ? "md:border-r md:border-dashed md:border-border" : ""}`}
            >
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
                {cell.label}
              </div>
              <div className="font-mono font-semibold text-[clamp(22px,3vw,32px)] tracking-tight leading-none text-foreground">
                {cell.value}
              </div>
              <div className="mt-1.5 text-[10px] text-[#A89BFF]">
                ▲ {cell.delta}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* SUB PRODUCTS — 先行実装プロダクト（上に配置） */}
      <section id="sub-products" className="max-w-6xl mx-auto px-4 md:px-6 py-16 md:py-24">
        <div className="mb-10">
          <div className="mb-3 text-[11px] text-muted-foreground uppercase tracking-wider font-mono flex items-center gap-2">
            <span className="w-6 h-px bg-[#A89BFF]" />
            SUB PRODUCTS
          </div>
          <h2 className="font-sans font-black text-[clamp(28px,5.5vw,52px)] tracking-[-0.03em] leading-tight">
            先行実装<span className="text-[#A89BFF]">プロダクト</span>。
          </h2>
          <p className="mt-3 max-w-2xl text-[14px] text-muted-foreground leading-relaxed">
            Noxa 本体はまだ未着手ですが、ホスト・キャバ・スナック・バーを横断する設計の一部は、すでに以下のプロダクトで先行実装されて動いています。
            それぞれ独立したサービスとして運営されています。
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {SUB_PRODUCTS.map((p) => (
            <a
              key={p.name}
              href={p.href}
              target="_blank"
              rel="noopener noreferrer"
              className="block bg-card border border-border rounded-xl p-6 md:p-7 transition-all group"
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = p.accent)}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = "")}
            >
              <div className="flex items-center justify-between mb-3 text-[10px] font-mono uppercase tracking-wider">
                <span className="text-muted-foreground">// SUB PRODUCT</span>
                <span style={{ color: p.accent }}>外部サイト ↗</span>
              </div>
              <h3
                className="font-sans font-bold text-[clamp(22px,3vw,30px)] tracking-tight mb-1"
                style={{ color: p.accent }}
              >
                {p.name}
              </h3>
              <div className="text-[11px] font-mono text-muted-foreground mb-4">{p.enName}</div>
              <p className="text-[13px] md:text-[14px] text-muted-foreground leading-relaxed mb-5">
                {p.desc}
              </p>
              <div className="pt-4 border-t border-dashed border-border space-y-4">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
                    // 実装済機能
                  </div>
                  <ul className="space-y-1.5">
                    {p.liveFeatures.map((f) => (
                      <li key={f} className="text-[12px] md:text-[13px] flex items-start gap-2">
                        <span style={{ color: p.accent }} className="flex-shrink-0">✓</span>
                        <span className="text-foreground">{f}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                {p.plannedFeatures.length > 0 && (
                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
                      // 実装予定
                    </div>
                    <ul className="space-y-1.5">
                      {p.plannedFeatures.map((f) => (
                        <li key={f} className="text-[12px] md:text-[13px] flex items-start gap-2">
                          <span className="text-muted-foreground flex-shrink-0">○</span>
                          <span className="text-muted-foreground">{f}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </a>
          ))}
        </div>
      </section>

      {/* FEATURES — Noxa 本体の実装予定機能群（SUB PRODUCTS の下に配置） */}
      <section id="features" className="max-w-6xl mx-auto px-4 md:px-6 py-16 md:py-24 border-t border-border">
        <div className="mb-12">
          <div className="mb-3 text-[11px] text-muted-foreground uppercase tracking-wider font-mono flex items-center gap-2">
            <span className="w-6 h-px bg-[#6D4FE8]" />
            FEATURES
          </div>
          <h2 className="font-sans font-black text-[clamp(28px,5.5vw,52px)] tracking-[-0.03em] leading-tight">
            Noxa 本体の<br />
            <span className="text-[#6D4FE8]">実装予定機能群</span>。
          </h2>
          <p className="mt-3 max-w-2xl text-[14px] text-muted-foreground leading-relaxed">
            サブプロダクト（YoruLog / nomishugy）で先行実装済の機能はここでは省略しています。
            Noxa 本体として、ホスト・キャバ・スナック・バーを横断して新しく組み込みたい AI / データ管理 / 経理 / 運営支援の機能群。
            <strong className="text-foreground font-medium">これは固定リストではありません</strong>。要望があれば積極的に増やします。
          </p>
        </div>

        <div className="space-y-10">
          {FEATURES.map((cat) => (
            <div key={cat.category}>
              <div className="flex items-center gap-3 mb-5">
                <span
                  className="font-mono text-[12px] uppercase tracking-[0.18em] font-bold"
                  style={{ color: cat.categoryColor }}
                >
                  // {cat.category}
                </span>
                <span className="h-px flex-1" style={{ backgroundColor: `${cat.categoryColor}40` }} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {cat.items.map((item) => (
                  <div
                    key={item.name}
                    className="bg-card border border-border rounded-xl p-5 md:p-6 hover:border-foreground/30 transition-colors"
                  >
                    <h3
                      className="font-sans font-bold text-[16px] md:text-[17px] tracking-tight mb-2"
                      style={{ color: cat.categoryColor }}
                    >
                      {item.name}
                    </h3>
                    <p className="text-[13px] md:text-[14px] text-muted-foreground leading-relaxed">
                      {item.desc}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-10 border border-dashed border-border rounded-xl p-6 md:p-7 bg-card/40">
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-3">
            // 機能要望について
          </div>
          <p className="text-[13px] md:text-[14px] text-muted-foreground leading-relaxed">
            ここに書かれていない機能でも、現場で「これがあれば」と思うものがあれば
            <strong className="text-foreground font-medium"> 気軽に教えてください</strong>。
            実装可能なものは順次取り込みます。
          </p>
        </div>
      </section>

      {/* VISION */}
      <section id="vision" className="max-w-6xl mx-auto px-4 md:px-6 py-16 md:py-24 border-t border-border">
        <div className="mb-12">
          <div className="mb-3 text-[11px] text-muted-foreground uppercase tracking-wider font-mono flex items-center gap-2">
            <span className="w-6 h-px bg-[#A89BFF]" />
            VISION
          </div>
          <h2 className="font-sans font-black text-[clamp(28px,5.5vw,52px)] tracking-[-0.03em] leading-tight">
            これから組みたい<br />
            <span className="text-[#A89BFF]">3 つの構造</span>。
          </h2>
          <p className="mt-3 max-w-2xl text-[14px] text-muted-foreground leading-relaxed">
            機能リストの土台にある考え方。Noxa が向かう方向性。
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {PILLARS.map((pillar) => (
            <div
              key={pillar.no}
              className="bg-card border border-border rounded-xl p-6 md:p-7 hover:border-foreground/30 transition-colors"
            >
              <div className="flex items-baseline gap-4 mb-4">
                <span
                  className="font-mono text-[24px] font-bold tracking-tight"
                  style={{ color: pillar.accent }}
                >
                  {pillar.no}
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
              <h3 className="font-sans font-bold text-[18px] md:text-[20px] tracking-tight mb-3 leading-snug">
                {pillar.title}
              </h3>
              <p className="text-[13px] md:text-[14px] text-muted-foreground leading-relaxed">
                {pillar.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* COMMITMENT */}
      <section id="commitment" className="max-w-6xl mx-auto px-4 md:px-6 py-16 md:py-24 border-t border-border">
        <div className="mb-10">
          <div className="mb-3 text-[11px] text-muted-foreground uppercase tracking-wider font-mono flex items-center gap-2">
            <span className="w-6 h-px bg-[#6D4FE8]" />
            COMMITMENT
          </div>
          <h2 className="font-sans font-black text-[clamp(28px,5.5vw,52px)] tracking-[-0.03em] leading-tight">
            希望機能を、<br />
            <span className="text-[#6D4FE8]">できるだけ実装</span>します。
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div className="bg-card border border-border rounded-xl p-6 md:p-7 md:col-span-2">
            <div className="text-[10px] font-mono uppercase tracking-wider text-[#6D4FE8] mb-3">
              // OUR STANCE
            </div>
            <p className="text-[14px] md:text-[15px] leading-[1.85] text-foreground mb-4">
              「<strong className="font-medium">これがあれば現場が楽になる</strong>」と言ってもらえた機能は、
              採算度外視でも実装に向けて動きます。
            </p>
            <p className="text-[13px] md:text-[14px] leading-[1.8] text-muted-foreground mb-4">
              一般的な業務管理ツールは「機能が多すぎて使いにくい」「欲しいものは入っていない」のどちらかに陥りがち。
              Noxa はその逆を行きたい。<strong className="text-foreground font-medium">使う人が本当に欲しい機能</strong>から積み上げ、
              使われない機能は削る。AI も同じで、技術ありきではなく現場のペインから設計します。
            </p>
            <p className="text-[13px] md:text-[14px] leading-[1.8] text-muted-foreground">
              要望は形式問わず歓迎します。仕様まで詰まっていなくても、
              <strong className="text-foreground font-medium">「こうだったらいいのに」レベルの感想</strong>から拾います。
            </p>
          </div>

          <div className="space-y-4">
            <div className="bg-card border border-border rounded-xl p-5">
              <div className="text-[10px] font-mono uppercase tracking-wider text-[#A89BFF] mb-2">
                // 01
              </div>
              <h3 className="font-sans font-bold text-[15px] mb-2">現場の声を最優先</h3>
              <p className="text-[12px] text-muted-foreground leading-relaxed">
                使う人の「こうだったら」を実装ロードマップの起点にする。
              </p>
            </div>
            <div className="bg-card border border-border rounded-xl p-5">
              <div className="text-[10px] font-mono uppercase tracking-wider text-[#22d3ee] mb-2">
                // 02
              </div>
              <h3 className="font-sans font-bold text-[15px] mb-2">AI を道具として使う</h3>
              <p className="text-[12px] text-muted-foreground leading-relaxed">
                AI を売り物にしない。現場の負担を減らす手段として組み込む。
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ABOUT */}
      <section id="about" className="max-w-6xl mx-auto px-4 md:px-6 py-16 md:py-24 border-t border-border">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_1.4fr] gap-10 md:gap-16 items-start">
          <div>
            <div className="mb-3 text-[11px] text-muted-foreground uppercase tracking-wider font-mono flex items-center gap-2">
              <span className="w-6 h-px bg-[#6D4FE8]" />
              ABOUT
            </div>
            <h2 className="font-sans font-black text-[clamp(28px,5.5vw,52px)] tracking-[-0.03em] leading-tight">
              Noxa は、<br />
              いまのところ<br />
              <span className="text-[#6D4FE8]">共有ブランド名</span>です。
            </h2>
          </div>
          <div className="space-y-5 text-[15px] leading-[1.9] text-muted-foreground">
            <p>
              <strong className="text-foreground font-medium">Noxa（ノクサ）</strong> は、
              夜職 DX プラットフォームの構想であり、
              <Link href="/" className="text-[#6D4FE8] hover:underline">EGSHUGY LAB</Link>
              傘下のプロジェクトとして設計が進められています。
            </p>
            <p>
              現状、Noxa は<strong className="text-foreground font-medium">独立したサービスではありません</strong>。
              OAuth 同意画面・Firebase プロジェクト表示名・運営アカウントの共有ブランド名として、
              関連プロダクトを束ねる名前として機能しているだけです。
            </p>
            <p>
              開発は <strong className="text-foreground font-medium">Claude / Codex</strong> と組んで進めています。
              判断と着眼、コンプラ検証は人間。手数は AI。<br />
              機能の取捨選択はオープンに、現場の声を優先する方針で運営します。
            </p>
            <div className="pt-4 mt-6 border-t border-dashed border-border grid grid-cols-2 gap-4 font-mono text-[12px]">
              <div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">// PARENT</div>
                <div className="mt-1 text-foreground">EGSHUGY LAB</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">// SERVICE</div>
                <div className="mt-1 text-foreground">未着手 / 構想中</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">// STACK</div>
                <div className="mt-1 text-foreground">Next.js · Firebase · PWA</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">// AI PARTNERS</div>
                <div className="mt-1 text-foreground">Claude · Codex</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CONTACT */}
      <section id="contact" className="max-w-6xl mx-auto px-4 md:px-6 py-16 md:py-24 border-t border-border">
        <div className="mb-9">
          <div className="mb-3 text-[11px] text-muted-foreground uppercase tracking-wider font-mono flex items-center gap-2">
            <span className="w-6 h-px bg-[#A89BFF]" />
            CONTACT
          </div>
          <h2 className="font-sans font-black text-[clamp(28px,5.5vw,52px)] tracking-[-0.03em] leading-tight">
            機能要望・<span className="text-[#A89BFF]">ご意見</span>。
          </h2>
          <p className="mt-3 max-w-2xl text-[14px] text-muted-foreground leading-relaxed">
            「こんな機能が欲しい」「こうなってたら使う」などの声を歓迎します。
            SNS の DM でお気軽にどうぞ。
          </p>
        </div>
        <div>
          <a
            href="https://x.com/egshugy"
            target="_blank"
            rel="noopener noreferrer"
            className="block bg-card border border-border rounded-xl p-6 md:p-8 hover:border-[#6D4FE8] hover:shadow-[0_0_24px_rgba(109,79,232,0.12)] transition-all group max-w-xl"
          >
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
              // X / TWITTER
            </div>
            <div className="font-mono font-medium text-[20px] text-[#6D4FE8] mb-1">
              @egshugy
            </div>
            <div className="text-[12px] text-muted-foreground">
              DM 開放中。要望・感想・違和感、なんでも。
            </div>
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer className="max-w-6xl mx-auto px-4 md:px-6 pt-12 pb-8 border-t border-border mt-12">
        <div className="grid grid-cols-1 md:grid-cols-[1.6fr_1fr_1fr_1fr] gap-8 md:gap-10 pb-10 border-b border-border">
          <div>
            <div className="flex items-center gap-3 mb-3">
              <img src="/noxa-logo-192.png" alt="" aria-hidden className="w-10 h-10 rounded-lg" />
              <div className="font-mono font-bold text-[24px] tracking-tight">NOXA</div>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed max-w-xs">
              夜職 DX プラットフォームの構想。<br />
              EGSHUGY LAB 傘下、共有ブランド名として運用中。
            </p>
          </div>
          <div>
            <h5 className="text-[11px] text-muted-foreground uppercase tracking-wider font-mono mb-3.5">// PAGES</h5>
            <a href="#sub-products" className="block text-[13px] mb-2 hover:text-[#A89BFF] transition-colors">Sub Products</a>
            <a href="#features" className="block text-[13px] mb-2 hover:text-[#6D4FE8] transition-colors">Features</a>
            <a href="#vision" className="block text-[13px] mb-2 hover:text-[#A89BFF] transition-colors">Vision</a>
            <a href="#commitment" className="block text-[13px] mb-2 hover:text-[#6D4FE8] transition-colors">Commitment</a>
          </div>
          <div>
            <h5 className="text-[11px] text-muted-foreground uppercase tracking-wider font-mono mb-3.5">// COMPANY</h5>
            <Link href="/" className="block text-[13px] mb-2 hover:text-[#6D4FE8] transition-colors">EGSHUGY LAB</Link>
            <a href="#about" className="block text-[13px] mb-2 hover:text-[#6D4FE8] transition-colors">About</a>
            <a href="#contact" className="block text-[13px] mb-2 hover:text-[#6D4FE8] transition-colors">Contact</a>
          </div>
          <div>
            <h5 className="text-[11px] text-muted-foreground uppercase tracking-wider font-mono mb-3.5">// FOLLOW</h5>
            <a href="https://x.com/egshugy" target="_blank" rel="noopener noreferrer" className="block text-[13px] mb-2 hover:text-[#6D4FE8] transition-colors">X / Twitter</a>
            <a href="https://instagram.com/egshugy" target="_blank" rel="noopener noreferrer" className="block text-[13px] mb-2 hover:text-[#6D4FE8] transition-colors">Instagram</a>
            <a href="https://tiktok.com/@egshugy" target="_blank" rel="noopener noreferrer" className="block text-[13px] mb-2 hover:text-[#6D4FE8] transition-colors">TikTok</a>
          </div>
        </div>
        <div className="pt-5 flex flex-wrap justify-between items-center gap-3 text-[11px] text-muted-foreground font-mono">
          <span>© 2026 NOXA · EGSHUGY LAB · ALL RIGHTS RESERVED</span>
          <span>// CONCEPT · NOT LAUNCHED YET</span>
        </div>
      </footer>
    </div>
  )
}
