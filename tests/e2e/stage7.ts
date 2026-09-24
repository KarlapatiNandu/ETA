/**
 * Stage 7 in a real browser, against the real stack (BUILD_PLAN Stage 7 "Expect"): a TD admin
 * marks a bus out of commission and back, sends an announcement to one cohort, and publishes an
 * event-day list from a spreadsheet — and at every notifying step the dialog states how many
 * students it will reach.
 *
 *   E2E_ADMIN_PASSWORD=… node --experimental-strip-types tests/e2e/stage7.ts [--bus SIM-07] [--shots <dir>]
 *
 * Needs `pnpm dev`, a claimed admin (E2E_ADMIN_ROLL, default TDADMIN01) and at least one student
 * who favourited `--bus` (so the out-of-commission count is not zero).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { launch, login, type Page } from "./cdp.ts";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "http://localhost:3000" },
    bus: { type: "string", default: "SIM-07" },
    route: { type: "string", default: "SIM R4 Uppal" },
    date: { type: "string", default: "2026-10-02" },
    shots: { type: "string" },
  },
});
const roll = process.env.E2E_ADMIN_ROLL ?? "TDADMIN01";
const password = process.env.E2E_ADMIN_PASSWORD;
if (!password) throw new Error("set E2E_ADMIN_PASSWORD");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const report: Record<string, unknown> = {};

/** Set a React-controlled field the way typing would (a plain .value is invisible to React). */
const typeInto = (page: Page, selector: string, value: string) =>
  page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('no ' + ${JSON.stringify(selector)});
    const proto = Object.getPrototypeOf(el);
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
const click = (page: Page, text: string, within = "document") =>
  page.eval(`(() => {
    const root = ${within};
    const b = [...root.querySelectorAll('button, a')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)}));
    if (!b) throw new Error('no button ' + ${JSON.stringify(text)});
    b.click();
  })()`);
const text = (page: Page, sel: string) =>
  page.eval<string>(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);
const shot = async (page: Page, name: string) => {
  if (values.shots) await page.screenshot(join(values.shots, `${name}.png`));
};
const upload = async (page: Page, csv: string) => {
  const dir = mkdtempSync(join(tmpdir(), "bm-csv-"));
  const file = join(dir, "exam-day.csv");
  writeFileSync(file, csv);
  const { root } = await page.send<{ root: { nodeId: number } }>("DOM.getDocument", {});
  const { nodeId } = await page.send<{ nodeId: number }>("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: "input[type=file]",
  });
  await page.send("DOM.setFileInputFiles", { nodeId, files: [file] });
};
/** the one open dialog: its stated count, then type (T0) and send */
async function confirmDialog(page: Page, typed: boolean) {
  await page.waitFor(`document.querySelector('dialog[open]')`, 15_000);
  const stated = await text(page, "dialog[open] [role=status]");
  if (typed) {
    const n = /notify (\d+)/.exec(stated)?.[1];
    await typeInto(page, "dialog[open] input", n ?? "");
  }
  await click(page, "Send to", "document.querySelector('dialog[open]')");
  await page.waitFor(`!document.querySelector('dialog[open]')`, 15_000);
  return stated;
}

