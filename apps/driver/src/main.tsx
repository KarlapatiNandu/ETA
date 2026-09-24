import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

// Stage 8: error reporting, its own chunk and only when configured
const sentryDsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
if (sentryDsn) void import("./lib/sentry.ts").then((m) => m.startSentry(sentryDsn));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline shell (sw.js): the app must open in a dead zone to show its buffer, not a dino.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
}
