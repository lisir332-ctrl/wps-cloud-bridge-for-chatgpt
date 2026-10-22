import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WPS 云文档连接 · 个人工作台",
  description: "连接个人金山文档，在 ChatGPT 对话中查找、阅读和处理云端文件。无需电脑常开，授权由你掌握。",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
