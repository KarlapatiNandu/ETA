import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALERTS } from "./thresholds.ts";

/**
 * The Grafana alert rules repeat the ALERTS numbers (Grafana cannot import TypeScript). This
 * keeps the copy honest: change a threshold in one place and this fails until the other agrees.
 */
const yaml = readFileSync(
  resolve(import.meta.dirname, "../../../infra/grafana/provisioning/alerting/busmitra.yaml"),
  "utf8",
);
const threshold = (uid: string) => {
  const block = yaml.slice(yaml.indexOf(`uid: ${uid}`));
  const m = /params: \[([0-9.]+)\]/.exec(block);
  return m ? Number(m[1]) : NaN;
};

describe("Grafana alert rules match ALERTS", () => {
  it("uses the same thresholds", () => {
    expect(threshold("busmitra-latency")).toBe(ALERTS.PING_TO_FRAME_P95_S);
    expect(threshold("busmitra-consumer-lag")).toBe(ALERTS.CONSUMER_LAG);
    expect(threshold("busmitra-push-failures")).toBe(ALERTS.PUSH_FAILURE_RATE);
    expect(threshold("busmitra-dead-letters")).toBe(ALERTS.DEAD_LETTERS);
    // the 15 minutes live in the engine's gauge; the rule fires on any such bus
    expect(threshold("busmitra-dark-bus")).toBe(0);
    expect(yaml).toContain(`for: ${ALERTS.SUSTAIN_S / 60}m`);
  });
});
