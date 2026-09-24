/**
 * Stage 6 in a real browser, against the real stack and a real push service (BUILD_PLAN Stage 6):
 *
 *   E2E_PASSWORD=… E2E_ADMIN_TOKEN=… node --experimental-strip-types tests/e2e/stage6.ts [--n 20] [--shots <dir>]
 *
 * A student turns alerts on in headless Chrome (a genuine PushSubscription with Google's push
 * service, VAPID-signed by the engine). An admin then sends announcements to that one student
 * through the gateway, and the harness times each one from the admin's request to the moment
 * the page's service worker receives the push: event → push delivered to the browser. That is
 * the pipeline part of "event → phone buzzes"; a phone's radio and OS add their own share, which
 * only a physical phone can measure.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { launch, login, type Page } from "./cdp.ts";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "http://localhost:3000" },
    gateway: { type: "string", default: "http://localhost:4000" },
    n: { type: "string", default: "20" },
    shots: { type: "string" },
  },
});
const roll = process.env.E2E_ROLL ?? "160125737900";
const password = process.env.E2E_PASSWORD;
const adminToken = process.env.E2E_ADMIN_TOKEN;
if (!password || !adminToken) throw new Error("set E2E_PASSWORD and E2E_ADMIN_TOKEN");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const report: Record<string, unknown> = {};
const shot = async (page: Page, name: string) => {
  if (values.shots) await page.screenshot(join(values.shots, `${name}.png`));
};

async function announce(tier: number, title: string) {
  const body = {
    tier,
    title,
    body_md: "Harness message — safe to ignore.",
    audience: "custom",
    roll_nos: [roll],
    confirm_count: 1,
    ...(tier === 0 ? { confirm_text: "1" } : {}),
  };
  const res = await fetch(`${values.gateway}/v1/admin/announcements`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`announce: ${res.status} ${await res.text()}`);
}

const chrome = await launch({ port: 9338, width: 430, height: 1000 });
try {
  const page = await chrome.newPage();
  const errors: string[] = [];
  page.onEvent("Runtime.exceptionThrown", (p) => errors.push(JSON.stringify(p).slice(0, 300)));
  await page
    .send("Browser.grantPermissions", {
      origin: values.base,
      permissions: ["notifications"],
    })
    .catch((e) => (report.grant = String(e)));
  await login(page, values.base!, roll, password);

  // 1. turn alerts on in settings — a real PushManager.subscribe with the gateway's VAPID key
  await page.goto(`${values.base}/settings`);
  await page.waitFor(
    `document.querySelector('[data-testid=alert-settings] [data-testid=push-setup]')`,
    60_000,
  );
  const before = await page.eval<string>(
    `document.querySelector('[data-testid=alert-settings] [data-testid=push-setup]').dataset.state`,
  );
  report.pushStateBefore = before;
  if (before === "off") {
    await page.eval(
      `[...document.querySelectorAll('[data-testid=alert-settings] button')].find(b => b.textContent.includes('Turn on alerts')).click()`,
    );
  }
  await page.waitFor(
    `document.querySelector('[data-testid=alert-settings] [data-testid=push-setup]')?.dataset.state === 'on'`,
    30_000,
  );
  report.pushState = "on";
  await shot(page, "1-settings-alerts-on");

  // 2. event → push received in the service worker, n times
  await page.goto(`${values.base}/notifications`);
  await page.waitFor(`document.querySelector('[data-testid=centre]')`, 60_000);
  await sleep(2000);
  const n = Number(values.n);
  const lat: number[] = [];
  for (let i = 0; i < n; i++) {
    const seen = await page.eval<number>(`(window.__bmPushes ?? []).length`);
    const t0 = Date.now();
    await announce(2, `Harness ${i + 1}/${n}`);
    await page.waitFor(`(window.__bmPushes ?? []).length > ${seen}`, 30_000);
    const received = await page.eval<number>(`window.__bmPushes.at(-1).received`);
    lat.push(received - t0);
    await sleep(300);
  }
  report.eventToPushMsInOrder = [...lat];
  lat.sort((a, b) => a - b);
  const pct = (p: number) => lat[Math.min(lat.length - 1, Math.ceil((p / 100) * lat.length) - 1)]!;
  report.eventToPushMs = {
    n: lat.length,
    p50: pct(50),
    p95: pct(95),
    max: lat.at(-1),
    min: lat[0],
  };

  // 3. a critical one: the in-app banner demands an acknowledgement; the center records it
  await announce(0, "Harness critical");
  await page.waitFor(
    `document.querySelector('[data-testid=arrival]')?.textContent.includes('Harness critical')`,
    30_000,
  );
  await shot(page, "2-critical-banner");
  await page.eval(
    `[...document.querySelectorAll('[data-testid=arrival] button')].find(b => b.textContent === 'I understand').click()`,
  );
  await page.waitFor(`!document.querySelector('[data-testid=arrival]')`, 10_000);
  await page.goto(`${values.base}/notifications`);
  await page.waitFor(
    `document.querySelectorAll('[data-testid=centre] li').length >= ${Math.min(n, 30)}`,
    30_000,
  );
  report.centre = await page.eval(
    `[...document.querySelectorAll('[data-testid=centre] li')].slice(0, 3).map(li => li.querySelector('.font-semibold').textContent)`,
  );
  report.criticalStillNeedsAck = await page.eval(
    `[...document.querySelectorAll('[data-testid=centre] li[data-tier="0"]')].some(li => li.textContent.includes('I understand'))`,
  );
  await shot(page, "3-centre");

  // 4. the kill switch on the home page
  await page.goto(`${values.base}/`);
  await page.waitFor(`document.querySelector('[data-testid=pause]')`, 60_000);
  await page.eval(`document.querySelector('[data-testid=pause]').click()`);
  await page.waitFor(`document.querySelector('[data-testid=paused]')`, 10_000);
  report.pause = await page.eval(`document.querySelector('[data-testid=paused] span').textContent`);
  await shot(page, "4-paused");
  await page.eval(`document.querySelector('[data-testid=paused] button').click()`);
  await page.waitFor(`document.querySelector('[data-testid=pause]')`, 10_000);

  report.pageErrors = errors;
  console.log(JSON.stringify(report, null, 2));
} finally {
  chrome.close();
}
