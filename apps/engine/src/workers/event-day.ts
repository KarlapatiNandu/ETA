import type { CsvError, EventDayRow } from "@busmitra/contracts";
import type { Queryable } from "@busmitra/db";

/**
 * Event-day bus lists — the event-day half of the roster work (BUILD_PLAN Stage 7, SCHEMA §7).
 * Two-phase like the roster (ARCH §10): the parsed file is checked against the database and
 * diffed against the list students currently have, the admin sees the rendered diff and the
 * number of students it will notify, and only an explicit apply writes `event_day_buses`.
 *
 * An upload replaces the list for the date **for the cohorts it mentions**: a seniors-only file
 * leaves the juniors' list alone. Removals are real here (unlike the roster): a bus taken off
 * an event-day list is a bus that is not running for that cohort.
 */

type Cohort = "junior" | "senior";

export interface ResolvedEventDayRow extends EventDayRow {
  bus_id: string;
  route_id: string | null;
  /** the route's display name, for the diff view */
  route_name: string | null;
}

export interface EventDayWarning {
  row: number;
  column: string;
  message: string;
}

/**
 * Check bus numbers and routes against the database. Errors reject the file; warnings are
 * shown in the preview and do not block (a bus in maintenance on a list is worth a second look,
 * not a refusal).
 */
export async function resolveEventDay(
  q: Queryable,
  rows: readonly EventDayRow[],
): Promise<{ rows: ResolvedEventDayRow[]; errors: CsvError[]; warnings: EventDayWarning[] }> {
  const errors: CsvError[] = [];
  const warnings: EventDayWarning[] = [];
  const buses = await q.query<{
    id: string;
    bus_number: string;
    status: string;
    default_route_id: string | null;
  }>(
    `SELECT id, upper(bus_number) AS bus_number, status, default_route_id FROM buses
      WHERE archived_at IS NULL AND upper(bus_number) = ANY($1::text[])`,
    [[...new Set(rows.map((r) => r.bus_number))]],
  );
  const byNumber = new Map(buses.rows.map((b) => [b.bus_number, b]));
  // published, live versions only — a draft or superseded version is not a route anyone rides
  const routes = await q.query<{ id: string; lineage_id: string; name: string; direction: string }>(
    `SELECT id, lineage_id, name, direction FROM routes
      WHERE published_at IS NOT NULL AND archived_at IS NULL`,
  );
  const routeLineage = await q.query<{ id: string; current: string | null }>(
    `SELECT r.id, (SELECT c.id FROM routes c WHERE c.lineage_id = r.lineage_id
                     AND c.published_at IS NOT NULL AND c.archived_at IS NULL) AS current
       FROM routes r WHERE r.id = ANY($1::uuid[])`,
    [buses.rows.map((b) => b.default_route_id).filter(Boolean)],
  );
  const currentVersion = new Map(routeLineage.rows.map((r) => [r.id, r.current]));
  const nameOf = new Map(routes.rows.map((r) => [r.id, `${r.name} (${r.direction})`]));

  const out: ResolvedEventDayRow[] = [];
  for (const r of rows) {
    const bus = byNumber.get(r.bus_number);
    if (!bus) {
      errors.push({
        row: r.line,
        column: "bus_number",
        message: `no bus ${r.bus_number} in the fleet`,
      });
      continue;
    }
    if (bus.status === "retired") {
      errors.push({ row: r.line, column: "bus_number", message: `bus ${r.bus_number} is retired` });
      continue;
    }
    if (bus.status !== "active") {
      warnings.push({
        row: r.line,
        column: "bus_number",
        message: `bus ${r.bus_number} is marked ${bus.status.replace(/_/g, " ")}`,
      });
    }
    let routeId: string | null = null;
    if (r.route) {
      const matches = routes.rows.filter(
        (x) =>
          x.name.toLowerCase() === r.route!.toLowerCase() &&
          (!r.direction || x.direction === r.direction),
      );
      if (!matches.length) {
        errors.push({
          row: r.line,
          column: "route",
          message: `no published route called "${r.route}"`,
        });
        continue;
      }
      if (matches.length > 1) {
        errors.push({
          row: r.line,
          column: "route",
          message: `"${r.route}" runs both ways — add a direction column (inbound / outbound)`,
        });
        continue;
      }
      routeId = matches[0]!.id;
    } else if (bus.default_route_id) {
      routeId = currentVersion.get(bus.default_route_id) ?? null;
    }
    if (!routeId) {
      warnings.push({
        row: r.line,
        column: "route",
        message: `bus ${r.bus_number} has no route — students will see the bus but not its stops`,
      });
    }
    if (!r.departure_time) {
      warnings.push({
        row: r.line,
        column: "departure_time",
        message: "no departure time — students will not see when it leaves",
      });
    }
    out.push({
      ...r,
      bus_id: bus.id,
      route_id: routeId,
      route_name: routeId ? (nameOf.get(routeId) ?? null) : null,
    });
  }
  // a "both" line is two rows: report its problems once
  const once = <T extends { row: number; column: string; message: string }>(xs: T[]) =>
    xs.filter(
      (x, i) =>
        xs.findIndex((y) => y.row === x.row && y.column === x.column && y.message === x.message) ===
        i,
    );
  return { rows: errors.length ? [] : out, errors: once(errors), warnings: once(warnings) };
}

