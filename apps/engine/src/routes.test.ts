import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@busmitra/db/testing";
import {
  buildCumulativeDistances,
  buildRoute,
  haversine,
  pointAtOffset,
  type LatLng,
} from "@busmitra/geo";
import {
  deleteDraft,
  getRouteDetail,
  listRoutes,
  loadRoute,
  newVersion,
  publishRoute,
  saveDraft,
} from "./routes.ts";
import { insertDraftRoute } from "./workers/survey.ts";

// a 3 km loop: east along one road, back west along a parallel one 60 m north
const loop: LatLng[] = [
  { lat: 17.39, lng: 78.32 },
  { lat: 17.39, lng: 78.3483 },
  { lat: 17.39054, lng: 78.3483 },
  { lat: 17.39054, lng: 78.32 },
];
const route = buildRoute(loop);
const at = (s: number) => pointAtOffset(route, s);
const gate = { lat: 17.39027, lng: 78.334 }; // between the carriageways, halfway along

let db: TestDb;
let draftId: string;

beforeAll(async () => {
  db = await createTestDb();
  draftId = (
    await insertDraftRoute(db, {
      name: "Campus loop",
      direction: "inbound",
      line: loop,
      source: "manual_draw",
    })
  ).id;
});
afterAll(() => db.close());

