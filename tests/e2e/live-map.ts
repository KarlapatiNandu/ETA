/**
 * Stage 3 exit harness, against the real stack and a real browser:
 *
 *   node --experimental-strip-types tests/e2e/live-map.ts --seconds 180 [--out report.json]
 *
 * Needs `pnpm dev` and a running simulator (`pnpm sim run --buses 30 --minutes N`), and a
 * claimed synthetic student (E2E_ROLL / E2E_PASSWORD). Reports, from the browser itself:
 *
 *  - ping-to-pixel latency: GPS fix time → the animation frame that first drew it (p50/p95);
 *  - markers on the map and their presence states over time;
 *  - the largest per-frame marker movement, in pixels (a "visible jump" check).
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { launch, login } from "./cdp.ts";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "http://localhost:3000" },
    seconds: { type: "string", default: "120" },
    out: { type: "string" },
    shot: { type: "string" },
  },
});
const roll = process.env.E2E_ROLL ?? "160125737900";
const password = process.env.E2E_PASSWORD ?? "browser-test-9";

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : NaN;
};

const chrome = await launch();
try {
  const page = await chrome.newPage();
  const errors: string[] = [];
  page.onEvent("Runtime.exceptionThrown", (p) => errors.push(JSON.stringify(p).slice(0, 300)));
  await login(page, values.base!, roll, password);
  await page.goto(`${values.base}/?measure=1`);
  await page.waitFor(
    `document.querySelector('[data-testid=connection]')?.dataset.state === 'live'`,
    30_000,
  );
  await page.waitFor(`document.querySelectorAll('.bm-bus').length > 0`, 60_000);

  // per-frame marker movement, measured in the page on every animation frame
  await page.eval(`(() => {
    window.__bmJump = { max: 0, frames: 0, big: 0 };
    const last = new Map();
    const tick = () => {
      for (const el of document.querySelectorAll('.bm-bus')) {
        const r = el.getBoundingClientRect();
        const p = last.get(el);
        if (p) {
          const d = Math.hypot(r.x - p.x, r.y - p.y);
          if (d > window.__bmJump.max) window.__bmJump.max = d;
          if (d > 25) window.__bmJump.big++;
        }
        last.set(el, { x: r.x, y: r.y });
      }
      window.__bmJump.frames++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);

  const samples: {
    t: number;
    markers: number;
    states: Record<string, number>;
    byBus: Record<string, string>;
  }[] = [];
  const until = Date.now() + Number(values.seconds) * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 5000));
    const reloaded = await page.eval<boolean>(`!window.__bmJump`).catch(() => true);
    if (reloaded) throw new Error("the page reloaded during the run: the measurement is void");
    samples.push({
      t: Date.now(),
      ...(await page.eval<{
        markers: number;
        states: Record<string, number>;
        byBus: Record<string, string>;
      }>(`(() => {
        const states = {};
        const byBus = {};
        for (const el of document.querySelectorAll('.bm-bus')) {
          states[el.dataset.state] = (states[el.dataset.state] ?? 0) + 1;
          byBus[el.querySelector('.bm-bus__pill')?.textContent ?? '?'] =
            el.dataset.state + (el.querySelector('.bm-bus__note')?.textContent ? ' · ' + el.querySelector('.bm-bus__note').textContent : '');
        }
        return { markers: document.querySelectorAll('.bm-bus').length, states, byBus };
      })()`)),
    });
  }
  if (values.shot) await page.screenshot(values.shot);
  const latency = await page.eval<number[]>(`(window.__bmLatency ?? []).map((x) => x.ms)`);
  const slow = await page.eval<{ ms: number; bus: string; t: number }[]>(
    `(window.__bmLatency ?? []).filter((x) => x.ms > 10000)`,
  );
  const jump = await page.eval<{ max: number; frames: number; big: number }>(`window.__bmJump`);
  const report = {
    seconds: Number(values.seconds),
    latencyMs: {
      n: latency.length,
      p50: pct(latency, 50),
      p95: pct(latency, 95),
      p99: pct(latency, 99),
      max: Math.max(...latency),
      over10s: latency.filter((x) => x > 10_000).length,
    },
    markers: { max: Math.max(...samples.map((s) => s.markers)), last: samples.at(-1) },
    jump,
    errors,
  };
  console.log(JSON.stringify(report, null, 2));
  if (values.out) writeFileSync(values.out, JSON.stringify({ ...report, slow, samples }, null, 2));
} finally {
  chrome.close();
}
