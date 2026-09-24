import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The driver PWA (ARCH §2.1): a tiny, dependency-light bundle on its own origin, so it boots
 * on a cheap Android phone on a weak connection and its service worker can never collide with
 * the student app's. VITE_* variables come from the one root .env.
 */
export default defineConfig(({ command }) => ({
  plugins: [react()],
  envDir: "../..",
  // The root .env sets NODE_ENV=development for the servers, and Vite honours NODE_ENV from
  // env files — which silently ships React's development build (3× larger) from `vite build`.
  define: {
    "process.env.NODE_ENV": JSON.stringify(command === "build" ? "production" : "development"),
  },
  build: { target: "es2020", sourcemap: true },
}));