describe("saveDraft", () => {
  it("creates stops and computes D_k by projection — a repeated stop lands on its second pass", async () => {
    const { warnings } = await saveDraft(db, draftId, {
      stops: [
        { new_stop: { name: "CBIT Gate", aliases: ["Gate 1"], ...gate } },
        { new_stop: { name: "Far End", aliases: [], ...at(3000) } },
        { new_stop: { name: "CBIT Gate (return)", aliases: [], ...gate } },
      ],
    });
    expect(warnings).toEqual([]);
    const d = (await getRouteDetail(db, draftId))!;
    expect(d.stops.map((s) => s.name)).toEqual(["CBIT Gate", "Far End", "CBIT Gate (return)"]);
    const out = haversine(loop[0]!, { lat: loop[0]!.lat, lng: gate.lng });
    const back = route.cum[3]! - haversine(loop[3]!, { lat: loop[3]!.lat, lng: gate.lng });
    expect(d.stops[0]!.offset_m).toBeCloseTo(out, 0);
    expect(d.stops[2]!.offset_m).toBeCloseTo(back, 0);
    expect(d.stop_count).toBe(3);
    expect(d.coords).toHaveLength(4);
  });

  it("reuses an existing stop by id, and uses the click offset to pick the pass", async () => {
    const gateId = (await getRouteDetail(db, draftId))!.stops[0]!.stop_id;
    await saveDraft(db, draftId, {
      stops: [
        { stop_id: gateId, near_offset_m: 1400 },
        { new_stop: { name: "Far End 2", aliases: [], ...at(3000) } },
        { stop_id: gateId, near_offset_m: 4500 },
      ],
    });
    const d = (await getRouteDetail(db, draftId))!;
    expect(d.stops[0]!.stop_id).toBe(d.stops[2]!.stop_id);
    expect(d.stops[2]!.offset_m).toBeGreaterThan(4000);
  });

  it("refuses stops that cannot be in route order", async () => {
    await expect(
      saveDraft(db, draftId, {
        stops: [
          { new_stop: { name: "A", aliases: [], ...at(2800) } },
          { new_stop: { name: "B", aliases: [], ...at(200) }, near_offset_m: 200 },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: "stops_out_of_order" });
  });

  it("warns (but saves) a stop placed far from the line", async () => {
    const { warnings } = await saveDraft(db, draftId, {
      stops: [
        { new_stop: { name: "Near", aliases: [], ...at(100) } },
        { new_stop: { name: "Off in a field", aliases: [], lat: 17.3935, lng: 78.33 } },
      ],
    });
    expect(warnings).toEqual([{ seq: 2, kind: "far_from_route", distance_m: expect.any(Number) }]);
  });

  it("replaces the geometry and recomputes D[]", async () => {
    const straight = [loop[0]!, loop[1]!];
    await saveDraft(db, draftId, {
      coords: straight.map((p) => [p.lng, p.lat] as [number, number]),
      stops: [
        { new_stop: { name: "West", aliases: [], ...loop[0]! } },
        { new_stop: { name: "East", aliases: [], ...loop[1]! } },
      ],
    });
    const loaded = (await loadRoute(db, draftId))!;
    expect(loaded.route.coords).toHaveLength(2);
    expect(loaded.route.total).toBeCloseTo(buildCumulativeDistances(straight)[1]!, 3);
    expect(loaded.stops.map((s) => s.seq)).toEqual([1, 2]);
  });
});

describe("publish lifecycle (ADR-0003)", () => {
  let lineageV1: string;

  it("needs two stops", async () => {
    const lone = await insertDraftRoute(db, {
      name: "Lonely",
      direction: "outbound",
      line: loop,
      source: "manual_draw",
    });
    await saveDraft(db, lone.id, {
      stops: [{ new_stop: { name: "Only", aliases: [], ...at(10) } }],
    });
    await expect(publishRoute(db, lone.id, { confirmRepeatedStops: false })).rejects.toMatchObject({
      statusCode: 422,
    });
    await deleteDraft(db, lone.id);
    expect(await getRouteDetail(db, lone.id)).toBeNull();
  });

  it("a repeated stop needs the admin's confirmation, then publishes", async () => {
    const r = await insertDraftRoute(db, {
      name: "Loop 2",
      direction: "inbound",
      line: loop,
      source: "manual_draw",
    });
    await saveDraft(db, r.id, {
      stops: [
        { new_stop: { name: "Main Gate", aliases: [], ...gate } },
        { new_stop: { name: "Hostel", aliases: [], ...at(3000) } },
      ],
    });
    const gateId = (await getRouteDetail(db, r.id))!.stops[0]!.stop_id;
    await saveDraft(db, r.id, {
      stops: [
        { stop_id: gateId },
        { new_stop: { name: "Hostel B", aliases: [], ...at(3000) } },
        { stop_id: gateId },
      ],
    });
    await expect(publishRoute(db, r.id, { confirmRepeatedStops: false })).rejects.toMatchObject({
      statusCode: 409,
      code: "repeated_stops",
      stops: ["Main Gate"],
    });
    const pub = await publishRoute(db, r.id, { confirmRepeatedStops: true });
    expect(pub.published_at).not.toBeNull();
    lineageV1 = r.id;
  });

  it("a published route is frozen for the editor", async () => {
    await expect(saveDraft(db, lineageV1, { stops: [] })).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(deleteDraft(db, lineageV1)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("editing makes version 2 on the same lineage with the stops copied; publishing it retires v1", async () => {
    const v2 = await newVersion(db, lineageV1);
    expect(v2.version).toBe(2);
    // asking again returns the same open draft rather than a v3
    expect((await newVersion(db, lineageV1)).id).toBe(v2.id);
    const d2 = (await getRouteDetail(db, v2.id))!;
    const d1 = (await getRouteDetail(db, lineageV1))!;
    expect(d2.lineage_id).toBe(d1.lineage_id);
    expect(d2.stops.map((s) => s.offset_m)).toEqual(d1.stops.map((s) => s.offset_m));
    await publishRoute(db, v2.id, { confirmRepeatedStops: true });
    const all = (await listRoutes(db)).filter((r) => r.lineage_id === d1.lineage_id);
    expect(all.map((r) => [r.version, !!r.published_at, !!r.archived_at])).toEqual([
      [2, true, false],
      [1, true, true],
    ]);
  });

  it("unknown ids are 404s", async () => {
    const nobody = "00000000-0000-4000-8000-000000000000";
    await expect(newVersion(db, nobody)).rejects.toMatchObject({ statusCode: 404 });
    await expect(saveDraft(db, nobody, { stops: [] })).rejects.toMatchObject({ statusCode: 404 });
    expect(await loadRoute(db, nobody)).toBeNull();
  });
});
