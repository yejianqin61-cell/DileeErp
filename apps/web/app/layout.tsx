import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "迪礼 ERP",
  description: "迪礼伞业厂内 ERP",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
