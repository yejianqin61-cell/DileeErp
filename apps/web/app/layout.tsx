import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "../components/layout/app-shell";
import { Toaster } from "../components/ui/toaster";

export const metadata: Metadata = {
  title: "迪礼管理系统",
  description: "迪礼伞业厂内管理系统",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body><AppShell>{children}</AppShell><Toaster /></body>
    </html>
  );
}
