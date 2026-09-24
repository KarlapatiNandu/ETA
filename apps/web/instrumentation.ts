import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "./lib/sentry";

/** Stage 8: server-side render and middleware errors (off without a DSN). */
export async function register() {
  Sentry.init(sentryOptions(process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN));
}

export const onRequestError = Sentry.captureRequestError;