export interface ExistingEventDayRow {
  cohort: Cohort;
  bus_number_raw: string;
  bus_id: string | null;
  route_id: string | null;
  route_name: string | null;
  departure_time: string | null;
  notes: string | null;
}

export async function loadEventDay(
  q: Queryable,
  serviceDate: string,
  cohorts?: readonly Cohort[],
): Promise<ExistingEventDayRow[]> {
  const { rows } = await q.query<ExistingEventDayRow>(
    `SELECT e.cohort, e.bus_number_raw, e.bus_id, e.route_id,
            CASE WHEN r.id IS NOT NULL THEN r.name || ' (' || r.direction || ')' END AS route_name,
            to_char(e.departure_time, 'HH24:MI') AS departure_time, e.notes
       FROM event_day_buses e LEFT JOIN routes r ON r.id = e.route_id
      WHERE e.service_date = $1::date AND ($2::text[]::cohort_t[] IS NULL OR e.cohort = ANY($2::text[]::cohort_t[]))
      ORDER BY e.cohort, e.departure_time NULLS LAST, e.bus_number_raw`,
    [serviceDate, cohorts ?? null],
  );
  return rows;
}

type Field = "route_id" | "departure_time" | "notes";
const FIELDS: Field[] = ["route_id", "departure_time", "notes"];

export interface EventDayChange {
  cohort: Cohort;
  bus_number: string;
  fields: Partial<Record<Field, { from: string | null; to: string | null }>>;
  /** display names for a route change */
  route_from?: string | null;
  route_to?: string | null;
}

export interface EventDayDiff {
  added: {
    cohort: Cohort;
    bus_number: string;
    route_name: string | null;
    departure_time: string | null;
  }[];
  changed: EventDayChange[];
  removed: {
    cohort: Cohort;
    bus_number: string;
    route_name: string | null;
    departure_time: string | null;
  }[];
  unchanged: number;
  /** the cohorts the upload covers — the only ones whose list it can change */
  cohorts: Cohort[];
  /** the cohorts with at least one real change: who gets the T2 */
  notify_cohorts: Cohort[];
}

export function diffEventDay(
  existing: readonly ExistingEventDayRow[],
  incoming: readonly ResolvedEventDayRow[],
): EventDayDiff {
  const cohorts = [...new Set(incoming.map((r) => r.cohort))].sort() as Cohort[];
  const key = (c: string, bus: string) => `${c}|${bus.toUpperCase()}`;
  const current = new Map(
    existing
      .filter((e) => cohorts.includes(e.cohort))
      .map((e) => [key(e.cohort, e.bus_number_raw), e]),
  );
  const diff: EventDayDiff = {
    added: [],
    changed: [],
    removed: [],
    unchanged: 0,
    cohorts,
    notify_cohorts: [],
  };
  const touched = new Set<Cohort>();
  for (const r of incoming) {
    const k = key(r.cohort, r.bus_number);
    const cur = current.get(k);
    current.delete(k);
    if (!cur) {
      diff.added.push({
        cohort: r.cohort,
        bus_number: r.bus_number,
        route_name: r.route_name,
        departure_time: r.departure_time,
      });
      touched.add(r.cohort);
      continue;
    }
    const fields: EventDayChange["fields"] = {};
    for (const f of FIELDS) {
      const to = (r[f] ?? null) as string | null;
      const from = cur[f] ?? null;
      if (to !== from) fields[f] = { from, to };
    }
    if (Object.keys(fields).length) {
      diff.changed.push({
        cohort: r.cohort,
        bus_number: r.bus_number,
        fields,
        ...(fields.route_id ? { route_from: cur.route_name, route_to: r.route_name } : {}),
      });
      touched.add(r.cohort);
    } else diff.unchanged++;
  }
  for (const cur of current.values()) {
    diff.removed.push({
      cohort: cur.cohort,
      bus_number: cur.bus_number_raw,
      route_name: cur.route_name,
      departure_time: cur.departure_time,
    });
    touched.add(cur.cohort);
  }
  diff.notify_cohorts = [...touched].sort();
  return diff;
}

