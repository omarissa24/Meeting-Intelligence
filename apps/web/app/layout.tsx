import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://meeting-intelligence-murex.vercel.app";
const title = "Meeting Intelligence — capture, transcribe & summarise every meeting";
const description =
  "A native desktop app that captures meeting audio, transcribes it live, and turns it into LLM-summarised intelligence. Download for macOS and Windows.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  applicationName: "Meeting Intelligence",
  openGraph: {
    type: "website",
    url: siteUrl,
    siteName: "Meeting Intelligence",
    title,
    description,
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} dark`}>
      <body className="min-h-dvh app-atmosphere">{children}</body>
    </html>
  );
}
