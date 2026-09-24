import type { ErrorEvent, NodeOptions } from "@sentry/nextjs";

/**
 * Sentry for the student PWA and the TD console (BUILD_PLAN Stage 8). Off unless
 * NEXT_PUBLIC_SENTRY_DSN is set. Errors only — no performance tracing (OpenTelemetry does that
 * on the gateway and engine) and no session replay.
 *
 * Nothing that identifies a student leaves the phone: no IP, no cookies, no auth header, no
 * user object, and the query string is dropped from every URL (a search query can be a home
 * locality). ARCH §10.
 */
export const NO_DATA: NonNullable<NodeOptions["dataCollection"]> = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  genAI: { inputs: false, outputs: false },
  graphQL: { document: false, variables: false },
};

export function sentryOptions(dsn: string | undefined): NodeOptions {
  return {
    dsn,
    enabled: !!dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: 0,
    // Sentry 11 collects all of these by default; every one is off. Local variables in a stack
    // frame are the dangerous one — they can hold a roll number, a phone or a token
    dataCollection: NO_DATA,
    beforeSend: scrub,
  };
}

export function scrub(event: ErrorEvent): ErrorEvent {
  delete event.user;
  if (event.request) {
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.query_string;
    delete event.request.data;
    if (event.request.url) event.request.url = event.request.url.split("?")[0];
  }
  for (const b of event.breadcrumbs ?? []) {
    const url = b.data?.url;
    if (typeof url === "string") b.data!.url = url.split("?")[0];
  }
  return event;
}
