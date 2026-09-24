import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedStudent, seedTracker } from "@busmitra/db/testing";
import type { Osrm } from "@busmitra/engine/osrm";
import { createTestGateway, TRACKER_KEY } from "../../../testing.ts";

/** The admin route editor's API, end to end: survey → matched draft → stops → publish. */

// a stand-in OSRM that returns the trace itself as the matched road
const echoOsrm: Osrm = {
  async match(points) {
    return {
      matchings: [points.map(({ lat, lng }) => ({ lat, lng }))],
      tracepoints: points.map(({ lat, lng }) => ({ lat, lng })),
    };
  },
  async route() {
    throw new Error("unused");
  },
};

describe("/v1/admin/routes", () => {
  let gw: Awaited<ReturnType<typeof createTestGateway>>;
  let admin: string;
  let student: string;
  let surveyId: string;

  beforeAll(async () => {
    gw = await createTestGateway({ osrm: echoOsrm });
    admin = await gw.tokenFor(
      (await seedStudent(gw.db, { rollNo: "TDADMIN01", role: "td_admin", phone: "+919999900099" }))
        .userId!,
    );
    student = await gw.tokenFor((await seedStudent(gw.db, { rollNo: "160125737001" })).userId!);
    const { trackerId, busId } = await seedTracker(gw.db, {
      busNumber: "3",
      deviceUid: "phone-3",
      secret: "s",
      key: TRACKER_KEY,
    });
    // out along one carriageway and back along the other, 60 m apart: a campus loop
    const points = Array.from({ length: 300 }, (_, i) => ({
      t: new Date(Date.UTC(2026, 8, 22, 2, 0, 0) + i * 1000).toISOString(),
      lat: i < 150 ? 17.39 : 17.39054,
      lng: 78.32 + (i < 150 ? i : 299 - i) * 0.0001,
      accuracy_m: 5,
    }));
    gw.surveyFiles.files.set("surveys/x.json", JSON.stringify({ points }));
    const { rows } = await gw.db.query<{ id: string }>(
      `INSERT INTO route_surveys (tracker_id, bus_id, started_at, ended_at, point_count, file_path)
       VALUES ($1, $2, now(), now(), 300, 'surveys/x.json') RETURNING id`,
      [trackerId, busId],
    );
    surveyId = rows[0]!.id;
  });
  afterAll(async () => {
    await gw.app.close();
    await gw.db.close();
  });

  const as =
    (token: string) =>
    (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
      gw.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        payload: payload as object,
      });

  it("is a 404 — not a 403 — for students and anonymous callers", async () => {
    expect((await as(student)("GET", "/v1/admin/routes")).statusCode).toBe(404);
    expect((await gw.app.inject({ method: "GET", url: "/v1/admin/surveys" })).statusCode).toBe(404);
  });

  let routeId: string;

  it("lists surveys and matches one into a draft route", async () => {
    const list = await as(admin)("GET", "/v1/admin/surveys");
    expect(list.json()[0]).toMatchObject({ id: surveyId, status: "uploaded", bus_number: "3" });
    const m = await as(admin)("POST", `/v1/admin/surveys/${surveyId}/match`, {
      name: "Route 3",
      direction: "inbound",
    });
    expect(m.statusCode).toBe(200);
    expect(m.json().report.lengthM).toBeGreaterThan(3000);
    routeId = m.json().route_id;
    const d = (await as(admin)("GET", `/v1/admin/routes/${routeId}`)).json();
    expect(d).toMatchObject({
      name: "Route 3",
      version: 1,
      published_at: null,
      source: "gps_survey",
    });
  });

  it("saves stops, then publishing a repeated stop needs confirmation (with the stop named)", async () => {
    const save = await as(admin)("PUT", `/v1/admin/routes/${routeId}`, {
      stops: [
        { new_stop: { name: "Gandipet", lat: 17.39027, lng: 78.3201 } },
        { new_stop: { name: "Kokapet", lat: 17.39, lng: 78.33 } },
      ],
    });
    expect(save.statusCode).toBe(200);
    expect(save.json().route.stops).toHaveLength(2);
    const gandipet = save.json().route.stops[0].stop_id;
    await as(admin)("PUT", `/v1/admin/routes/${routeId}`, {
      stops: [
        { stop_id: gandipet },
        { new_stop: { name: "Kokapet", lat: 17.39, lng: 78.33 } },
        { stop_id: gandipet, near_offset_m: 3100 },
      ],
    });
    expect((await as(admin)("GET", `/v1/admin/routes/${routeId}`)).json().stops).toHaveLength(3);
    const refused = await as(admin)("POST", `/v1/admin/routes/${routeId}/publish`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "repeated_stops", stops: ["Gandipet"] });
    const ok = await as(admin)("POST", `/v1/admin/routes/${routeId}/publish`, {
      confirm_repeated_stops: true,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().published_at).not.toBeNull();
  });

  it("a published route cannot be edited; a new version can", async () => {
    const edit = await as(admin)("PUT", `/v1/admin/routes/${routeId}`, { stops: [] });
    expect(edit.statusCode).toBe(409);
    const v2 = await as(admin)("POST", `/v1/admin/routes/${routeId}/versions`);
    expect(v2.json().version).toBe(2);
    const del = await as(admin)("DELETE", `/v1/admin/routes/${v2.json().id}`);
    expect(del.statusCode).toBe(200);
  });

  it("out-of-order stops are a 422 with a machine-readable code", async () => {
    const v = (await as(admin)("POST", `/v1/admin/routes/${routeId}/versions`)).json();
    const res = await as(admin)("PUT", `/v1/admin/routes/${v.id}`, {
      stops: [
        { new_stop: { name: "Late", lat: 17.39054, lng: 78.321 }, near_offset_m: 3100 },
        { new_stop: { name: "Early", lat: 17.39, lng: 78.321 }, near_offset_m: 10 },
      ],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("stops_out_of_order");
  });

  it("finds stops by name and near a point", async () => {
    const byName = (await as(admin)("GET", "/v1/admin/stops?q=gandi")).json();
    expect(byName[0].name).toBe("Gandipet");
    const near = (await as(admin)("GET", "/v1/admin/stops?lat=17.39&lng=78.3299")).json();
    expect(near[0].name).toBe("Kokapet");
  });

  it("every mutation is in the audit log with the admin as actor", async () => {
    const { rows } = await gw.db.query<{ entity: string }>(
      `SELECT DISTINCT entity FROM audit_log WHERE actor_id IS NOT NULL AND entity IN ('routes','stops','route_stops','route_surveys')`,
    );
    expect(rows.map((r) => r.entity).sort()).toEqual([
      "route_stops",
      "route_surveys",
      "routes",
      "stops",
    ]);
  });

  it("allows the browser to PUT and DELETE (the editor's save and discard)", async () => {
    // a CORS preflight is invisible to inject()-based tests unless it is asked for directly:
    // with the default methods list the editor fails in the browser and nowhere else
    const res = await gw.app.inject({
      method: "OPTIONS",
      url: `/v1/admin/routes/${routeId}`,
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(res.statusCode).toBe(204);
    const allowed = res.headers["access-control-allow-methods"] as string;
    for (const m of ["PUT", "DELETE", "POST", "GET"]) expect(allowed).toContain(m);
  });

  it("discards a survey", async () => {
    const res = await as(admin)("POST", `/v1/admin/surveys/${surveyId}/discard`);
    expect(res.json().status).toBe("discarded");
  });
  it("renames a stop freely, but refuses to move or archive one a published route depends on", async () => {
    const { rows } = await gw.db.query<{ id: string; aliases: string[] }>(
      `SELECT s.id, s.aliases FROM route_stops rs JOIN routes r ON r.id = rs.route_id
         JOIN stops s ON s.id = rs.stop_id
        WHERE r.published_at IS NOT NULL AND r.archived_at IS NULL LIMIT 1`,
    );
    const stop = rows[0]!;
    const rename = await as(admin)("PATCH", `/v1/admin/stops/${stop.id}`, { name: "Renamed stop" });
    expect(rename.statusCode).toBe(200);
    const after = await gw.db.query<{ name: string; aliases: string[] }>(
      `SELECT name, aliases FROM stops WHERE id = $1`,
      [stop.id],
    );
    // a rename leaves every other field alone
    expect(after.rows[0]).toEqual({ name: "Renamed stop", aliases: stop.aliases });
    const move = await as(admin)("PATCH", `/v1/admin/stops/${stop.id}`, { lat: 17.4, lng: 78.5 });
    expect(move.statusCode).toBe(409);
    expect(move.json().error).toBe("stop_in_use");
    expect((await as(admin)("POST", `/v1/admin/stops/${stop.id}/archive`)).statusCode).toBe(409);
  });
});
