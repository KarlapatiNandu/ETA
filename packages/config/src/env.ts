import { z } from "zod";

/**
 * Every environment variable the system reads, grouped by the component that needs it.
 * `.env.example` documents each key; the two must stay in step (see env.test.ts).
 *
 * Apps parse only the groups they use, so the driver app never needs a database URL.
 */

const url = z.url();
const nonEmpty = z.string().min(1);

export const coreEnv = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  TZ_OPERATING: z.literal("Asia/Kolkata").default("Asia/Kolkata"),
});

export const supabaseEnv = z.object({
  SUPABASE_URL: url,
  SUPABASE_ANON_KEY: nonEmpty,
  SUPABASE_SERVICE_ROLE_KEY: nonEmpty,
  SUPABASE_JWT_SECRET: z.string().min(32),
  DATABASE_URL: url,
});

export const redisEnv = z.object({ REDIS_URL: url });

export const geoServicesEnv = z.object({
  OSRM_CAR_URL: url,
  OSRM_FOOT_URL: url,
  PHOTON_URL: url,
  TILES_URL: url,
});

export const smsEnv = z.discriminatedUnion("SMS_PROVIDER", [
  z.object({ SMS_PROVIDER: z.literal("console") }),
  z.object({
    SMS_PROVIDER: z.literal("msg91"),
    MSG91_AUTH_KEY: nonEmpty,
    MSG91_SENDER_ID: z.string().length(6),
    MSG91_TEMPLATE_OTP: nonEmpty,
    /** Stage 6: the T0/T1 alert templates. Unset = that SMS cannot be sent (DLT pending). */
    MSG91_TEMPLATE_T0: nonEmpty.optional(),
    MSG91_TEMPLATE_T1: nonEmpty.optional(),
  }),
]);

/**
 * Stage 6 notification spine. Push is optional in development — without VAPID keys every
 * student is treated as having no push subscription, and T0/T1 go by SMS — but the keys come
 * as a pair.
 */
export const notifyEnv = z
  .object({
    VAPID_PUBLIC_KEY: nonEmpty.optional(),
    VAPID_PRIVATE_KEY: nonEmpty.optional(),
    /** contact the push services require: mailto:… or https://… */
    VAPID_SUBJECT: z
      .string()
      .regex(/^(mailto:|https:\/\/)/, "must start with mailto: or https://")
      .default("mailto:transport@busmitra.invalid"),
    /** shared secret on the MSG91 delivery-receipt webhook URL */
    SMS_RECEIPT_TOKEN: z.string().min(16).optional(),
  })
  .refine((e) => !!e.VAPID_PUBLIC_KEY === !!e.VAPID_PRIVATE_KEY, {
    message: "set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY together (or neither)",
    path: ["VAPID_PRIVATE_KEY"],
  });

export const gatewayEnv = z.object({
  GATEWAY_PORT: z.coerce.number().int().positive().default(4000),
  /** HMAC key for the decoy masked phone numbers returned to unknown roll numbers. */
  CLAIM_DECOY_KEY: z.string().min(32),
  /** Symmetric key for trackers.secret_enc (pgp_sym_encrypt). Never stored in the database. */
  TRACKER_SECRET_KEY: z.string().min(32),
  WEB_ORIGIN: url,
  /** Origin of the driver PWA (a separate origin by design, ARCH §2.1): CORS + pairing links. */
  DRIVER_ORIGIN: url.default("http://localhost:5173"),
});

export class EnvError extends Error {
  readonly issues: { variable: string; problem: string }[];
  constructor(issues: { variable: string; problem: string }[]) {
    super(
      "Invalid environment — the process cannot start.\n" +
        issues.map((i) => `  • ${i.variable}: ${i.problem}`).join("\n") +
        "\nSee .env.example for what each variable is and where to obtain it.",
    );
    this.name = "EnvError";
    this.issues = issues;
  }
}

/**
 * Parse `source` against `schema`, throwing an EnvError that names every bad variable.
 * Called once at boot; nothing downstream reads process.env directly.
 */
export function loadEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  // Treat empty strings as absent, so `FOO=` in a .env file reads as "missing", not as a value.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ""));
  const result = schema.safeParse(cleaned);
  if (result.success) return result.data;
  throw new EnvError(
    result.error.issues.map((issue) => {
      const variable = issue.path.map(String).join(".") || "(environment)";
      const missing = cleaned[variable] === undefined;
      return { variable, problem: missing ? "is not set" : issue.message };
    }),
  );
}
