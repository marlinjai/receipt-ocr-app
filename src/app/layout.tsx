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
  // A page names itself with its own `metadata.title`; the template adds the app.
  title: { default: "Lumitra Receipts", template: "%s · Lumitra Receipts" },
  description: "Belege fotografieren, zuordnen und mit den Zahlungen abgleichen.",
  applicationName: "Lumitra Receipts",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Receipts",
  },
  formatDetection: {
    telephone: false,
  },
  // iOS takes no SVG for the home screen icon: without a PNG it shows a screenshot of the page instead.
  icons: {
    icon: [
      { url: "/icons/icon-512.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon-180.png", sizes: "180x180", type: "image/png" }],
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
    <html lang="de">
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
