import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "../components/layout/app-shell";
import { Toaster } from "../components/ui/toaster";
import { PwaRegister } from "../components/pwa-register";
import { LEGACY_COMPAT_SCRIPT } from "../lib/legacy-compat";

export const metadata: Metadata = {
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
  title: "迪礼ERP(测试版)",
  description: "迪礼伞业厂内管理系统",
};

export const viewport: Viewport = { themeColor: "#0f766e" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <head>
        {/*
          老旧浏览器兼容层（2026-11-21）。必须内联在 <head> 且先于任何打包产物执行。

          为什么不能用 `import "./legacy-compat"`：那是模块依赖，执行时机由打包顺序决定，
          供应商 chunk 可能先跑 —— 而本脚本补的 `AbortSignal.timeout` 正是 api-client 里
          每次请求都用的东西，晚一步就会有一批请求先抛错。

          另注：`<script>` 里的内容是 ES5（可在 IE11 上解析），一旦写成箭头函数/let/const，
          语法错误会让下面的兜底提示都显示不出来。`test/legacy-compat.test.tsx` 有守卫。
        */}
        <script dangerouslySetInnerHTML={{ __html: LEGACY_COMPAT_SCRIPT }} />
      </head>
      <body><PwaRegister /><AppShell>{children}</AppShell><Toaster /></body>
    </html>
  );
}
