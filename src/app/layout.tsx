import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";
import { STALE_CHUNK_RELOAD_SCRIPT } from "@/lib/pwa/stale-chunk-reload";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Receipt OCR - Extract Text from Receipts",
  description: "Upload receipts and invoices to extract text using AI-powered OCR. Built with Storage Brain.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Receipt OCR",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: "/icons/icon-192.svg",
    apple: "/icons/icon-192.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#e2a348",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen`}
      >
        {/* First in the body, as text: it has to run before any script file of the app, because it is there for the case that one of them is gone. */}
        <script dangerouslySetInnerHTML={{ __html: STALE_CHUNK_RELOAD_SCRIPT }} />
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
