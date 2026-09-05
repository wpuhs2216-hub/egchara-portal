"use client"

import { Dice5, Skull } from "lucide-react"
import type { LucideIcon } from "lucide-react"

interface AppItem {
  name: string
  icon: LucideIcon
  color: string
  href: string
  comingSoon: boolean
}

interface AppCategory {
  label: string
  emoji: string
  apps: AppItem[]
}

const categories: AppCategory[] = [
  // 2026-09-05: Web のパーティーゲーム群は引退（旧 URL はトップへ 301）。残るのはエグキャラ IP の 2 本。
  // このコンポーネントはどのページからも import されていない（check-links も import 時だけ抽出する）。
  {
    label: "ゲーム",
    emoji: "🎮",
    apps: [
      { name: "ぺかりんのえぐしゅぎチンチロ", icon: Dice5, color: "from-purple-500 to-pink-500", href: "/pekarin-chinchiro/", comingSoon: false },
    ],
  },
  {
    label: "ツール & 診断",
    emoji: "🔧",
    apps: [
      { name: "エグタイプ診断", icon: Skull, color: "from-pink-500 to-fuchsia-500", href: "/egtype/", comingSoon: false },
    ],
  },
]

function AppCard({ app }: { app: AppItem }) {
  return (
    <a
      key={app.name}
      href={app.comingSoon ? undefined : app.href}
      className={`flex-shrink-0 w-[120px] md:w-auto md:flex-shrink md:flex-1 md:min-w-[100px] md:max-w-[160px] group ${app.comingSoon ? "cursor-not-allowed" : ""}`}
      onClick={app.comingSoon ? (e) => e.preventDefault() : undefined}
    >
      <div className={`relative aspect-square rounded-2xl bg-card overflow-hidden transition-all duration-150 ${app.comingSoon
          ? "opacity-60 grayscale"
          : "active:scale-95 group-hover:ring-2 group-hover:ring-primary/50"
        }`}>
        {/* Gradient Background */}
        <div className={`absolute inset-0 bg-gradient-to-br ${app.color} opacity-20 group-hover:opacity-30 transition-opacity`} />

        {/* Glow Effect */}
        <div className={`absolute inset-0 bg-gradient-to-br ${app.color} opacity-0 ${app.comingSoon ? "" : "group-hover:opacity-10"} blur-xl transition-opacity`} />

        {/* Icon */}
        <div className="absolute inset-0 flex items-center justify-center">
          <app.icon className="w-10 h-10 text-foreground/80" />
        </div>

        {/* Coming Soon Overlay */}
        {app.comingSoon && (
          <div className="absolute top-2 right-2">
            <span className="text-[10px] bg-black/60 text-white px-2 py-0.5 rounded-full backdrop-blur-sm border border-white/10">
              Soon
            </span>
          </div>
        )}

        {/* Border Glow */}
        <div className="absolute inset-0 rounded-2xl ring-1 ring-white/10" />
      </div>

      {/* App Name */}
      <p className="mt-1.5 text-xs text-center text-foreground/90 font-medium truncate">
        {app.name}
      </p>
    </a>
  )
}

export function FeaturedApps() {
  return (
    <section className="py-4 px-4">
      {categories.map((category) => (
        <div key={category.label} className="mb-5">
          {/* Category Header */}
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-bold text-foreground flex items-center gap-2">
              <span>{category.emoji}</span>
              <span>{category.label}</span>
            </h2>
          </div>

          {/* Horizontal Scrollable Cards */}
          <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 scrollbar-hide md:flex-wrap md:overflow-x-visible md:mx-0 md:px-0" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
            {category.apps.map((app) => (
              <AppCard key={app.name} app={app} />
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}
