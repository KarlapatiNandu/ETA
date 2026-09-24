/**
 * Run `fn` every `everyMs` until aborted — the loop shape every periodic engine job shares
 * (presence and leave-now keep their own, older copies). A failed pass is logged, never fatal:
 * the next pass is the retry.
 */
export async function runEvery(
  name: string,
  everyMs: number,
  fn: () => Promise<unknown>,
  opts: { signal: AbortSignal; log?: (msg: string, extra?: Record<string, unknown>) => void },
): Promise<void> {
  while (!opts.signal.aborted) {
    const started = Date.now();
    try {
      await fn();
    } catch (err) {
      if (opts.signal.aborted) break;
      opts.log?.(`${name}: pass failed`, { error: (err as Error).message });
    }
    const wait = Math.max(0, everyMs - (Date.now() - started));
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, wait);
      opts.signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });
  }
}
