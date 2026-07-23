// 稼働日数カウンタの算出。トップページ(app/page.tsx)と NOXA ページ(app/noxa/page.tsx)で
// 同じ日数差ロジックを別々にインラインしていたため、片方(トップ)だけ Math.max(0,…) の
// 下限クランプが欠けており、クライアント端末の時計が起点日より過去にずれていると
// 「-3日」のような負の稼働日数を表示しうる穴があった。単一実装に集約して両者の防御を揃える。
//
// origin より過去(クロックずれ)でも 0 を下限に返す純関数。now は既定で現在時刻。
export function daysSince(originIso: string, now: number = Date.now()): number {
  const origin = new Date(originIso).getTime()
  return Math.max(0, Math.floor((now - origin) / (1000 * 60 * 60 * 24)))
}
