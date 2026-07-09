import React from "react"
import type { Metadata, Viewport } from 'next'
import { Noto_Sans_JP, Nunito, DM_Sans } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import './globals.css'

// 和文（見出し・本文とも）: Noto Sans JP（柔らかい丸ゴ寄り）
const notoSansJP = Noto_Sans_JP({
  subsets: ['latin'],
  weight: ['400', '500', '700', '900'],
  variable: '--font-noto-sans-jp',
  display: 'swap',
})

// マスコット見出し（ラテン）: Nunito Black（粘土風・ぷっくり）
const nunito = Nunito({
  subsets: ['latin'],
  weight: ['700', '800', '900'],
  variable: '--font-nunito',
  display: 'swap',
})

// 本文（ラテン）: DM Sans（読みやすく親しみのある幾何サンセリフ）
const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-dm-sans',
  display: 'swap',
})

export const metadata: Metadata = {
  metadataBase: new URL('https://egshugy.com'),
  title: 'エグキャラ — 32体のエグかわ妖精たち。',
  description: 'エグキャラ公式サイト。自虐 × 妖精語 × 匂わせポエムで生まれた32体のエグかわキャラクター。エグタイプ診断で自分のエグキャラを見つけよう。ぺかりんのちんちろ・LINEスタンプも。',
  // og:image / twitter:image は app/opengraph-image.tsx と app/twitter-image.tsx で自動生成
  openGraph: {
    title: 'エグキャラ — 32体のエグかわ妖精たち。',
    description: '自虐 × 妖精語 × 匂わせポエムで生まれた32体のエグかわキャラクター。',
    type: 'website',
    locale: 'ja_JP',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'エグキャラ — 32体のエグかわ妖精たち。',
    description: '自虐 × 妖精語 × 匂わせポエムで生まれた32体のエグかわキャラクター。',
  },
  generator: 'v0.app',
  // favicon / apple-touch-icon は app/icon.tsx と app/apple-icon.tsx で動的生成
  manifest: '/manifest.json',
}

export const viewport: Viewport = {
  themeColor: '#fff8f0',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="ja">
      <body className={`${notoSansJP.variable} ${nunito.variable} ${dmSans.variable} font-sans antialiased`}>
        {children}
        <Analytics />
        {/* GA4（暫定で egtype と同一プロパティ G-J5KGMEKCF4 を流用。別プロパティ化は ID 差し替えのみ） */}
        <script async src="https://www.googletagmanager.com/gtag/js?id=G-J5KGMEKCF4" />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-J5KGMEKCF4');`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){navigator.serviceWorker.getRegistrations().then(rs=>Promise.all(rs.map(r=>r.unregister()))).then(()=>caches.keys().then(ks=>Promise.all(ks.map(k=>caches.delete(k))))).then(()=>navigator.serviceWorker.register('/sw.js'))}`,
          }}
        />
      </body>
    </html>
  )
}
