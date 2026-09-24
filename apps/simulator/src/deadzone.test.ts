import { describe, expect, it } from "vitest";
import { clusterOutages, type Outage } from "@busmitra/engine/deadzone";
import { buildRoute, haversine, pointAtOffset, ringContains, type LatLng } from "@busmitra/geo";
import { deadZonesFor, outagesOf, routeZoneSeed } from "./deadzone.ts";
import { simulateTrip } from "./model.ts";

/**
 * BUILD_PLAN Stage 8 exit: "DBSCAN clustering verified against simulator-injected dead zones
 * (deterministic, immediate)". The simulator drives real trips through its zones, the presence
 * rule turns each silence into an outage, and the learner must find every zone that recurred —
 * and nothing else.
 */

// ~14 km through east Hyderabad, four legs
const line: LatLng[] = [
  { lat: 17.3688, lng: 78.5247 },
  { lat: 17.3688, lng: 78.5647 },
  { lat: 17.3948, lng: 78.5647 },
  { lat: 17.3948, lng: 78.5947 },
  { lat: 17.4148, lng: 78.5947 },
];
const route = buildRoute(line);
const stops = [0, 2200, 4600, 7000, 9800, route.total];
const DAY = 86_400_000;
const T0 = Date.parse("2026-10-05T02:00:00.000Z");

/** `n` trips on consecutive days, each outage as the engine's loader would return it */
function drive(zones: [number, number][], n: number, firstSeed: number): Outage[] {
  const out: Outage[] = [];
  for (let k = 0; k < n; k++) {
    const trip = simulateTrip(route, {
      seed: firstSeed + k,
      t0: T0 + k * DAY,
      stops,
      deadZones: zones,
      dupRate: 0.02,
      reorderRate: 0.02,
    });
    outagesOf(trip).forEach((o, i) =>
      out.push({
        id: `t${k}-o${i}`,
        tripId: `t${k}`,
        lineageId: "L",
        lat: o.entry.lat,
        lng: o.entry.lng,
        durationS: Math.round((o.recoveredAt - o.startedAt) / 1000),
        startedAt: new Date(o.startedAt).toISOString(),
        day: new Date(o.startedAt + 5.5 * 3600_000).toISOString().slice(0, 10),
      }),
    );
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}

describe("dead-zone learning against simulator-injected zones", () => {
  it("every silence the simulator injects is inside a zone, and the presence rule sees it", () => {
    const zones: [number, number][] = [[5000, 5700]];
    const trip = simulateTrip(route, { seed: 3, t0: T0, stops, deadZones: zones });
    const o = outagesOf(trip);
    expect(o).toHaveLength(1);
    // the entry is the last fix before the zone: within one cadence of driving of its start
    const start = pointAtOffset(route, 5000);
    expect(haversine(o[0]!.entry, start)).toBeLessThan(120);
    // no zones, no outages
    expect(outagesOf(simulateTrip(route, { seed: 3, t0: T0, stops }))).toEqual([]);
  });

  for (const seed of [1, 2, 3, 4, 5]) {
    it(`finds every injected zone and nothing else (zone seed ${seed})`, () => {
      const zones = deadZonesFor(route, routeZoneSeed("lineage-under-test", seed));
      const outages = drive(zones, 12, seed * 100);
      const clusters = clusterOutages(outages);

      let checked = 0;
      for (const [a, b] of zones) {
        // a zone short enough to cross in under 45 s never turns a bus DARK: not learnable,
        // and correctly so — it never alarmed anyone
        const quiet = outages.filter((o) => {
          const d = haversine(o, pointAtOffset(route, a));
          return d < 200;
        });
        if (quiet.length < 4) continue;
        checked++;
        const at = pointAtOffset(route, Math.max(0, a - 20));
        const hit = clusters.filter((c) => ringContains(c.ring, at));
        expect(hit, `zone ${Math.round(a)}–${Math.round(b)} m`).toHaveLength(1);
        expect(hit[0]!.sampleCount).toBe(quiet.length);
        // "usually clears in about …": the learned duration is the real crossing time
        const lengthM = b - a;
        expect(hit[0]!.avgOutageS).toBeGreaterThan(lengthM / (40 / 3.6) - 10);
        expect(hit[0]!.confidence).toBeGreaterThan(0.9);
      }
      // nothing learned that the simulator did not inject
      for (const c of clusters) {
        const near = zones.some(([a]) =>
          c.points.every((p) => haversine(p, pointAtOffset(route, a)) < 200),
        );
        expect(near).toBe(true);
      }
      expect(checked).toBeGreaterThan(0);
      expect(clusters).toHaveLength(checked);
    });
  }

  it("zones are the route's, not the bus's: every bus goes quiet at the same place", () => {
    const z1 = deadZonesFor(route, routeZoneSeed("lineage-a"));
    expect(deadZonesFor(route, routeZoneSeed("lineage-a"))).toEqual(z1);
    expect(deadZonesFor(route, routeZoneSeed("lineage-b"))).not.toEqual(z1);
  });
});
