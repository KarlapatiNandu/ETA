import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestGateway } from "../testing.ts";

/** BUILD_PLAN Stage 9 — security headers on every gateway response. */
describe("gateway security headers", () => {
  let gw: Awaited<ReturnType<typeof createTestGateway>>;
  beforeAll(async () => void (gw = await createTestGateway()));
  afterAll(() => gw.app.close());

  it("marks every answer unsniffable, unframeable, uncacheable and referrer-free", async () => {
    for (const url of ["/healthz", "/v1/admin/buses", "/v1/nope"]) {
      const res = await gw.app.inject({ method: "GET", url });
      expect(res.headers["x-content-type-options"], url).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["content-security-policy"]).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["cache-control"]).toBe("no-store");
      // HSTS is production-only (TLS terminates at the edge there)
      expect(res.headers["strict-transport-security"]).toBeUndefined();
    }
  });
});
