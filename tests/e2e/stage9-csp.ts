/**
 * Stage 9 in a real browser: the web app's per-request Content-Security-Policy must block
 * nothing the app itself needs — Next's scripts (nonce + strict-dynamic), MapLibre's blob:
 * workers and tiles, the gateway's API and SSE stream, Supabase auth — on a *production* build.
 * An inject() test cannot see a CSP violation; only a browser can.
 *
 *   (cd apps/web && next build && next start)   # plus the gateway
 *   E2E_ROLL=… E2E_PASSWORD=… node --experimental-strip-types tests/e2e/stage9-csp.ts
 *
 * Passes when every page renders, both maps draw a canvas, and there are zero CSP violations and
 * zero page errors.
 */
import { parseArgs } from "node:util";
import { launch, login } from "./cdp.ts";

const { values } = parseArgs({
  options: { base: { type: "string", default: "http://localhost:3000" } },
});
const base = values.base!;
const roll = process.env.E2E_ROLL;
const password = process.env.E2E_PASSWORD;
if (!roll || !password) throw new Error("set E2E_ROLL and E2E_PASSWORD (an admin account)");

const chrome = await launch({ port: 9339, width: 1280, height: 900 });
const violations: string[] = [];
const errors: string[] = [];
const report: Record<string, unknown> = {};
try {
  const page = await chrome.newPage();
  await page.send("Log.enable");
  page.onEvent("Log.entryAdded", (p) => {
    const e = p.entry as { text: string; level: string };
    if (/Content Security Policy|Refused to/i.test(e.text)) violations.push(e.text.slice(0, 300));
  });
  page.onEvent("Runtime.exceptionThrown", (p) => errors.push(JSON.stringify(p).slice(0, 300)));
  // securitypolicyviolation events, from inside every page
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `addEventListener('securitypolicyviolation', (e) =>
      console.error('Refused to load ' + e.blockedURI + ' (' + e.violatedDirective + ') from ' + e.sourceFile + ':' + e.lineNumber + ' on ' + location.pathname));`,
  });
  await page.send("Runtime.enable");
  page.onEvent("Runtime.consoleAPICalled", (p) => {
    const text = ((p.args as { value?: string }[]) ?? []).map((a) => a.value ?? "").join(" ");
    if (/Refused to|Content Security Policy/.test(text)) violations.push(text.slice(0, 300));
  });

  // a login that works proves hydration: the form is React's, not a native POST
  await login(page, base, roll, password);
  report.login = "ok";

  const pages: [string, string][] = [
    ["/", "document.querySelector('.maplibregl-canvas')"],
    ["/search", "document.querySelector('input')"],
    ["/settings", "document.querySelector('main, section')"],
    ["/notifications", "document.querySelector('main, section')"],
    ["/admin", "document.querySelector('table')"],
    ["/admin/health", "document.querySelector('[data-testid=dead-zone-map] .maplibregl-canvas')"],
  ];
  for (const [path, ready] of pages) {
    await page.goto(`${base}${path}`);
    try {
      await page.waitFor(ready, 30_000);
      report[path] = "rendered";
    } catch {
      report[path] = "DID NOT RENDER";
    }
    await new Promise((r) => setTimeout(r, 1500)); // let the map fetch tiles, the SSE connect
  }
} finally {
  await chrome.close();
}
const ok =
  violations.length === 0 &&
  errors.length === 0 &&
  Object.values(report).every((v) => v !== "DID NOT RENDER");
console.log(JSON.stringify({ ok, report, violations, pageErrors: errors }, null, 2));
process.exitCode = ok ? 0 : 1;
