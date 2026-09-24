# ADR-0003 — Route versioning: immutable versions on a stable lineage

**Status:** accepted · **Stage:** 1 · **Date:** 2026-09-23

## Context

Routes are not imported from anywhere: they are captured by driving each route once and
map-matching the trace (BUILD_PLAN Stage 1). That makes corrections *normal*, not exceptional —
the first match of a 40 km route will have a wrong turn in it somewhere, a stop 100 m off the
kerb, a seam where two matched chunks joined badly.

Three things pull against each other when a route changes:

1. **History must still resolve.** A trip that ran three months ago has to replay against the
   geometry it actually drove, or its positions, its stop events and its measured accuracy all
   become nonsense. `positions.route_offset_m` is a scalar along *a particular polyline*.
2. **Learned data must survive a correction.** `segment_speeds` and `dead_zones` take about a
   fortnight of running to become useful (ARCH §5.5). If nudging one stop by 50 m resets them,
   the system spends its life in cold start while *appearing* to have a traffic model.
3. **The live fleet must be unambiguous.** At 7:40 a.m. there is exactly one answer to "what
   route is Bus 14 on today", and the driver app's picker must not offer three of them.

## Options considered

- **A. Edit routes in place.** Simplest, and wrong: it rewrites what old trips ran. A stop's
  `cumulative_dist_m` would change under `trip_stop_events` rows that already reference it, and
  every historical offset would silently mean something else.
- **B. Version rows, key everything to `routes.id`.** Correct history, but every correction
  orphans the learned tables — exactly failure (2). This is the version that looks right in
  review and is discovered to be wrong a semester later, with no error anywhere.
- **C. Version rows + a stable `lineage_id` (chosen).** A published route is immutable; a
  correction inserts `version + 1` as a new row with a new `id` and the *same* `lineage_id`.
  Operational data (trips, positions, stop events) references `routes.id` — what physically
  ran. Learned data (`segment_speeds`, `dead_zones`) references `lineage_id` — what we know
  about this corridor. A genuinely new corridor gets a new lineage and starts cold, correctly.
- **D. Separate `route_definitions` and `route_geometries` tables.** The same idea with more
  joins and a second place for "which one is live" to disagree with itself.

## Decision

C. Enforced in the database rather than in application code, because the code that corrupts
history is code nobody is looking at:

- `routes_immutable` (trigger, 0003): a published row rejects every `UPDATE` except
  `archived_at`, and rejects `DELETE` outright. Drafts are freely editable and deletable.
- `route_stops_frozen` (trigger): a published route's stops cannot be inserted, updated or
  deleted. Stops are frozen *with* the version that measured their offsets.
- `one_live_route` (partial unique index on `lineage_id` where published and not archived):
  exactly one live version per lineage, so "today's route" has one answer.
- Publishing is therefore a two-statement transaction: archive the version being replaced,
  then publish the new one. `publishRoute()` in `apps/engine/src/routes.ts` is the only
  code that does it.

## Consequences accepted

- **Superseded and deleted look the same to a student.** `archived_at` carries both meanings,
  and students read only non-archived routes. A trip still running on the version that was just
  replaced keeps working (it references the row by `id`, which is still there), but a student
  asking for that route's geometry through the API will not see it. At 30 buses and ~2 trips a
  day, publishing mid-service is an operational choice, not a race the schema has to win. If it
  ever matters, the fix is a `superseded_at` column, not a redesign.
- **A stop's location is shared; its offset is not.** `stops` rows are global and reused across
  routes (that is what makes "Dilsukhnagar" one searchable place, not eight). Moving a stop's
  `location` would change what a published route's frozen `cumulative_dist_m` refers to, so the
  editor creates a new stop instead of moving an existing one, and only text fields (name,
  aliases, area, landmark) are editable in place. Enforcing that in the database is Stage 7's
  job, with the rest of the stop-management UI.
- **A re-survey must be told which lineage it corrects.** The admin picks "re-survey of …" when
  matching a trace; nothing infers it from geometry. Inferring it would be guessing about the
  one thing that decides whether a semester of traffic history is kept or thrown away.
- **Versions accumulate.** Each is a polyline of a few hundred vertices — kilobytes. Not a
  problem worth solving.

## What this does not decide

Route *scheduling* (`trips.scheduled_start_at`, timetables) and how a route is assigned to a bus
for a service day. Stage 7 owns those.
