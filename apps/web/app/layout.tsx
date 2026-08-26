import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "../components/layout/app-shell";
import { Toaster } from "../components/ui/toaster";
import { PwaRegister } from "../components/pwa-register";

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
      <body><PwaRegister /><AppShell>{children}</AppShell><Toaster /></body>
    </html>
  );
}
