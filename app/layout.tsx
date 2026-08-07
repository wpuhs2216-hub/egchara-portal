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
        {/*
          SW ブートストラップ。元は「オリジン全体の SW 登録を全解除 → Cache Storage を全消し →
          /sw.js を再登録」だったが、egshugy.com には子アプリが同居していて /egtype/sw.js
          (egtype が実際に register している)・/pekarin-chinchiro/sw.js・/word-wolf/sw.js・
          /kingscup/sw.js がいずれも稼働中。getRegistrations() も caches.keys() も**スコープ無関係に
          オリジン全体**を返すため、ポータルを開くたびに子アプリ全部の SW とプリキャッシュが
          消えていた(相互リンクなので通常動線で毎回踏む)。元の意図は yorulog の SW 汚染端末の救済で、
          汚染の正体は**ルートスコープを握った他所製の SW**。よって:
            ・解除対象はルートスコープ(scope === origin + '/')かつ /sw.js 以外の登録に限る
              → 子アプリ(スコープが /egtype/ 等)は巻き込まない
            ・Cache Storage の全消しは「汚染を実際に見つけた時だけ」行う(平常時は何も消さない)
          最後に自分の /sw.js を登録する。既に登録済みなら register は冪等。
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){var R=location.origin+'/';navigator.serviceWorker.getRegistrations().then(function(rs){var bad=rs.filter(function(r){return r.scope===R&&!((r.active||r.waiting||r.installing||{}).scriptURL||'').endsWith('/sw.js')});return Promise.all(bad.map(function(r){return r.unregister()})).then(function(){return bad.length?caches.keys().then(function(ks){return Promise.all(ks.map(function(k){return caches.delete(k)}))}):null})}).then(function(){return navigator.serviceWorker.register('/sw.js')}).catch(function(){})}`,
          }}
        />
      </body>
    </html>
  )
}