const chrome = await launch({ port: 9337, width: 1280, height: 1000 });
try {
  const page = await chrome.newPage();
  const errors: string[] = [];
  page.onEvent("Runtime.exceptionThrown", (p) => errors.push(JSON.stringify(p).slice(0, 300)));
  await page.send("DOM.enable");
  await login(page, values.base!, roll, password);

  // ── 0. the live fleet dashboard renders the fleet with presence
  await page.goto(`${values.base}/admin`);
  await page.waitFor(`document.querySelectorAll('tr[data-bus]').length > 0`, 60_000);
  report.dashboard = await page.eval(`document.querySelectorAll('tr[data-bus]').length + ' buses'`);
  await shot(page, "1-dashboard");

  // ── 1. fleet: add a bus, pair a phone (QR), then out of commission → back in service
  await page.goto(`${values.base}/admin/fleet`);
  await page.waitFor(`document.querySelector('input[name=bus_number]')`, 60_000);
  const newBus = `E2E-${Date.now() % 10000}`;
  await sleep(1500); // hydration
  await page.eval(`(() => {
    document.querySelector('input[name=bus_number]').value = ${JSON.stringify(newBus)};
    document.querySelector('input[name=bus_number]').form.requestSubmit();
  })()`);
  await page.waitFor(
    `[...document.querySelectorAll('td a')].some(a => a.textContent === 'Bus ${newBus}')`,
  );
  await page.eval(
    `[...document.querySelectorAll('td a')].find(a => a.textContent === 'Bus ${newBus}').click()`,
  );
  await page.waitFor(`document.body.textContent.includes('Pair a phone')`, 30_000);
  await click(page, "Pair a phone");
  await page.waitFor(`document.querySelector('[data-testid=pairing] svg')`);
  report.pairing = "QR shown once";
  await shot(page, "2-pairing");
  await click(page, "Done — hide it");

  await page.goto(`${values.base}/admin/fleet`);
  await page.waitFor(
    `[...document.querySelectorAll('td a')].some(a => a.textContent === 'Bus ${values.bus}')`,
    30_000,
  );
  await page.eval(
    `[...document.querySelectorAll('td a')].find(a => a.textContent === 'Bus ${values.bus}').click()`,
  );
  await page.waitFor(`document.querySelector('input[name=note]')`, 30_000);
  await sleep(1000);
  await typeInto(page, "input[name=note]", "E2E: engine overheating at depot");
  await click(page, "Mark out of commission");
  await sleep(500);
  await shot(page, "3-t0-dialog");
  report.outOfCommissionDialog = await confirmDialog(page, true);
  await page.waitFor(`document.body.textContent.includes('resolve its ticket')`);
  await click(page, "resolve its ticket");
  await page.waitFor(`document.querySelector('[data-testid=ticket-status]')`, 30_000);
  await sleep(1000);
  await typeInto(page, "input[name=note]", "E2E: repaired, running normally");
  await click(page, "Back in service");
  report.backInServiceDialog = await confirmDialog(page, false);
  await page.waitFor(
    `document.querySelector('[data-testid=ticket-status]')?.textContent === 'resolved'`,
  );
  report.ticket = await page.eval(
    `[...document.querySelectorAll('ol li')].map(l => l.textContent.split(' · ').slice(2).join(' · ')).join(' | ')`,
  );
  await shot(page, "4-ticket-timeline");

  // ── 2. an announcement to one cohort, with the live count
  await page.goto(`${values.base}/admin/announcements`);
  await page.waitFor(`document.body.textContent.includes('Who is it for?')`, 60_000);
  await sleep(1000);
  await typeInto(page, "input[maxlength='80']", "E2E: exam-day timings");
  await typeInto(page, "textarea", "Buses leave **30 minutes** early tomorrow.");
  await click(page, "Seniors");
  await page.waitFor(
    `document.querySelector('[data-testid=audience-count]').textContent.startsWith('Reaches')`,
  );
  report.announcementCount = await text(page, "[data-testid=audience-count]");
  await click(page, "Review and send");
  await sleep(300);
  await shot(page, "5-announcement-dialog");
  await confirmDialog(page, false);
  await page.waitFor(`document.body.textContent.includes('Sent to')`);
  report.announcement = "sent";

  // ── 3. event-day CSV: a malformed file is rejected whole; a good one previews, then publishes
  await page.goto(`${values.base}/admin/event-day`);
  await page.waitFor(`document.querySelector('input[type=file]')`, 60_000);
  await sleep(1000);
  await typeInto(page, "input[type=date]", values.date!);
  await upload(
    page,
    `bus,route,time,cohort\n${values.bus},${values.route},7:40 AM,seniors\nNOPE-1,,26:00,freshers\n`,
  );
  await page.waitFor(`document.querySelector('[data-testid=rejected]')`);
  report.rejected = await page.eval(
    `[...document.querySelectorAll('[data-testid=rejected] tbody tr')].map(r => r.textContent).join(' | ')`,
  );
  await shot(page, "6-csv-rejected");
  const good = `bus,route,time,cohort\n${values.bus},${values.route},7:40 AM,seniors\n`;
  await upload(page, good);
  await page.waitFor(`document.querySelector('[data-testid=preview]')`);
  report.preview = await text(page, "[data-testid=preview] p");
  await shot(page, "7-csv-preview");
  await click(page, "Review and publish", "document.querySelector('[data-testid=preview]')").catch(
    () => click(page, "Apply (notifies nobody)", "document.querySelector('[data-testid=preview]')"),
  );
  await page.waitFor(`document.querySelector('dialog[open]')`);
  report.eventDayDialog = await text(page, "dialog[open] [role=status]");
  await click(
    page,
    report.eventDayDialog === "Nobody is in this audience — nothing will be sent."
      ? "Apply without"
      : "Send to",
    "document.querySelector('dialog[open]')",
  );
  await page.waitFor(
    `document.body.textContent.includes('Published') || document.body.textContent.includes('Applied.')`,
  );
  await sleep(500);
  await upload(page, good);
  await page.waitFor(`document.querySelector('[data-testid=preview]')`).catch(async (e) => {
    console.error(await page.eval(`document.querySelector('main, body').innerText.slice(0, 1500)`));
    throw e;
  });
  report.identical = await page.eval(
    `document.querySelector('[data-testid=preview]').textContent.includes('same file') ? 'says it is the same file, notifies nobody' : 'NOT DETECTED'`,
  );

  // ── 4. the audit log shows all of it, by this admin
  await page.goto(`${values.base}/admin/audit`);
  await page.waitFor(`document.querySelectorAll('tbody tr').length > 5`, 60_000);
  report.audit = await page.eval(
    `[...new Set([...document.querySelectorAll('table > tbody > tr > td:nth-child(3)')].map(t => t.textContent))].slice(0, 12).join(', ')`,
  );
  await shot(page, "8-audit");
  report.pageErrors = errors;
  console.log(JSON.stringify(report, null, 2));
} finally {
  chrome.close();
}
