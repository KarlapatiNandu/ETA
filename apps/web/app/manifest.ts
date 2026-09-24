import type { MetadataRoute } from "next";

/**
 * The web app manifest (Stage 6). Installability is not decoration here: iOS delivers Web Push
 * only to a PWA added to the Home Screen, so without this there is no push on iPhone at all.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Bus Mitra",
    short_name: "Bus Mitra",
    description: "Live college bus tracking and alerts",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0b0d10",
    theme_color: "#0b0d10",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
