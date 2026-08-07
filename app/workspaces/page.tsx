import type { Metadata } from "next"
import WorkspacesRedirect from "./redirect-client"

/**
 * /workspaces/ は yorulog の Service Worker 汚染端末の救済スタブで、コンテンツを持たない。
 * 従来は "use client" ページだったため metadata を宣言できず、レイアウト既定の title/description/OG
 * (＝トップと完全同一)がそのまま出ていた。robots.txt は Allow: / なのでクローラは到達でき、
 * 「トップと同じ title/description を名乗る中身の無いページ」が重複コンテンツとして索引されうる。
 * ページ本体を server component に戻して noindex を宣言し、リダイレクト実装だけを client に切り出す。
 */
export const metadata: Metadata = {
    title: "移動中… | えぐしゅぎ ラボ",
    description: "このURLはトップページへ移動します。",
    robots: { index: false, follow: true },
}

export default function WorkspacesPage() {
    return <WorkspacesRedirect />
}
