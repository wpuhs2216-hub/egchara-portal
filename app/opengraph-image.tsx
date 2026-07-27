import { ImageResponse } from 'next/og'
import fs from 'fs'
import path from 'path'

/**
 * OG 画像をコードでレンダー（1200x630）
 * デザイン言語「エグキャラ・ポップ」: クリーム #FFF8F0 + ビビッド紫 #8B5CF6 + 多色アクセント
 * ワードマークロゴ（public/egchara-logo.png）を base64 埋め込みで中央に大きく配置。
 * フォント Noto Sans JP は Google Fonts から subset で取得（必要文字のみ）。
 */

// output: 'export' で静的ビルドに含めるため必要
export const dynamic = 'force-static'

export const alt = 'エグキャラ — 32体のエグかわ妖精たち。'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

// OG 画像に実描画するテキスト。フォント subset(OG_TEXT)はこれらを機械連結して構築するため、
// 文言を変えても subset の取りこぼし(「。」「×」「.」等のグリフ欠け=手動列挙時に漏れていた)が
// 起きない。JSX でも同じ定数を描画し、描画文字 ⊆ subset を構造的に保証する。
const SUB_HEADLINE = '32体のエグかわ妖精たち。'
const SUB_TAGLINE = '自虐 × 妖精語 × 匂わせポエムで生まれたキャラクター'
const SITE_URL = 'egshugy.com'
const OG_TEXT = SUB_HEADLINE + SUB_TAGLINE + SITE_URL

async function loadGoogleFont(family: string, weight: number, text: string): Promise<ArrayBuffer | null> {
  try {
    const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}&text=${encodeURIComponent(text)}&display=swap`
    const css = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    }).then((r) => r.text())
    const match = css.match(/src:\s*url\((https:\/\/[^)]+\.woff2)\)/)
    if (!match) return null
    const fontUrl = match[1]
    return await fetch(fontUrl).then((r) => r.arrayBuffer())
  } catch {
    return null
  }
}

export default async function OGImage() {
  // 並列でフォントを取得
  const [black, regular] = await Promise.all([
    loadGoogleFont('Noto Sans JP', 900, OG_TEXT),
    loadGoogleFont('Noto Sans JP', 400, OG_TEXT),
  ])

  // ワードマークロゴを base64 で埋め込む
  const logoBuffer = fs.readFileSync(path.join(process.cwd(), 'public', 'egchara-logo.png'))
  const logoSrc = `data:image/png;base64,${logoBuffer.toString('base64')}`

  const fonts = [
    black && { name: 'Noto Sans JP', data: black, style: 'normal' as const, weight: 900 as const },
    regular && { name: 'Noto Sans JP', data: regular, style: 'normal' as const, weight: 400 as const },
  ].filter(Boolean) as { name: string; data: ArrayBuffer; style: 'normal'; weight: 400 | 900 }[]

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#FFF8F0',
          color: '#1a1325',
          position: 'relative',
          fontFamily: '"Noto Sans JP"',
        }}
      >
        {/* 装飾: ピンクのふわふわ円光（右上） */}
        <div
          style={{
            position: 'absolute',
            top: '-140px',
            right: '-120px',
            width: '520px',
            height: '520px',
            borderRadius: '50%',
            background: 'radial-gradient(circle, #ff5ca8 0%, transparent 68%)',
            opacity: 0.4,
            display: 'flex',
          }}
        />
        {/* 装飾: シアンのふわふわ円光（左下） */}
        <div
          style={{
            position: 'absolute',
            bottom: '-120px',
            left: '-120px',
            width: '460px',
            height: '460px',
            borderRadius: '50%',
            background: 'radial-gradient(circle, #22d3ee 0%, transparent 70%)',
            opacity: 0.32,
            display: 'flex',
          }}
        />

        {/* 中央: ワードマークロゴ */}
        <img
          src={logoSrc}
          width={760}
          height={292}
          style={{ display: 'flex', zIndex: 1 }}
        />

        {/* サブコピー */}
        <div
          style={{
            marginTop: '36px',
            fontSize: '38px',
            fontWeight: 900,
            color: '#8B5CF6',
            letterSpacing: '0.01em',
            display: 'flex',
            zIndex: 1,
          }}
        >
          {SUB_HEADLINE}
        </div>
        <div
          style={{
            marginTop: '16px',
            fontSize: '24px',
            fontWeight: 400,
            color: '#6b5b85',
            display: 'flex',
            zIndex: 1,
          }}
        >
          {SUB_TAGLINE}
        </div>

        {/* 右下: URL */}
        <div
          style={{
            position: 'absolute',
            bottom: '40px',
            right: '56px',
            fontSize: '22px',
            fontWeight: 400,
            color: '#a89bbf',
            display: 'flex',
          }}
        >
          {SITE_URL}
        </div>
      </div>
    ),
    {
      ...size,
      fonts: fonts.length > 0 ? fonts : undefined,
    }
  )
}
