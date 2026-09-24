import type { Queryable } from "@busmitra/db";

/**
 * Who a notification reaches (ARCH §6.3 "audience resolution"). One definition, used twice: by
 * the admin console to show "this will reach 312 students" before anything is sent (invariant
 * 11), and by the notify worker (Stage 6) to fan out. Because both call this, the number on the
 * confirmation dialog is the audience that is notified — before per-user filters (kill switch,
 * quiet hours, muted buses), which decide the channel, never who gets the notification-center entry.
 *
 * "Connected to a bus" (ARCH §6.4) is: favourited it (main or starred), or following one of its
 * trips today.
 */
export type Audience =
  | { kind: "all" }
  | { kind: "juniors" }
  | { kind: "seniors" }
  | { kind: "cohorts"; cohorts: ("junior" | "senior")[] }
  | { kind: "route"; routeId: string }
  | { kind: "bus"; busId: string }
  | { kind: "users"; userIds: string[] }
  /** a saved custom announcement: its announcement_recipients rows */
  | { kind: "announcement"; announcementId: string }
  /** engine-internal: an event's own audience ("riders of this trip"), `SELECT user_id …` */
  | { kind: "sql"; sql: string; params: unknown[] };

const FOLLOWING_STATES = `('active', 'boarded')`;

/** SELECT user_id … for the audience: always distinct, always existing profiles. */
export function audienceQuery(a: Audience): { sql: string; params: unknown[] } {
  switch (a.kind) {
    case "all":
      return { sql: `SELECT id AS user_id FROM profiles WHERE role = 'student'`, params: [] };
    case "juniors":
    case "seniors":
      return audienceQuery({
        kind: "cohorts",
        cohorts: [a.kind === "juniors" ? "junior" : "senior"],
      });
    case "cohorts":
      return {
        sql: `SELECT id AS user_id FROM profiles WHERE role = 'student' AND cohort = ANY($1::text[]::cohort_t[])`,
        params: [a.cohorts],
      };
    case "bus":
      return {
        sql: `SELECT f.user_id FROM favourites f WHERE f.bus_id = $1
              UNION
              SELECT s.user_id FROM trip_subscriptions s JOIN trips t ON t.id = s.trip_id
               WHERE t.bus_id = $1 AND t.service_date = operating_date()
                 AND s.state IN ${FOLLOWING_STATES}`,
        params: [a.busId],
      };
    case "route":
      // a route is its lineage: an announcement about "the Uppal route" reaches riders of
      // whichever version is running, and of buses assigned to any version of it
      return {
        sql: `WITH lin AS (
                SELECT id FROM routes WHERE lineage_id = (SELECT lineage_id FROM routes WHERE id = $1)
              ), bus AS (
                SELECT id FROM buses WHERE default_route_id IN (SELECT id FROM lin) AND archived_at IS NULL
                UNION
                SELECT bus_id FROM trips WHERE route_id IN (SELECT id FROM lin)
                   AND service_date = operating_date()
              )
              SELECT f.user_id FROM favourites f WHERE f.bus_id IN (SELECT id FROM bus)
              UNION
              SELECT s.user_id FROM trip_subscriptions s JOIN trips t ON t.id = s.trip_id
               WHERE t.route_id IN (SELECT id FROM lin) AND t.service_date = operating_date()
                 AND s.state IN ${FOLLOWING_STATES}`,
        params: [a.routeId],
      };
    case "users":
      return {
        sql: `SELECT id AS user_id FROM profiles WHERE id = ANY($1::uuid[])`,
        params: [a.userIds],
      };
    case "sql":
      return { sql: a.sql, params: a.params };
    case "announcement":
      return {
        sql: `SELECT user_id FROM announcement_recipients WHERE announcement_id = $1`,
        params: [a.announcementId],
      };
  }
}

export async function countAudience(q: Queryable, a: Audience): Promise<number> {
  const { sql, params } = audienceQuery(a);
  const { rows } = await q.query<{ n: number }>(
    `SELECT count(DISTINCT user_id)::int AS n FROM (${sql}) x`,
    params,
  );
  return rows[0]?.n ?? 0;
}

export async function audienceUserIds(q: Queryable, a: Audience): Promise<string[]> {
  const { sql, params } = audienceQuery(a);
  const { rows } = await q.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM (${sql}) x ORDER BY user_id`,
    params,
  );
  return rows.map((r) => r.user_id);
}

/**
 * Custom audiences are typed as roll numbers. Only claimed accounts can be notified; the rest
 * come back as `unmatched` so the admin sees exactly who will be missed.
 */
export async function resolveRollNos(
  q: Queryable,
  rollNos: readonly string[],
): Promise<{ userIds: string[]; unmatched: string[] }> {
  const wanted = [...new Set(rollNos.map((r) => r.trim().toUpperCase()).filter(Boolean))];
  if (!wanted.length) return { userIds: [], unmatched: [] };
  const { rows } = await q.query<{ id: string; roll_no: string }>(
    `SELECT id, roll_no FROM profiles WHERE roll_no = ANY($1::text[])`,
    [wanted],
  );
  const found = new Set(rows.map((r) => r.roll_no));
  return { userIds: rows.map((r) => r.id), unmatched: wanted.filter((r) => !found.has(r)) };
}
