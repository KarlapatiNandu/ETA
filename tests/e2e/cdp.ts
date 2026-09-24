/**
 * A minimal Chrome DevTools Protocol driver (no Playwright in this repo): launch headless
 * Chrome, open a page, evaluate, screenshot. Enough to drive the real UI, which is the only
 * place browser-only faults show up (M01/M02 gotchas: CORS methods, effects mounted before
 * their container, replayed GETs — none of them visible to inject()).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface Page {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  eval<T = unknown>(expr: string): Promise<T>;
  goto(url: string): Promise<void>;
  waitFor(expr: string, ms?: number): Promise<void>;
  screenshot(path: string): Promise<void>;
  onEvent(method: string, fn: (params: Record<string, unknown>) => void): void;
}

export async function launch(opts: { port?: number; width?: number; height?: number } = {}) {
  const port = opts.port ?? 9333;
  const dir = mkdtempSync(join(tmpdir(), "bm-chrome-"));
  const proc: ChildProcess = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dir}`,
      `--window-size=${opts.width ?? 1280},${opts.height ?? 900}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
    { stdio: "ignore" },
  );
  let version: { webSocketDebuggerUrl: string } | null = null;
  for (let i = 0; i < 50 && !version; i++) {
    await new Promise((r) => setTimeout(r, 200));
    version = await fetch(`http://127.0.0.1:${port}/json/version`)
      .then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>)
      .catch(() => null);
  }
  if (!version) throw new Error("chrome did not start");

  async function newPage(): Promise<Page> {
    const target = (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: "PUT",
    }).then((r) => r.json())) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    let seq = 0;
    const pending = new Map<number, [(v: unknown) => void, (e: Error) => void]>();
    const listeners = new Map<string, ((p: Record<string, unknown>) => void)[]>();
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: Record<string, unknown>;
      };
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p?.[1](new Error(msg.error.message));
        else p?.[0](msg.result);
      } else if (msg.method) for (const fn of listeners.get(msg.method) ?? []) fn(msg.params ?? {});
    };
    // every call has a deadline: a navigation or reload can drop a pending evaluate, and a
    // harness that waits forever reports nothing (found the hard way in the Stage 3 run)
    const send = <T>(method: string, params: Record<string, unknown> = {}) =>
      new Promise<T>((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }, 30_000);
        pending.set(id, [
          (v) => (clearTimeout(timer), (resolve as (v: unknown) => void)(v)),
          (e) => (clearTimeout(timer), reject(e)),
        ]);
        ws.send(JSON.stringify({ id, method, params }));
      });
    await send("Page.enable");
    await send("Runtime.enable");
    const page: Page = {
      send,
      onEvent(method, fn) {
        listeners.set(method, [...(listeners.get(method) ?? []), fn]);
      },
      async eval<T>(expression: string) {
        const r = await send<{
          result: { value: T };
          exceptionDetails?: { text: string; exception?: { description?: string } };
        }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails)
          throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      },
      async goto(url) {
        const loaded = new Promise<void>((r) => {
          page.onEvent("Page.loadEventFired", () => r());
          setTimeout(r, 60_000);
        });
        await send("Page.navigate", { url });
        await loaded;
      },
      async waitFor(expr, ms = 15_000) {
        const until = Date.now() + ms;
        while (!(await page.eval<boolean>(`Boolean(${expr})`).catch(() => false))) {
          if (Date.now() > until) throw new Error(`timed out waiting for ${expr}`);
          await new Promise((r) => setTimeout(r, 200));
        }
      },
      async screenshot(path) {
        const { data } = await send<{ data: string }>("Page.captureScreenshot", { format: "png" });
        writeFileSync(path, Buffer.from(data, "base64"));
      },
    };
    return page;
  }

  return {
    newPage,
    close: () => proc.kill("SIGKILL"),
  };
}

/**
 * Sign in through the real login form. Retries: on a cold `next dev` compile the form can be
 * submitted before React has hydrated it, which is a native GET, not a sign-in.
 */
export async function login(page: Page, base: string, roll: string, password: string) {
  for (let attempt = 1; ; attempt++) {
    await page.goto(`${base}/login`);
    await page.waitFor(`document.querySelector('input[name=roll_no]')`, 60_000);
    await new Promise((r) => setTimeout(r, 1500 * attempt));
    await page.eval(`(() => {
      const set = (n, v) => { const el = document.querySelector('input[name=' + n + ']'); el.value = v; };
      set('roll_no', ${JSON.stringify(roll)});
      set('password', ${JSON.stringify(password)});
      document.querySelector('form').requestSubmit();
    })()`);
    try {
      await page.waitFor(`location.pathname === '/'`, 15_000);
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
    }
  }
}
