import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as env from "./env.ts";

const { EnvError, loadEnv, supabaseEnv, smsEnv, gatewayEnv } = env;

describe("loadEnv", () => {
  it("names a missing variable in a readable message", () => {
    expect(() => loadEnv(supabaseEnv, { SUPABASE_URL: "http://localhost:54321" })).toThrowError(
      /SUPABASE_ANON_KEY: is not set/,
    );
  });

  it("names every bad variable at once, not just the first", () => {
    try {
      loadEnv(supabaseEnv, {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      const names = (err as InstanceType<typeof EnvError>).issues.map((i) => i.variable);
      expect(names).toEqual(
        expect.arrayContaining([
          "SUPABASE_URL",
          "SUPABASE_ANON_KEY",
          "SUPABASE_SERVICE_ROLE_KEY",
          "SUPABASE_JWT_SECRET",
          "DATABASE_URL",
        ]),
      );
    }
  });

  it("treats an empty assignment as missing", () => {
    expect(() => loadEnv(z.object({ REDIS_URL: z.url() }), { REDIS_URL: "" })).toThrowError(
      /REDIS_URL: is not set/,
    );
  });

  it("reports a malformed value differently from a missing one", () => {
    expect(() => loadEnv(z.object({ REDIS_URL: z.url() }), { REDIS_URL: "nope" })).toThrowError(
      /REDIS_URL: (?!is not set)/,
    );
  });

  it("requires MSG91 credentials only when MSG91 is the provider", () => {
    expect(loadEnv(smsEnv, { SMS_PROVIDER: "console" })).toEqual({ SMS_PROVIDER: "console" });
    expect(() => loadEnv(smsEnv, { SMS_PROVIDER: "msg91" })).toThrowError(/MSG91_AUTH_KEY/);
  });

  it("applies defaults", () => {
    const parsed = loadEnv(gatewayEnv, {
      CLAIM_DECOY_KEY: "x".repeat(32),
      TRACKER_SECRET_KEY: "y".repeat(32),
      WEB_ORIGIN: "http://localhost:3000",
    });
    expect(parsed.GATEWAY_PORT).toBe(4000);
  });
});

describe(".env.example", () => {
  it("documents every variable the schemas read", () => {
    const example = readFileSync(resolve(import.meta.dirname, "../../../.env.example"), "utf8");
    const documented = new Set([...example.matchAll(/^#?\s*([A-Z0-9_]+)=/gm)].map((m) => m[1]));
    const keys = new Set<string>();
    const collect = (schema: z.ZodType): void => {
      if (schema instanceof z.ZodObject) Object.keys(schema.shape).forEach((k) => keys.add(k));
      if (schema instanceof z.ZodDiscriminatedUnion)
        schema.options.forEach((o) => collect(o as z.ZodType));
    };
    Object.values(env).forEach((v) => v instanceof z.ZodType && collect(v));
    const undocumented = [...keys].filter((k) => !documented.has(k));
    expect(undocumented).toEqual([]);
  });
});
