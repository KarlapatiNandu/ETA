import * as Sentry from "@sentry/react";

/**
 * Sentry for the driver app (BUILD_PLAN Stage 8). Loaded as its own chunk, and only when
 * VITE_SENTRY_DSN is set, so a build without it ships not one byte of the SDK — the driver
 * bundle is already the thing we watch (M02).
 *
 * The phone holds the tracker's HMAC secret: no request headers or bodies are ever attached
 * (the signature headers would be there), and there is no user.
 */
export function startSentry(dsn: string) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0,
    // Sentry 11 collects all of these by default
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    },
    beforeSend(event) {
      delete event.user;
      if (event.request) {
        delete event.request.headers;
        delete event.request.data;
        delete event.request.cookies;
      }
      return event;
    },
    beforeBreadcrumb(b) {
      // fetch breadcrumbs carry request bodies in some integrations: keep the URL only
      if (b.category === "fetch" || b.category === "xhr")
        return { ...b, data: { url: b.data?.url } };
      return b;
    },
  });
}
