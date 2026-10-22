import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WPS Cloud Bridge for ChatGPT · 云文档连接",
  description: "独立开源连接器：授权个人金山文档，在 ChatGPT 对话中查找、阅读和处理 WPS 云端文件。",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
