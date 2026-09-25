import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * A gateway + engine pair the harness owns (Stage 8 load run and chaos drills): started with the
 * repo's .env plus overrides, logged to tests/load/.run/<name>.log, and killable one at a time —
 * which is the point of a chaos drill. `pnpm dev` must be stopped first: two engines would split
 * every consumer group between them.
 */

export const ROOT = resolve(import.meta.dirname, "../../../..");
export const RUN_DIR = join(ROOT, "tests/load/.run");
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A throwaway CA and a certificate for 127.0.0.1 — `web-push` only speaks HTTPS. */
export function makeCerts(dir = RUN_DIR) {
  mkdirSync(dir, { recursive: true });
  const o = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  const rsa = ["-newkey", "rsa:2048", "-nodes"];
  o([
    "req",
    "-x509",
    ...rsa,
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "2",
    "-subj",
    "/CN=busmitra-load-ca",
  ]);
  o(["req", ...rsa, "-keyout", "sink.key", "-out", "sink.csr", "-subj", "/CN=127.0.0.1"]);
  writeFileSync(join(dir, "ext.cnf"), "subjectAltName=IP:127.0.0.1,DNS:localhost\n");
  const sign = ["-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2"];
  o(["x509", "-req", "-in", "sink.csr", ...sign, "-out", "sink.pem", "-extfile", "ext.cnf"]);
  return { ca: join(dir, "ca.pem"), key: join(dir, "sink.key"), cert: join(dir, "sink.pem") };
}

export async function waitFor(what: string, test: () => Promise<boolean>, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await test().catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`${what} did not happen within ${ms / 1000} s`);
}

export class Stack {
  readonly gateway: string;
  private readonly procs = new Map<string, ChildProcess>();
  private readonly env: NodeJS.ProcessEnv;
  private logN = 0;

  constructor(opts: { gatewayPort: number; env?: NodeJS.ProcessEnv }) {
    this.gateway = `http://127.0.0.1:${opts.gatewayPort}`;
    this.env = { ...process.env, ...opts.env };
    mkdirSync(RUN_DIR, { recursive: true });
  }

  static async assertFree(gateway: string) {
    if (
      await fetch(`${gateway}/healthz`).then(
        (r) => r.ok,
        () => false,
      )
    ) {
      throw new Error(`something already serves ${gateway} — stop \`pnpm dev\` first`);
    }
  }

  private spawn(name: "gateway" | "engine", env: NodeJS.ProcessEnv): string {
    const log = join(RUN_DIR, `${name}-${++this.logN}.log`);
    const out = createWriteStream(log);
    const p = spawn(
      process.execPath,
      ["--env-file-if-exists=../../.env", name === "gateway" ? "src/server.ts" : "src/main.ts"],
      {
        cwd: join(ROOT, "apps", name),
        env: { ...this.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    p.stdout!.pipe(out);
    p.stderr!.pipe(out);
    this.procs.set(name, p);
    return log;
  }

  async startGateway(env: NodeJS.ProcessEnv = {}) {
    this.spawn("gateway", env);
    await waitFor("gateway up", async () => (await fetch(`${this.gateway}/healthz`)).ok);
  }

  async startEngine(env: NodeJS.ProcessEnv = {}) {
    const log = this.spawn("engine", env);
    await waitFor("engine up", async () => readFileSync(log, "utf8").includes("engine: started"));
  }

  /** SIGKILL is the drill; SIGTERM is a deploy. Resolves once the process has gone. */
  async kill(name: "gateway" | "engine", signal: NodeJS.Signals = "SIGKILL") {
    const p = this.procs.get(name);
    if (!p || p.exitCode !== null || p.signalCode) return;
    const gone = new Promise<void>((ok) => p.once("exit", () => ok()));
    p.kill(signal);
    await gone;
  }

  async stop() {
    await Promise.all([this.kill("engine", "SIGTERM"), this.kill("gateway", "SIGTERM")]);
  }
}
