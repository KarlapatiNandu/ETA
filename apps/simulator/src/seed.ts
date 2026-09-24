import { withContext, type Db } from "@busmitra/db";
import type { Osrm } from "@busmitra/engine/osrm";
import { publishRoute, saveDraft } from "@busmitra/engine/routes";
import { insertDraftRoute, matchTrace } from "@busmitra/engine/survey";
import { buildRoute, type LatLng } from "@busmitra/geo";
import { surveyOf } from "./model.ts";

/**
 * Dev routes on real Hyderabad roads, made by the real Stage 1 pipeline: OSRM routes each
 * corridor through its localities, the simulator "drives" it as a noisy 1 Hz survey, and that
 * survey goes through chunked map-matching exactly as a phone's would. Stops sit at the
 * localities (snapped to the road network by OSRM).
 *
 * These are marked source = 'osrm_derived' — synthetic dev data, never to be mistaken for a
 * surveyed route. Locality coordinates are approximate by design (OSRM snaps them); they are
 * development fixtures, not the Transport Department's timetable.
 */

const CBIT: [string, number, number] = ["CBIT Campus", 17.3918, 78.319];

export const CORRIDORS: { name: string; via: [string, number, number][] }[] = [
  {
    name: "SIM R1 Dilsukhnagar",
    via: [
      ["Dilsukhnagar", 17.3688, 78.5247],
      ["Malakpet", 17.373, 78.5],
      ["Mehdipatnam", 17.395, 78.44],
      ["Tolichowki", 17.4, 78.415],
      ["Narsingi", 17.388, 78.356],
      CBIT,
    ],
  },
  {
    name: "SIM R2 LB Nagar",
    via: [
      ["LB Nagar", 17.3457, 78.5522],
      ["Chaitanyapuri", 17.368, 78.536],
      ["Koti", 17.385, 78.486],
      ["Lakdikapul", 17.404, 78.465],
      ["Manikonda", 17.405, 78.386],
      CBIT,
    ],
  },
  {
    name: "SIM R3 Secunderabad",
    via: [
      ["Secunderabad", 17.4399, 78.4983],
      ["Begumpet", 17.444, 78.466],
      ["Ameerpet", 17.4375, 78.4483],
      ["Jubilee Hills", 17.43, 78.41],
      ["Gachibowli", 17.4401, 78.3489],
      CBIT,
    ],
  },
  {
    name: "SIM R4 Uppal",
    via: [
      ["Uppal", 17.405, 78.559],
      ["Habsiguda", 17.418, 78.543],
      ["Tarnaka", 17.428, 78.539],
      ["Punjagutta", 17.426, 78.451],
      ["Financial District", 17.413, 78.34],
      CBIT,
    ],
  },
  {
    name: "SIM R5 Kukatpally",
    via: [
      ["Kukatpally", 17.4948, 78.3996],
      ["Kondapur", 17.47, 78.357],
      ["Gachibowli", 17.4401, 78.3489],
      ["Nanakramguda", 17.419, 78.339],
      CBIT,
    ],
  },
  {
    name: "SIM R6 Miyapur",
    via: [
      ["Miyapur", 17.496, 78.357],
      ["Lingampally", 17.493, 78.317],
      ["Kokapet", 17.395, 78.338],
      CBIT,
    ],
  },
  {
    name: "SIM R7 Aramghar",
    via: [
      ["Aramghar", 17.328, 78.43],
      ["Attapur", 17.37, 78.43],
      ["Langar Houz", 17.378, 78.42],
      ["Narsingi", 17.388, 78.356],
      CBIT,
    ],
  },
  {
    name: "SIM R8 ECIL",
    via: [
      ["ECIL", 17.47, 78.57],
      ["Tarnaka", 17.428, 78.539],
      ["Secunderabad", 17.4399, 78.4983],
      ["Madhapur", 17.448, 78.39],
      CBIT,
    ],
  },
];

export interface SeedResult {
  name: string;
  routeId: string | null;
  skipped?: string;
  report?: Awaited<ReturnType<typeof matchTrace>>["report"];
  stops?: number;
}

export async function seedRoutes(
  db: Db,
  osrm: Osrm,
  log: (msg: string) => void = console.log,
): Promise<SeedResult[]> {
  const out: SeedResult[] = [];
  const ctx = { actorId: null, ip: null, userAgent: "simulator-seed" };
  for (const [i, c] of CORRIDORS.entries()) {
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM routes WHERE name = $1 AND published_at IS NOT NULL AND archived_at IS NULL`,
      [c.name],
    );
    if (existing.rows[0]) {
      out.push({ name: c.name, routeId: existing.rows[0].id, skipped: "already published" });
      continue;
    }
    const truth = await osrm.route(c.via.map(([, lat, lng]) => ({ lat, lng })));
    const survey = surveyOf(buildRoute(truth.line), {
      seed: 1000 + i,
      t0: Date.UTC(2026, 8, 1, 1),
    });
    const { line, report } = await matchTrace(osrm, survey);
    const stopsAt: LatLng[] = truth.waypoints;
    const routeId = await withContext(db, ctx, async (q) => {
      const draft = await insertDraftRoute(q, {
        name: c.name,
        direction: "inbound",
        line,
        source: "osrm_derived",
      });
      // corridors share localities (Gachibowli, Tarnaka, the campus): reuse a stop of the same
      // name within 300 m rather than creating a twin
      const stops = [];
      for (const [k, [name]] of c.via.entries()) {
        const at = stopsAt[k]!;
        const same = await q.query<{ id: string }>(
          `SELECT id FROM stops WHERE name = $1
              AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, 300)`,
          [name, at.lng, at.lat],
        );
        stops.push(
          same.rows[0]
            ? { stop_id: same.rows[0].id }
            : { new_stop: { name, aliases: [], area_name: name, lat: at.lat, lng: at.lng } },
        );
      }
      await saveDraft(q, draft.id, { stops });
      await publishRoute(q, draft.id, { confirmRepeatedStops: false });
      return draft.id;
    });
    log(
      `seeded ${c.name}: ${(report.lengthM / 1000).toFixed(1)} km, ${report.chunks} OSRM chunks, ${report.matchedPct}% matched`,
    );
    out.push({ name: c.name, routeId, report, stops: c.via.length });
  }
  return out;
}
