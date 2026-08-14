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
          最後に自分の /sw.js を登録する。既に登録済みなら register は冪等。

          Day122: Day107 は Cache Storage の全消しを「汚染を見つけた時だけ」に**回数**を絞ったが、
          **範囲**はオリジン全体のまま(caches.keys() を絞らず全件 delete)だった。汚染端末＝既に
          困っている端末で、同居する子アプリ(egtype/kingscup/word-wolf/pekarin)のプリキャッシュまで
          道連れにする形が最後の1経路として残っていた。しかも Day107/110 の巻き添えガードは
          アロー記法しか見ておらず、この script は ES5 の function 式なので**母集団に入っていながら
          永久に白**だった(実測: 同内容のアロー版は検知・function 版は0件)。
          全消しは削除する。汚染の実体はルートスコープの SW 登録そのもので、それは上で unregister
          済み。残る孤児キャッシュは、portal 自身の SW がオフライン応答を**自分のキャッシュに限って**
          探す形にした(public/sw.js)ので、もう誰の応答にもならない。
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){var R=location.origin+'/';navigator.serviceWorker.getRegistrations().then(function(rs){var bad=rs.filter(function(r){return r.scope===R&&!((r.active||r.waiting||r.installing||{}).scriptURL||'').endsWith('/sw.js')});return Promise.all(bad.map(function(r){return r.unregister()}))}).then(function(){return navigator.serviceWorker.register('/sw.js')}).catch(function(){})}`,
          }}
        />
      </body>
    </html>
  )
}
