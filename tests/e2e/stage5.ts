/**
 * Stage 5 in a real browser, against the real stack (BUILD_PLAN Stage 5 "Expect"):
 *
 *   node --experimental-strip-types tests/e2e/stage5.ts [--q kothi] [--shots <dir>]
 *
 * Needs `pnpm dev`, a running simulator and a claimed synthetic student. Walks the student path:
 * pin home on the settings map → search a misspelled stop → open it → take a running bus →
 * the home hero shows the bus, an ETA range, when to leave, and the route timeline; and the ETA
 * keeps arriving over the stream.
 */
import { parseArgs } from "node:util";
import { launch, login } from "./cdp.ts";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "http://localhost:3000" },
    q: { type: "string", default: "kothi" },
    shots: { type: "string" },
  },
});
const roll = process.env.E2E_ROLL ?? "160125737900";
const password = process.env.E2E_PASSWORD ?? "browser-test-9";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const chrome = await launch({ port: 9336, width: 430, height: 1100 });
const report: Record<string, unknown> = {};
try {
  const page = await chrome.newPage();
  const errors: string[] = [];
  page.onEvent("Runtime.exceptionThrown", (p) => errors.push(JSON.stringify(p).slice(0, 300)));
  await login(page, values.base!, roll, password);

  // 1. home pin: click the middle of the settings map, save
  await page.goto(`${values.base}/settings`);
  await page.waitFor(`document.querySelector('[data-testid=home-pin] canvas')`, 30_000);
  await sleep(2000);
  const box = await page.eval<{ x: number; y: number }>(`(() => {
    const c = document.querySelector('[data-testid=home-pin] canvas');
    c.scrollIntoView({ block: 'center' });
    const r = c.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await page.send("Input.dispatchMouseEvent", {
      type,
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
    });
  await sleep(500);
  await page.eval(
    `[...document.querySelectorAll('[data-testid=home-pin] button')].find(b => b.textContent === 'Save pin').click()`,
  );
  await page.waitFor(
    `document.querySelector('[data-testid=home-pin] [role=status]')?.textContent.startsWith('Saved')`,
    15_000,
  );
  report.pin = "saved";

  // 2. search a misspelling
  await page.goto(`${values.base}/search`);
  await page.waitFor(`document.querySelector('[data-testid=search-input]')`);
  await sleep(1000);
  await page.eval(`(() => {
    const el = document.querySelector('[data-testid=search-input]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, ${JSON.stringify(values.q)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.waitFor(`document.querySelectorAll('[data-testid=result-name]').length > 0`, 15_000);
  const results = await page.eval<
    { name: string; buses: string[] }[]
  >(`[...document.querySelectorAll('[data-testid=search-results] li')].map(li => ({
    name: li.querySelector('[data-testid=result-name]').textContent,
    buses: [...li.querySelectorAll('[data-testid=bus-line]')].map(b => b.textContent.replace(/\\s+/g, ' ').trim()),
  }))`);
  report.search = { q: values.q, results: results.slice(0, 5) };
  if (values.shots) await page.screenshot(`${values.shots}/stage5-search.png`);

  // 3. open the first result that has a running bus that has not passed it
  const pick = await page.eval<number>(
    `[...document.querySelectorAll('[data-testid=search-results] li')].findIndex(li => li.querySelector('[data-status=running]'))`,
  );
  if (pick < 0) throw new Error("no search result with a running bus: is the simulator running?");
  await page.eval(
    `document.querySelectorAll('[data-testid=search-results] li a')[${pick}].click()`,
  );
  await page.waitFor(`document.querySelector('[data-testid=stop-name]')`, 15_000);
  await page.waitFor(
    `[...document.querySelectorAll('button')].some(b => b.textContent.startsWith('Take Bus'))`,
    15_000,
  );
  report.stop = await page.eval(`({
    name: document.querySelector('[data-testid=stop-name]').textContent,
    walk: document.querySelector('[data-testid=walk]').textContent,
    buses: [...document.querySelectorAll('[data-testid=bus-line]')].map(b => b.textContent.replace(/\\s+/g, ' ').trim()),
  })`);
  if (values.shots) await page.screenshot(`${values.shots}/stage5-stop.png`);

  // 4. take the bus → home hero
  await page.eval(
    `[...document.querySelectorAll('button')].find(b => b.textContent.startsWith('Take Bus')).click()`,
  );
  await page.waitFor(
    `location.pathname === '/' && document.querySelector('[data-testid=hero]')`,
    20_000,
  );
  await page.waitFor(
    `document.querySelector('[data-testid=hero] h1')?.textContent.includes('min')`,
    45_000,
  );
  await sleep(1500);
  report.hero = await page.eval(`({
    title: document.querySelector('[data-testid=hero] h1').textContent,
    leave: document.querySelector('[data-testid=leave-in]')?.textContent ?? null,
    target: document.querySelector('[data-testid=timeline-target]')?.textContent ?? null,
    timelineStops: document.querySelectorAll('[data-testid=hero] ol li').length,
  })`);
  if (values.shots) await page.screenshot(`${values.shots}/stage5-hero.png`);

  // 5. the countdown moves and ETA frames keep arriving
  const first = await page.eval<string>(
    `document.querySelector('[data-testid=hero] h1').textContent`,
  );
  await sleep(20_000);
  report.heroAfter20s = await page.eval<string>(
    `document.querySelector('[data-testid=hero] h1').textContent`,
  );
  report.heroFirst = first;
  report.errors = errors;
  console.log(JSON.stringify(report, null, 2));
} finally {
  chrome.close();
}
