import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WPS Cloud Bridge for ChatGPT · 云文档连接",
  description: "独立的 ChatGPT 云端连接器：授权个人金山文档，在对话中处理 WPS 云文件；无需本地 WPS 或电脑常开。",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
