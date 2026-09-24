import { sentryOptions } from "./lib/sentry";

// Stage 8: browser errors from the student PWA and the TD console. The SDK is its own chunk,
// fetched only when a DSN is configured: without one, no student downloads a byte of it.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) void import("@sentry/nextjs").then((Sentry) => Sentry.init(sentryOptions(dsn)));
