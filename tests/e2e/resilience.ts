/**
 * Stage 3 exit harness — resilience, against the real stack and a real browser:
 *
 *   node --experimental-strip-types tests/e2e/resilience.ts network [--offline-s 25]
 *   node --experimental-strip-types tests/e2e/resilience.ts sigkill --gateway-cmd "<how to start it>"
 *
 * Needs `pnpm dev`, a running simulator (so frames keep flowing), and a claimed synthetic
 * student (E2E_ROLL / E2E_PASSWORD).
 *
 *  network   cut the browser's network mid-stream (CDP offline emulation, which also fires the
 *            page's `offline` event). Pass: the connection indicator leaves "live", comes back
 *            without a page reload, the reconnect sends Last-Event-ID, and the frames published
 *            while offline arrive as a replay.
 *  sigkill   SIGKILL the gateway process holding the stream, then start it again. Pass: the page
 *            reconnects on its own, no reload, and the student holds exactly one connection key
 *            afterwards (no phantom locking anyone out).
 */
import { execSync, spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { launch, login, type Page } from "./cdp.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: "string", default: "http://localhost:3000" },
    "offline-s": { type: "string", default: "25" },
    "gateway-cmd": { type: "string" },
    "gateway-port": { type: "string", default: "4000" },
  },
});
const roll = process.env.E2E_ROLL ?? "160125737900";
const password = process.env.E2E_PASSWORD ?? "browser-test-9";
const mode = positionals[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Frame {
  id: string | null;
  type: string;
  t: number;
}

async function open(page: Page) {
  await login(page, values.base!, roll, password);
  await page.goto(`${values.base}/?measure=1`);
  await page.waitFor(
    `document.querySelector('[data-testid=connection]')?.dataset.state === 'live'`,
    30_000,
  );
  // a marker that only survives if the page is never reloaded
  await page.eval(`window.__bmNoReload = ${Date.now()}`);
  const states: string[] = [];
  return {
    states,
    watch: () =>
      setInterval(async () => {
        const s = await page
          .eval<string>(
            `document.querySelector('[data-testid=connection]')?.dataset.state ?? 'none'`,
          )
          .catch(() => "eval-failed");
        if (states.at(-1) !== s) states.push(s);
      }, 250),
  };
}

const chrome = await launch({ port: 9335 });
try {
  const page = await chrome.newPage();
  const requests: { url: string; lastEventId?: string }[] = [];
  await page.send("Network.enable");
  page.onEvent("Network.requestWillBeSent", (p) => {
    const req = p.request as { url: string; headers: Record<string, string> };
    if (req.url.includes("/v1/stream") && !req.url.includes("focus"))
      requests.push({
        url: req.url,
        lastEventId: req.headers["last-event-id"] ?? req.headers["Last-Event-ID"],
      });
  });
  const { states, watch } = await open(page);
  const timer = watch();
  await sleep(5000);
  const before = await page.eval<Frame[]>(`window.__bmFrames`);
  const lastIdBefore = [...before].reverse().find((f) => f.id)?.id ?? null;

  if (mode === "network") {
    const offlineS = Number(values["offline-s"]);
    const cutAt = Date.now();
    await page.send("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await sleep(offlineS * 1000);
    await page.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    const backAt = Date.now();
    await page.waitFor(
      `document.querySelector('[data-testid=connection]')?.dataset.state === 'live'`,
      60_000,
    );
    const liveAgainMs = Date.now() - backAt;
    await sleep(3000);
    const frames = await page.eval<Frame[]>(`window.__bmFrames`);
    const readyAfter = frames.filter((f) => f.type === "stream.ready" && f.t > cutAt);
    const firstReady = readyAfter[0];
    // frames with ids received after the reconnect's stream.ready and before its snapshot = replay
    const replay = firstReady
      ? frames.filter(
          (f) =>
            f.t >= firstReady.t &&
            f.id &&
            f.t <=
              (frames.find((x) => x.type === "fleet.snapshot" && x.t >= firstReady.t)?.t ??
                Infinity),
        )
      : [];
    const resumed = requests.filter((r) => r.lastEventId);
    const report = {
      mode,
      offlineS,
      connectionStates: states,
      reconnectedWithoutReload:
        (await page.eval<number | undefined>(`window.__bmNoReload`)) !== undefined,
      liveAgainAfterMs: liveAgainMs,
      lastEventIdBefore: lastIdBefore,
      resumedWithLastEventId: resumed.map((r) => r.lastEventId),
      replayedFrames: replay.length,
      replayedTypes: [...new Set(replay.map((f) => f.type))],
    };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode =
      report.reconnectedWithoutReload &&
      states.some((s) => s !== "live") &&
      states.at(-1) === "live" &&
      resumed.length > 0 &&
      replay.length > 0
        ? 0
        : 1;
  } else if (mode === "sigkill") {
    const port = values["gateway-port"]!;
    const pids = execSync(`lsof -nP -tiTCP:${port} -sTCP:LISTEN`).toString().trim().split("\n");
    const killedAt = Date.now();
    for (const pid of pids) process.kill(Number(pid), "SIGKILL");
    await sleep(3000);
    if (!values["gateway-cmd"])
      throw new Error("--gateway-cmd is required to start the gateway again");
    const gw = spawn("sh", ["-c", values["gateway-cmd"]], { stdio: "ignore", detached: true });
    gw.unref();
    const restartedAt = Date.now();
    await page.waitFor(
      `document.querySelector('[data-testid=connection]')?.dataset.state === 'live'`,
      90_000,
    );
    const liveAgainMs = Date.now() - restartedAt;
    await sleep(2000);
    const keys = execSync(`docker exec busmitra-redis-1 redis-cli --scan --pattern 'sse:conn:*'`)
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    const report = {
      mode,
      connectionStates: states,
      reconnectedWithoutReload:
        (await page.eval<number | undefined>(`window.__bmNoReload`)) !== undefined,
      downForMs: restartedAt - killedAt,
      liveAgainAfterRestartMs: liveAgainMs,
      connectionKeysNow: keys.length,
    };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode =
      report.reconnectedWithoutReload && states.at(-1) === "live" && keys.length === 1 ? 0 : 1;
  } else {
    console.error("usage: resilience.ts network | sigkill --gateway-cmd <cmd>");
    process.exitCode = 2;
  }
  clearInterval(timer);
} finally {
  chrome.close();
}
