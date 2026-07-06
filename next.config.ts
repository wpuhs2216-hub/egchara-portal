import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    output: "export",
    trailingSlash: true,
    images: {
        unoptimized: true,
    },
    typescript: {
        // 型エラーをビルドゲートにする（恒久）。Day1〜7 で 0 エラーを確認済み。
        // true に戻すのは禁止（エラーを隠すだけで直らない）。
        ignoreBuildErrors: false,
    },
    // 注(grind Day1): Next16 は NextConfig から `eslint` オプションを削除（`next lint` 廃止）。
    // 本リポは eslint 依存・設定ファイルも未導入のため eslint ゲートは対象外。
};

export default nextConfig;
