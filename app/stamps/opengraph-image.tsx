/**
 * /stamps の OG 画像。ルート app/opengraph-image.tsx の生成 OG(エグキャラ共通カード)を再利用する。
 * ファイルベース OG はルート→子ルートへ自動継承されない(実測: /stamps は og:image 無しになる)ため、
 * twitter-image.tsx と同じ再エクスポート方式で明示的に持たせる。以前 metadata で実在しない
 * 静的 /og-image.png を指し共有カードが 404 だった不具合(Day82)を、有効な生成 OG に置き換える。
 */
export const dynamic = 'force-static'
export { default, alt, size, contentType } from '../opengraph-image'
