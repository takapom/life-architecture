import type { Metadata } from "next";
import { Fira_Code, Fira_Sans } from "next/font/google";
import "./globals.css";
import GlobalNav from "./components/GlobalNav";

const firaCode = Fira_Code({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-heading",
  display: "swap",
});

const firaSans = Fira_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: "人生アーキテクチャ診断",
  description: "あなたの人生をソフトウェアアーキテクチャで診断する",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className={`${firaCode.variable} ${firaSans.variable}`}>
      <body>
        <GlobalNav />
        {children}
      </body>
    </html>
  );
}
