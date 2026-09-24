import { describe, expect, it } from "vitest";
import { scrub, sentryOptions } from "./sentry";

describe("Sentry scrubbing (ARCH §10: nothing identifying leaves the phone)", () => {
  it("is off without a DSN", () => {
    expect(sentryOptions(undefined).enabled).toBe(false);
    const o = sentryOptions("https://k@o1.ingest.sentry.io/1");
    expect(o.enabled).toBe(true);
    // Sentry 11 defaults every one of these to on
    expect(o.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    });
  });

  it("drops the user, cookies, headers, body and every query string", () => {
    const e = scrub({
      type: undefined,
      user: { id: "u1", ip_address: "10.0.0.1" },
      request: {
        url: "https://busmitra.in/search?q=my+street",
        query_string: "q=my+street",
        cookies: { sb: "token" },
        headers: { authorization: "Bearer x" },
        data: { roll: "160125737900" },
      },
      breadcrumbs: [{ data: { url: "https://gw/v1/search?q=home" } }],
    });
    expect(e.user).toBeUndefined();
    expect(e.request).toEqual({ url: "https://busmitra.in/search" });
    expect(e.breadcrumbs![0]!.data!.url).toBe("https://gw/v1/search");
  });
});
