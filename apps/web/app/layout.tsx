import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bus Mitra",
  description: "Live college bus tracking",
  // iOS: installable from the Share sheet, which is the only way it will deliver push
  appleWebApp: { capable: true, title: "Bus Mitra", statusBarStyle: "black-translucent" },
  icons: { apple: "/apple-touch-icon.png", icon: "/icons/icon-192.png" },
};
export const viewport: Viewport = { themeColor: "#0b0d10", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
