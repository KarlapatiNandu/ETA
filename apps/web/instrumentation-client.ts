import { z } from "zod";
import { sentryOptions } from "./lib/sentry";

// Zod 4 probes whether it may compile validators with `Function("")`. Under the app's CSP
// (no 'unsafe-eval', Stage 9) the probe is refused and every page logs a CSP violation, drowning
// real ones. Tell it up front: interpret, never compile. (Validation results are identical.)
z.config({ jitless: true });

// Stage 8: browser errors from the student PWA and the TD console. The SDK is its own chunk,
// fetched only when a DSN is configured: without one, no student downloads a byte of it.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) void import("@sentry/nextjs").then((Sentry) => Sentry.init(sentryOptions(dsn)));
