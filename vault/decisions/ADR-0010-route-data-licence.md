# ADR-0010 — Publish the route and stop data under ODbL

**Status:** **proposed — needs the owner's decision before the public launch** · **Stage:** 9 ·
**Date:** 2026-09-24

## Context

The tracker has carried "ODbL position on surveyed route geometry" since Stage 0 (risk register:
Low likelihood, Medium impact). Route polylines are made by map-matching our own GPS traces
**against OpenStreetMap through OSRM** (Stage 1), and the vector tiles students see are OSM data
(ADR-0005). OSM is licensed under the Open Database License (ODbL 1.0).

What ODbL asks, in short: a **Derivative Database** — a database adapted from OSM — must be
offered under ODbL if it is **publicly used**. A **Produced Work** (a map image, an app screen)
only needs attribution ("© OpenStreetMap contributors"), which the map already shows (Stage 3).

The question: are `routes.geometry` and `stops` a Derivative Database? They are our traces,
snapped onto OSM's road network so that every vertex lies on an OSM way. That is plausibly a
derivative of OSM, and nobody at this project is in a position to argue otherwise with
confidence. The route data is also not valuable to keep private: it is thirty campus bus routes.

## Options

- **A. Publish `routes` (geometry, name, direction, version) and `stops` (name, location) under
  ODbL (recommended).** A CSV/GeoJSON export on request, or a public file, with the licence
  stated. Costs nothing, removes the question entirely, and is the honest reading.
- **B. Keep route geometry unmatched** (our raw traces only, never snapped to OSM), so it is not
  derived. Worse routes (GPS noise on every polyline), a pipeline change, and the ETA work in
  Stages 1 and 5 assumes matched geometry. Rejected.
- **C. Do nothing and argue the data is not "publicly used".** The route data is shown to every
  student; this is the risk the register already names.

## Recommendation

Adopt **A** before the public launch: add the licence line to the README's *License* section
("Route and stop data © CBIT, derived in part from © OpenStreetMap contributors, available under
the Open Database License"), and publish an export of `routes` + `stops` (no students, no
trips, no positions — none of which are derived from OSM). The application code licence is a
separate decision the README already leaves open.

## Consequence if accepted

Anyone may reuse the route and stop data with attribution and share-alike. Student, trip and
position data are unaffected: they are not derived from OSM and remain private under SCHEMA §9.
