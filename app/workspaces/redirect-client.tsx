"use client"

import { useEffect } from "react"

/**
 * yorulog の Service Worker が localhost:3000/workspaces にキャッシュを保持してしまう問題への対応。
 * このルートを開いたら強制的にトップ "/" に書き換える。
 * yorulog の SW・キャッシュも layout.tsx で全削除されるので、リロード後はトップが見える。
 *
 * JS 無効・クローラ・SW 経由の描画では useEffect が走らないため、必ず実リンクも描画する
 * (従来は暗色スタブで停止し、そこが行き止まりだった)。noindex 側の宣言は page.tsx が担当。
 */
export default function WorkspacesRedirect() {
  useEffect(() => {
    window.location.replace("/")
  }, [])
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", gap: "16px", alignItems: "center", justifyContent: "center", background: "#0d0d0d", color: "#f5f5f5", fontFamily: "monospace" }}>
      <p>EGSHUGY LAB に移動中...</p>
      <a href="/" style={{ color: "#f5f5f5", textDecoration: "underline" }}>
        自動で移動しない場合はこちら
      </a>
    </div>
  )
}
