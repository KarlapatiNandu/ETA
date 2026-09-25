import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bus Mitra",
  description: "Live college bus tracking",
  // iOS: installable from the Share sheet, which is the only way it will deliver push
  appleWebApp: { capable: true, title: "Bus Mitra", statusBarStyle: "black-translucent" },
  icons: { apple: "/apple-touch-icon.png", icon: "/icons/icon-192.png" },
};
export const viewport: Viewport = { themeColor: "#0b0d10", width: "device-width", initialScale: 1 };

/**
 * Reading the request headers makes every page render per request, which the CSP nonce needs
 * (Stage 9): a page prerendered at build time would carry no nonce and its scripts would be
 * blocked. The pages that were static (login, claim, recover) are small forms; the cost is nil.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await headers();
  return (
    <html lang="en">
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
