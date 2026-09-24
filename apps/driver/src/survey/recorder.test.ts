import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { SignedClient } from "../lib/api.ts";
import { openDb } from "../lib/idb.ts";
import { SurveyRecorder } from "./recorder.ts";

const T0 = 1_758_506_400_000;
const fix = (ms: number, accuracy = 5) => ({
  timestamp: T0 + ms,
  lat: 17.4,
  lng: 78.5 + ms * 1e-8,
  accuracy,
  speed: 8,
  heading: 90,
});

function client(status: number) {
  const bodies: unknown[] = [];
  const c: SignedClient = {
    async request<T>(_m: string, _p: string, body?: unknown) {
      bodies.push(body);
      return { status, json: { survey_id: "s1", point_count: 12, message: "nope" } as T };
    },
    probe: async () => true,
  };
  return { c, bodies };
}

describe("SurveyRecorder", () => {
  it("keeps accurate fixes at ~1 Hz and survives a reload", async () => {
    const db = await openDb(indexedDB, "survey-a");
    const r = new SurveyRecorder(db);
    await r.start("Route 14 inbound", T0);
    expect(await r.add(fix(0))).toBe(true);
    expect(await r.add(fix(400))).toBe(false); // too soon
    expect(await r.add(fix(1000, 80))).toBe(false); // too inaccurate
    expect(await r.add(fix(1000))).toBe(true);
    const again = new SurveyRecorder(db);
    expect(await again.count()).toBe(2);
    expect((await again.session())!.label).toBe("Route 14 inbound");
  });

  it("uploads, and clears the local copy only once the server has it", async () => {
    const db = await openDb(indexedDB, "survey-b");
    const r = new SurveyRecorder(db);
    await r.start("x", T0);
    for (let i = 0; i < 12; i++) await r.add(fix(i * 1000));
    const failing = client(503);
    await expect(r.upload(failing.c)).rejects.toThrow(/nope/);
    expect(await r.count()).toBe(12);
    const ok = client(201);
    expect((await r.upload(ok.c)).point_count).toBe(12);
    expect((ok.bodies[0] as { points: unknown[] }).points).toHaveLength(12);
    expect(await r.count()).toBe(0);
    expect(await r.session()).toBeUndefined();
  });

  it("refuses to upload a survey that is too short", async () => {
    const db = await openDb(indexedDB, "survey-c");
    const r = new SurveyRecorder(db);
    await r.start("", T0);
    await r.add(fix(0));
    await expect(r.upload(client(201).c)).rejects.toThrow(/Only 1 points/);
  });
});