export const summariseEventDay = (d: EventDayDiff) => ({
  added: d.added.length,
  changed: d.changed.length,
  removed: d.removed.length,
  unchanged: d.unchanged,
  cohorts: d.cohorts,
  notify_cohorts: d.notify_cohorts,
});

/**
 * Apply a confirmed list. Run inside `withContext` so every row lands in audit_log with the
 * admin who confirmed it. Unchanged rows are not rewritten (no audit noise, no re-notify).
 *
 * A scheduled trip that has not started and no longer matches the list is cancelled, so a bus
 * taken off the list, or moved to a new time, does not keep showing its old departure.
 */
export async function applyEventDay(
  q: Queryable,
  uploadId: string,
  serviceDate: string,
  incoming: readonly ResolvedEventDayRow[],
): Promise<{ cancelledTrips: number }> {
  const cohorts = [...new Set(incoming.map((r) => r.cohort))];
  const keep = incoming.map((r) => `${r.cohort}|${r.bus_number}`);
  // the buses this apply can affect: on the old list for these cohorts, or on the new one
  const before = await q.query<{ bus_id: string }>(
    `SELECT DISTINCT bus_id FROM event_day_buses
      WHERE service_date = $1::date AND cohort = ANY($2::text[]::cohort_t[]) AND bus_id IS NOT NULL`,
    [serviceDate, cohorts],
  );
  const affected = [
    ...new Set([...before.rows.map((r) => r.bus_id), ...incoming.map((r) => r.bus_id)]),
  ];
  await q.query(
    `DELETE FROM event_day_buses
      WHERE service_date = $1::date AND cohort = ANY($2::text[]::cohort_t[])
        AND NOT (cohort::text || '|' || upper(bus_number_raw) = ANY($3::text[]))`,
    [serviceDate, cohorts, keep],
  );
  for (const r of incoming) {
    await q.query(
      `INSERT INTO event_day_buses
         (upload_id, service_date, cohort, bus_id, bus_number_raw, route_id, departure_time, notes)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7::time, $8)
       ON CONFLICT (service_date, cohort, bus_number_raw) DO UPDATE
         SET upload_id = EXCLUDED.upload_id, bus_id = EXCLUDED.bus_id, route_id = EXCLUDED.route_id,
             departure_time = EXCLUDED.departure_time, notes = EXCLUDED.notes
       WHERE (event_day_buses.bus_id, event_day_buses.route_id, event_day_buses.departure_time,
              event_day_buses.notes)
             IS DISTINCT FROM (EXCLUDED.bus_id, EXCLUDED.route_id, EXCLUDED.departure_time, EXCLUDED.notes)`,
      [
        uploadId,
        serviceDate,
        r.cohort,
        r.bus_id,
        r.bus_number,
        r.route_id,
        r.departure_time,
        r.notes,
      ],
    );
  }
  // scheduled, never-started trips that the list no longer backs
  const cancelled = await q.query(
    `UPDATE trips t SET status = 'cancelled'
      WHERE t.status = 'scheduled' AND t.started_at IS NULL AND t.service_date = $1::date
        AND t.scheduled_start_at IS NOT NULL AND t.bus_id = ANY($2::uuid[])
        AND NOT EXISTS (
          SELECT 1 FROM event_day_buses e
           WHERE e.service_date = t.service_date AND e.bus_id = t.bus_id AND e.route_id = t.route_id
             AND (e.service_date + e.departure_time) AT TIME ZONE 'Asia/Kolkata' = t.scheduled_start_at)
      RETURNING t.id`,
    [serviceDate, affected],
  );
  return { cancelledTrips: cancelled.rows.length };
}
