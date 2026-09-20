# Bus Mitra — Data Model

> The authoritative reference for the database. Migrations in `packages/db/migrations` must match this document; if they diverge, this document is updated in the same pull request.
>
> Postgres 15 + PostGIS 3.4 + `pg_trgm` + `pgcrypto`. All geometry columns use `geography(…, 4326)` so distances come back in metres without projection juggling.

---

## 0. Conventions

| Rule | Reason |
|---|---|
| `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` everywhere except join tables | Stable across environments; no sequence collisions when seeding. |
| All timestamps are `timestamptz`, stored UTC | The app has one timezone (`Asia/Kolkata`) but *never* store local time. |
| `service_date date` is the **operating day**, not the calendar day | An evening trip that crosses midnight belongs to the day it started. Every daily-uniqueness constraint keys off this. |
| Every table has `created_at`, mutable tables have `updated_at` (trigger-maintained) | Debugging without this is archaeology. |
| Enums are Postgres `ENUM` types, not text + CHECK | Type safety reaches Drizzle and the client. |
| **RLS enabled on every table, default deny** | See §9. |
| Soft delete (`archived_at`) on `buses`, `routes`, `stops` | Historical trips must still resolve their route geometry. |
| Operational data keys on `routes.id`; **learned** data keys on `routes.lineage_id` | A route correction must not orphan the traffic model. See §3. |
| Tables are declared here in reading order, **not migration order** | `roster_students.upload_id` references `roster_uploads` (§7) and `dead_zones`/`signal_outages` reference `trips` (§4). Migrations must create referenced tables first, or add the FKs in a later `ALTER`. |

---

## 1. Identity and roster

Sign-in is **roll number + password, seeded from a Transport Department roster**. The roster is the allowlist: nobody who is not on it can create an account.

⚠️ **Confirm with the Transport Department what `cohort` actually means before Stage 4.** The schema models it as a two-value enum (`junior` | `senior`) because the operational reality being encoded is a *shift split* — two departure waves, different buses, different times — not an academic year. If that is right, two values is exactly correct and `audience_t`'s `juniors`/`seniors` targeting follows. If the TD instead expects to address a single year group ("message the second-years about tomorrow's exam buses"), two values cannot express it and the enum needs to become `year_level smallint` with cohort derived from it. Cheap to settle in a conversation now; an enum migration with live RLS policies and a notification audience query on top of it later.

### `roster_students` — the allowlist

```sql
CREATE TABLE roster_students (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  roll_no         text NOT NULL UNIQUE,
  full_name       text NOT NULL,
  admission_year  smallint NOT NULL,
  cohort          cohort_t NOT NULL,          -- 'junior' | 'senior'
  phone_e164      text,                       -- +91XXXXXXXXXX; nullable — see note below
  branch          text,
  claimed_at      timestamptz,                -- NULL until the student claims the account
  claimed_by      uuid REFERENCES auth.users(id),
  upload_id       uuid REFERENCES roster_uploads(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON roster_students (lower(roll_no));
CREATE INDEX ON roster_students (cohort) WHERE claimed_at IS NOT NULL;
```

⚠️ **`phone_e164` is nullable on purpose, and that is a concession to a risk we have already rated High.** The build plan's risk register expects the Transport Department roster to arrive late, incomplete, or without phone numbers. A `NOT NULL` column would make the *import* fail on exactly the roster we expect to receive, blocking Stage 4 entirely — when the only thing that genuinely needs a phone number is the OTP claim and the T0/T1 SMS fallback. So: import accepts rows without a phone; **claiming requires one**. Students missing a number are surfaced in the admin console as a work queue for the TD to fill in, and the fallback claim channel (admin-created accounts for the pilot cohort) covers the rest.

**`cohort` is recomputed, not frozen.** A nightly job promotes `junior → senior` at the start of each academic year based on `admission_year`. Storing the derived value keeps the notification audience query a simple indexed lookup instead of a date calculation across 300 rows on every send.

### `profiles` — the claimed account

```sql
CREATE TABLE profiles (
  id                     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  roll_no                text NOT NULL UNIQUE REFERENCES roster_students(roll_no),
  full_name              text NOT NULL,
  cohort                 cohort_t NOT NULL,
  role                   role_t NOT NULL DEFAULT 'student',  -- student|driver|td_admin|super_admin
  phone_e164             text NOT NULL,
  phone_verified_at      timestamptz,

  -- location pin (coarsened to ~100 m before storage — see ARCHITECTURE §10)
  home_location          geography(Point, 4326),
  home_label             text,
  travel_mode            travel_mode_t NOT NULL DEFAULT 'foot',  -- foot|bicycle|motorbike|car

  -- notification preferences
  alerts_paused_until    timestamptz,          -- the global kill switch
  max_tier               smallint NOT NULL DEFAULT 3,  -- deliver tiers 0..max_tier; suppress above
  critical_breakthrough  boolean NOT NULL DEFAULT true, -- T0 ignores the kill switch
  quiet_start_min        smallint,             -- minutes from local midnight, NULL = no quiet hours
  quiet_duration_min     smallint,             -- length of the window; may wrap past midnight
  default_buffer_s       integer NOT NULL DEFAULT 180,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON profiles (role) WHERE role <> 'student';
CREATE INDEX ON profiles (cohort);
CREATE INDEX ON profiles USING GIST (home_location);
```

Two naming and representation choices here exist to prevent specific bugs:

⚠️ **`max_tier`, not `min_tier`.** Tiers run T0 CRITICAL → T4 AMBIENT, so a *lower* number is *more* severe. A column called `min_tier` holding `3` would have to mean "suppress anything above 3", which reads as the opposite of what it does and guarantees that someone eventually writes `tier >= profile.min_tier` and inverts every user's preferences at once. `max_tier = 3` reads exactly as the rule it encodes: **deliver 0 through 3, suppress 4.**

⚠️ **Quiet hours as `(start, duration)`, not `int4range`.** The common case is overnight — 22:00 to 06:00 — which as minutes-from-midnight is `[1320, 360)`. That is not a valid range; Postgres rejects it outright, and the natural workaround of storing two rows doubles every check. A start plus a duration wraps past midnight without special-casing: `(now_min - quiet_start_min) mod 1440 < quiet_duration_min`.

### The claim flow

Supabase Auth requires an email identity, and these students may not have college email. We therefore mint a **synthetic, non-routable address** and verify identity out of band through the phone number the Transport Department already holds:

```
1. Student enters roll number
2. Server looks up roster_students; if absent or already claimed → generic failure
   (never reveal which — that would leak the roster)
3. Server sends a 6-digit OTP to roster.phone_e164 via MSG91
   UI shows the masked number: "+91 ••••• •3210"
4. Student enters OTP + chooses a password
5. Server (service-role) creates auth.users with
   email = '<roll_no>@students.busmitra.internal', email_confirmed = true
6. profiles row created, roster_students.claimed_at set
```

Two things fall out of this for free: **the phone number is verified**, which the T0/T1 SMS fallback depends on, and **account recovery** works over SMS without an email provider.

```sql
CREATE TABLE claim_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  roll_no       text NOT NULL,
  otp_hash      text NOT NULL,          -- bcrypt; never store the code itself
  attempts      smallint NOT NULL DEFAULT 0,
  expires_at    timestamptz NOT NULL,   -- now() + 10 min
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON claim_challenges (roll_no, expires_at DESC);
```

Rate limit: 3 challenges per roll number per hour, 5 OTP attempts per challenge, then lock out for 30 minutes.

---

## 2. Fleet

```sql
CREATE TABLE buses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bus_number      text NOT NULL UNIQUE,      -- "14" — what students actually say
  registration_no text UNIQUE,               -- "TS09UB1234"
  capacity        smallint,
  status          bus_status_t NOT NULL DEFAULT 'active',
        -- active | maintenance | out_of_commission | retired
  status_note     text,
  default_route_id uuid REFERENCES routes(id),
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trackers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_uid    text NOT NULL UNIQUE,     -- phone install id, or hardware IMEI
  kind          tracker_kind_t NOT NULL,  -- 'driver_phone' | 'hardware'
  bus_id        uuid REFERENCES buses(id),
  secret_enc    bytea NOT NULL,           -- pgp_sym_encrypt of the HMAC shared secret
  secret_rotated_at timestamptz,
  cadence_s     smallint NOT NULL DEFAULT 5,  -- last reported reporting interval
  firmware      text,
  last_seen_at  timestamptz,
  battery_pct   smallint,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON trackers (bus_id) WHERE bus_id IS NOT NULL;
```

⚠️ **`secret_enc` is encrypted, not hashed, and the distinction is load-bearing.** Verifying an HMAC means recomputing `HMAC-SHA256(secret, device_id|timestamp|body)` server-side and comparing — which requires the *plaintext* secret. A bcrypt hash is one-way, so storing one here would make ingest authentication mathematically impossible, not merely inconvenient. Use `pgcrypto`'s `pgp_sym_encrypt` with a key held in the gateway environment (never in the database), or an external secret store. The instinct to hash anything called "secret" is right for passwords and wrong for shared keys; these are opposite problems.

Rotation issues a fresh secret, returns it exactly once to the device being provisioned, and sets `secret_rotated_at`. Both the old and new secret are accepted for a 10-minute overlap so a rotation cannot brick a bus mid-route.

`cadence_s` is the tracker's current reporting interval, echoed in every `PingBatch` and copied into `fleet:live`. The presence sweeper derives `DEGRADED` / `DARK` thresholds from it (ARCHITECTURE §5.7) rather than from absolute seconds.

`kind` is the seam that lets Stage 9 swap driver phones for wired hardware **without touching the ingest contract** — only the adapter in front of it changes.

---

## 3. Geography

### `routes`

```sql
CREATE TABLE routes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lineage_id        uuid NOT NULL,          -- stable across versions; see note below
  name              text NOT NULL,
  direction         direction_t NOT NULL,   -- 'inbound' (to campus) | 'outbound'
  geometry          geography(LineString, 4326) NOT NULL,
  cumulative_dist_m double precision[] NOT NULL,  -- precomputed D[], see ARCHITECTURE §5.1
  total_distance_m  double precision NOT NULL,
  version           integer NOT NULL DEFAULT 1,
  published_at      timestamptz,
  source            route_source_t NOT NULL,  -- 'gps_survey' | 'osrm_derived' | 'manual_draw'
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, direction, version)
);
CREATE INDEX ON routes USING GIST (geometry);
CREATE INDEX ON routes (lineage_id, version DESC);
-- exactly one published version per lineage at a time
CREATE UNIQUE INDEX one_live_route ON routes (lineage_id)
  WHERE published_at IS NOT NULL AND archived_at IS NULL;
```

⚠️ **`lineage_id` is what stops route versioning from wiping the system's memory.** Versioning is correct — a published route is immutable, and a correction creates `version + 1` as a new row with a new `id`, so a three-month-old trip still resolves the geometry it actually ran. But every *learned* table (`segment_speeds`, `dead_zones`) would naturally key on that `id`, which means nudging one stop by 50 m orphans a semester of traffic history and every dead-zone polygon on the route, silently and with no error. The system would appear to have a learned model and would in fact be back at cold start.

The split is: **operational data references `routes.id`** (what physically ran), **learned data references `routes.lineage_id`** (what we know about this corridor). A re-survey keeps its history; a genuinely new corridor gets a new lineage and starts cold, which is right.

**`cumulative_dist_m` is denormalised on purpose.** It is derived from `geometry`, but recomputing a 2,000-vertex prefix sum on every worker start — or worse, per ping — is waste. It is rebuilt by trigger whenever `geometry` changes.

**Routes are versioned, never edited in place.** A published route is immutable; a change creates `version + 1`. Historical trips keep pointing at the geometry they actually ran, so replaying a three-month-old trip still works.

### `stops`

```sql
CREATE TABLE stops (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  aliases           text[] NOT NULL DEFAULT '{}',  -- "Dilsuknagar", "DSNR", "Dilsukh Nagar"
  area_name         text,                          -- "Dilsukhnagar" — the searchable locality
  landmark          text,                          -- "opposite Konark Theatre"
  location          geography(Point, 4326) NOT NULL,
  geofence_radius_m smallint NOT NULL DEFAULT 80,  -- fallback only; see ARCHITECTURE §5.4
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON stops USING GIST (location);
CREATE INDEX stops_name_trgm ON stops USING GIN (name gin_trgm_ops);
CREATE INDEX stops_area_trgm ON stops USING GIN (area_name gin_trgm_ops);
CREATE INDEX stops_aliases_gin ON stops USING GIN (aliases);
```

The trigram indexes are what make **"Dilsuknagar" find "Dilsukhnagar"**. Students type fast on phones and misspell constantly; exact match would fail the primary search use case.

### `route_stops`

```sql
CREATE TABLE route_stops (
  route_id            uuid NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  seq                 smallint NOT NULL,
  stop_id             uuid NOT NULL REFERENCES stops(id),
  cumulative_dist_m   double precision NOT NULL,  -- D_k: offset of this stop along the route
  scheduled_offset_s  integer,                    -- seconds after trip start (timetable fallback)
  expected_dwell_s    smallint NOT NULL DEFAULT 30,
  PRIMARY KEY (route_id, seq)
);
CREATE INDEX ON route_stops (stop_id);
```

⚠️ **There is deliberately no `UNIQUE (route_id, stop_id)`.** The obvious constraint would forbid a route from serving the same stop twice — but ARCHITECTURE §5.2 explicitly designs the snapping window for "a route that loops back near itself", and a circular route that passes the campus gate outbound and again inbound is an ordinary thing for a campus fleet to do. Uniqueness on `(route_id, seq)` already prevents the actual error (two stops in the same sequence position) without ruling out a legitimate topology. If a given route genuinely must not repeat a stop, enforce that in the route editor at publish time, where it is a validation warning a human can override — not in the schema, where it is a wall.

`cumulative_dist_m` is the single number the entire arrival algorithm runs on. It is computed at route-publish time by projecting each stop onto the route geometry.

### `dead_zones` — learned, not configured

```sql
CREATE TABLE dead_zones (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  polygon          geography(Polygon, 4326) NOT NULL,
  route_lineage_id uuid,                 -- lineage, not version: survives a re-survey
  label            text,                 -- "Uppal flyover underpass"
  sample_count     integer NOT NULL,
  avg_outage_s     integer NOT NULL,
  p90_outage_s     integer NOT NULL,
  confidence       real NOT NULL,        -- 0..1, from cluster density
  last_observed_at timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON dead_zones USING GIST (polygon);

CREATE TABLE signal_outages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  bus_id        uuid NOT NULL REFERENCES buses(id),
  entry_point   geography(Point, 4326) NOT NULL,
  exit_point    geography(Point, 4326),
  started_at    timestamptz NOT NULL,
  recovered_at  timestamptz,
  duration_s    integer GENERATED ALWAYS AS
                  (EXTRACT(epoch FROM recovered_at - started_at)::integer) STORED,
  dead_zone_id  uuid REFERENCES dead_zones(id),  -- set if it matched a known zone
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON signal_outages USING GIST (entry_point);
```

`signal_outages` is the raw observation log; the nightly DBSCAN job clusters it into `dead_zones`. This is the pair that turns "the bus vanished" into "the bus is in the Uppal underpass, back in about 90 seconds."

---

## 4. Operations

```sql
CREATE TABLE trips (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bus_id        uuid NOT NULL REFERENCES buses(id),
  route_id      uuid NOT NULL REFERENCES routes(id),
  driver_id     uuid REFERENCES profiles(id),
  service_date  date NOT NULL,
  shift         shift_t NOT NULL,          -- 'morning' | 'evening'
  run_seq       smallint NOT NULL DEFAULT 1,  -- 2nd run of the same shift, if any
  status        trip_status_t NOT NULL DEFAULT 'scheduled',
        -- scheduled | running | dark | completed | cancelled
  scheduled_start_at timestamptz,          -- anchors route_stops.scheduled_offset_s
  started_at    timestamptz,
  ended_at      timestamptz,
  last_offset_m double precision,          -- s: progress along the route
  last_seq      smallint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bus_id, service_date, shift, run_seq)
);
CREATE INDEX ON trips (service_date, status);
CREATE INDEX trips_running ON trips (bus_id) WHERE status = 'running';

-- the actual idempotency guarantee: one *live* trip per bus at a time
CREATE UNIQUE INDEX one_live_trip ON trips (bus_id)
  WHERE status IN ('scheduled', 'running', 'dark');
```

**Why the constraint moved.** The obvious `UNIQUE (bus_id, service_date, shift)` was buying trip-creation idempotency — a driver who force-quits and reopens the app must resume the same trip, not start a duplicate. That property is real and worth protecting. But it was being bought with a rule that also **forbids a bus from making two runs in one shift**, and this fleet already models juniors and seniors as separate cohorts with separate event-day lists — a bus doing a 7:10 senior run and an 8:00 junior run is an ordinary morning, not an edge case.

`one_live_trip` buys the same idempotency more precisely: a bus can have only one trip open at any moment, so a reconnecting driver app finds and resumes it, while a completed run leaves the index and a second run starts cleanly with `run_seq = 2`.

⚠️ **`scheduled_start_at` is what makes `route_stops.scheduled_offset_s` mean anything.** That column is an offset *from trip start*, and without an anchor there is nowhere in the schema to record when a trip is supposed to begin — which makes the search result `Bus 22 · 7:40 AM · scheduled` (BUILD_PLAN Stage 5) uncomputable for any bus that is not already running. Populated from the timetable when trips are generated for the service day; `event_day_buses.departure_time` overrides it on event days.

```sql
CREATE TABLE positions (
  id              bigserial,
  trip_id         uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  bus_id          uuid NOT NULL,
  recorded_at     timestamptz NOT NULL,   -- when the GPS fix happened
  ingested_at     timestamptz NOT NULL DEFAULT now(),
  location        geography(Point, 4326) NOT NULL,
  speed_kmh       real,
  heading_deg     smallint,
  accuracy_m      real,
  route_offset_m  double precision,       -- snapped s, NULL if off-route
  is_backfill     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);

CREATE UNIQUE INDEX ON positions (trip_id, recorded_at);  -- ingest idempotency
CREATE INDEX ON positions (trip_id, recorded_at DESC);
```

**Weekly partitions**, created ahead by a `pg_cron` job, dropped once fully older than 90 days (aggregated into `segment_speeds` first). Monthly partitions would be the obvious choice at this volume, but a partition can only be dropped when its *newest* row is past retention — so monthly buckets mean data actually lives 90–120 days, and the retention promise in §12 (and the privacy commitment in ARCHITECTURE §10, which drivers are told about out loud) would be quietly wrong by up to a month. Weekly buckets hold the real retention to 90–97 days. At ~86 k rows/day each partition is ~600 k rows, which is still nothing.

The unique index on `(trip_id, recorded_at)` is the ingest idempotency guarantee — a tracker that retries a batch after a timeout cannot create duplicates. Note that it includes `recorded_at`, the partition key, because a unique index on a partitioned table must.

⚠️ **`COPY` cannot enforce that index gracefully, and the persister must be built around this.** `COPY` has no `ON CONFLICT` clause: a single duplicate row aborts the entire batch transaction, so the naive "batch 200 rows and `COPY` them in" design fails the first time a tracker retries — which is a designed-for, everyday event, not an anomaly. The persister therefore:

```
COPY batch → positions_staging (UNLOGGED, truncated per batch)
INSERT INTO positions SELECT * FROM positions_staging
  ON CONFLICT (trip_id, recorded_at) DO NOTHING
TRUNCATE positions_staging
```

This keeps `COPY`'s throughput on the wire while making conflicts a no-op instead of a batch-killer.

```sql
CREATE TABLE trip_stop_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id      uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  stop_id      uuid NOT NULL REFERENCES stops(id),
  seq          smallint NOT NULL,
  event        stop_event_t NOT NULL,   -- 'arrived' | 'departed' | 'skipped'
  occurred_at  timestamptz NOT NULL,
  source       event_source_t NOT NULL, -- 'crossing' | 'inferred' | 'manual'
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, seq, event)          -- the idempotency backstop
);

CREATE TABLE segment_speeds (
  route_lineage_id uuid NOT NULL,      -- lineage, not version — survives a re-survey
  segment_idx   integer NOT NULL,      -- 200 m bucket index along the route
  weekday       smallint,              -- 0..6; NULL = aggregated across days
  tod_bucket    smallint,              -- 15-minute bucket 0..95; NULL = aggregated
  median_kmh    real NOT NULL,
  p10_kmh       real NOT NULL,
  p90_kmh       real NOT NULL,
  sample_count  integer NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- a PRIMARY KEY cannot contain expressions, and NULL never equals NULL in a
-- unique constraint — so the aggregate rungs are keyed by a COALESCE index
CREATE UNIQUE INDEX segment_speeds_key ON segment_speeds
  (route_lineage_id, segment_idx,
   COALESCE(weekday, -1), COALESCE(tod_bucket, -1));
```

`segment_speeds` is the learned traffic model — rebuilt nightly from `positions` before the raw rows are aged out. It is what turns a cold-start OSRM guess into an ETA that knows the Dilsukhnagar junction crawls at 6 p.m. on weekdays.

⚠️ **The nullable `weekday` and `tod_bucket` are not laziness — they are the rungs of the fallback ladder, and without them the table never fills.** A route runs about two trips a day. Keyed by weekday *and* a 15-minute bucket, each exact cell gains roughly **one sample per week**, so the fully-specified cells would not reach a usable sample count until deep into a second semester. The nightly job therefore writes four aggregation levels — exact, weekday-agnostic, time-agnostic, and segment-only — and ARCHITECTURE §5.5 reads the most specific rung with `sample_count ≥ 5`. A route has usable history within a fortnight and sharpens over the term, instead of pretending to have a model it does not have.

The nightly rebuild should be **incremental** (yesterday's partition only, merged into the running aggregates), not a full recompute over 90 days of `positions` — the full scan is ~7.7 M rows and grows.

---

## 5. Student relationships

```sql
CREATE TABLE favourites (
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  bus_id      uuid NOT NULL REFERENCES buses(id) ON DELETE CASCADE,
  kind        fav_kind_t NOT NULL,      -- 'main' | 'starred'
  muted_until timestamptz,              -- "not today" without losing the star
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bus_id)
);

-- exactly one main favourite per student
CREATE UNIQUE INDEX one_main_fav ON favourites (user_id) WHERE kind = 'main';
```

That partial unique index enforces the "`main_favourite` is different from starring" rule **in the database**, so no application path can ever produce a student with two main buses.

```sql
CREATE TABLE trip_subscriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trip_id              uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  target_stop_id       uuid NOT NULL REFERENCES stops(id),
  state                sub_state_t NOT NULL DEFAULT 'active',
        -- active | muted | boarded | completed | missed
  travel_time_s        integer,        -- cached OSRM duration, home → stop
  travel_mode          travel_mode_t NOT NULL DEFAULT 'foot',
  buffer_s             integer NOT NULL DEFAULT 180,
  notified_departure_at timestamptz,   -- "leave now" fired — fires at most once
  boarded_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, trip_id)
);
CREATE INDEX subs_active ON trip_subscriptions (trip_id)
  WHERE state = 'active' AND notified_departure_at IS NULL;
```

That partial index is the one the 10-second leave-now ticker scans. It stays tiny — rows leave it the moment they fire — so the hottest loop in the system touches a handful of rows.

```sql
CREATE TABLE walk_eta_cache (
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  stop_id       uuid NOT NULL REFERENCES stops(id) ON DELETE CASCADE,
  travel_mode   travel_mode_t NOT NULL,
  duration_s    integer NOT NULL,
  distance_m    integer NOT NULL,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, stop_id, travel_mode)
);
```

A student's home does not move. Calling OSRM on every ETA tick would be absurd; this is computed once and refreshed daily or when the pin changes.

---

## 6. Notifications and tickets

```sql
CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier         smallint NOT NULL,        -- 0 CRITICAL … 4 AMBIENT
  category     notif_category_t NOT NULL,
        -- bus_activated | stop_reached | leave_now | signal_lost | signal_restored
        -- | delay | announcement | roster_published | ticket_opened | ticket_resolved
  title        text NOT NULL,
  body         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  collapse_tag text,                     -- Web Push `tag`; T3 progress updates share one
  bus_id       uuid REFERENCES buses(id),
  trip_id      uuid REFERENCES trips(id),
  ticket_id    uuid REFERENCES tickets(id),
  created_by   uuid REFERENCES profiles(id),  -- NULL = system-generated
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz
);
CREATE INDEX ON notifications (created_at DESC);

CREATE TABLE notification_recipients (
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  dedupe_key      text NOT NULL,
  channel         notif_channel_t,   -- push | sms | inapp_only
  queued_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  read_at         timestamptz,
  acknowledged_at timestamptz,       -- T0 requires this
  failure_reason  text,
  PRIMARY KEY (notification_id, user_id)
);
CREATE UNIQUE INDEX notif_dedupe ON notification_recipients (dedupe_key);
CREATE INDEX notif_unread ON notification_recipients (user_id, queued_at DESC)
  WHERE read_at IS NULL;
```

`notif_dedupe` is the guarantee described in ARCHITECTURE §6.2 — **the database, not the worker, is what makes double-notification impossible.**

⚠️ **Write the `notifications` row and all its `notification_recipients` rows in one transaction.** `notifications.id` defaults to a fresh uuid, so a worker that crashes between the parent insert and the recipient inserts leaves an orphan parent behind; on retry it creates a *second* parent, and only the recipient-level `dedupe_key` stops the student being notified twice. The student is protected either way, but the notification center accumulates unreferenced rows that make delivery auditing untrustworthy — and delivery auditing is how you answer "why was my alert late" at 7:40 a.m. One transaction, or an idempotency key on the parent as well.

```sql
CREATE TABLE push_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  endpoint      text NOT NULL UNIQUE,
  p256dh        text NOT NULL,
  auth          text NOT NULL,
  user_agent    text,
  is_standalone boolean,            -- true = installed PWA; iOS push needs this
  failure_count smallint NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON push_subscriptions (user_id) WHERE failure_count < 5;

CREATE TABLE tickets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          ticket_kind_t NOT NULL,
        -- out_of_commission | breakdown | route_change | delay | signal_lost | other
  severity      smallint NOT NULL,        -- mirrors notification tier
  bus_id        uuid REFERENCES buses(id),
  trip_id       uuid REFERENCES trips(id),
  route_id      uuid REFERENCES routes(id),
  title         text NOT NULL,
  description   text,
  status        ticket_status_t NOT NULL DEFAULT 'open',
        -- open | acknowledged | resolved | cancelled
  opened_by     uuid REFERENCES profiles(id),  -- NULL = auto-opened by the system
  opened_at     timestamptz NOT NULL DEFAULT now(),
  resolved_by   uuid REFERENCES profiles(id),
  resolved_at   timestamptz,
  resolution_note text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tickets_open ON tickets (opened_at DESC) WHERE status IN ('open','acknowledged');

CREATE TABLE ticket_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor_id   uuid REFERENCES profiles(id),
  from_status ticket_status_t,
  to_status   ticket_status_t NOT NULL,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

A ticket is a notification with a **lifecycle**. Students see it in the notification center with a live status badge that updates over SSE as the Transport Department works it — so "Bus 14 is out of commission" later becomes "Bus 14 is back in service" on the same card, rather than as a second, disconnected message.

```sql
CREATE TABLE announcements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid REFERENCES notifications(id),
  tier            smallint NOT NULL,
  audience        audience_t NOT NULL,   -- all | juniors | seniors | route | bus | custom
  audience_ref    uuid,                  -- route_id or bus_id when scoped; NULL for 'custom'
  title           text NOT NULL,
  body_md         text NOT NULL,
  attachment_path text,                  -- Supabase Storage key
  published_at    timestamptz,
  created_by      uuid NOT NULL REFERENCES profiles(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 'custom' audiences need somewhere to live; a single audience_ref uuid cannot hold a list
CREATE TABLE announcement_recipients (
  announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (announcement_id, user_id)
);
```

⚠️ `audience_t` includes `'custom'`, but `audience_ref` is a single uuid — it can name one route or one bus and cannot hold an arbitrary set of students. `announcement_recipients` is that set. It is populated at compose time from the admin console's picker, which is also what the live recipient-count preview (BUILD_PLAN Stage 7) counts. For every non-custom audience the table stays empty and the audience is resolved by query.

---

## 7. CSV roster and event-day lists

Two-phase by construction: nothing applies until a human confirms a rendered diff.

```sql
CREATE TABLE roster_uploads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          upload_kind_t NOT NULL,   -- 'student_roster' | 'event_day_buses'
  service_date  date,                     -- for event_day_buses
  cohort        cohort_t,                 -- NULL = both
  file_path     text NOT NULL,            -- Supabase Storage key
  original_name text NOT NULL,
  content_hash  text NOT NULL,            -- re-uploading identical content does NOT re-notify
  row_count     integer,
  status        upload_status_t NOT NULL DEFAULT 'pending',
        -- pending | parsed | preview_ready | applied | rejected | failed
  diff_summary  jsonb,          -- {added: 12, changed: 3, removed: 1, unchanged: 25}
  error_log     jsonb,          -- [{row: 14, column: "bus_number", message: "..."}]
  uploaded_by   uuid NOT NULL REFERENCES profiles(id),
  applied_by    uuid REFERENCES profiles(id),
  applied_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE event_day_buses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id      uuid NOT NULL REFERENCES roster_uploads(id) ON DELETE CASCADE,
  service_date   date NOT NULL,
  cohort         cohort_t NOT NULL,
  bus_id         uuid REFERENCES buses(id),
  bus_number_raw text NOT NULL,         -- as typed in the CSV, kept for the diff view
  route_id       uuid REFERENCES routes(id),
  departure_time time,
  notes          text,
  UNIQUE (service_date, cohort, bus_number_raw)
);
CREATE INDEX ON event_day_buses (service_date, cohort);
```

`content_hash` prevents the classic institutional failure: the Transport Department re-uploads the same file to "make sure it went through", and 300 students get buzzed twice.

---

## 8. Audit

```sql
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES profiles(id),
  action      text NOT NULL,       -- 'bus.status_changed', 'announcement.published', …
  entity      text NOT NULL,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  ip          inet,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (actor_id, created_at DESC);
CREATE INDEX ON audit_log (entity, entity_id, created_at DESC);
```

Written by trigger on the admin-mutable tables, so it cannot be forgotten in a code path.

⚠️ **`ip` and `user_agent` cannot be populated by the trigger on their own.** A Postgres trigger has no visibility into the HTTP request that caused the write, so these two columns will silently be `NULL` forever unless the request context is pushed down into the session first. The gateway sets them per request:

```sql
SELECT set_config('app.client_ip',  $1, true);   -- true = transaction-scoped
SELECT set_config('app.user_agent', $2, true);
```

and the trigger reads `current_setting('app.client_ip', true)`. This constrains connection handling: the settings are transaction-local, so every audited mutation must run inside a transaction that sets them, and a pooled connection must never carry them across requests. Worth getting right in Stage 4 — an audit trail with a null actor context is not an audit trail, and the whole point of §8 is that a system which can buzz 300 phones has a paper trail.

---

## 9. Row-level security

Enabled on every table. The posture is **deny by default**; each policy is additive.

```sql
-- helper, reads the role claim from the JWT
CREATE FUNCTION auth_role() RETURNS role_t LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT role FROM profiles WHERE id = auth.uid()),
    'student'::role_t
  );
$$;

CREATE FUNCTION is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT auth_role() IN ('td_admin', 'super_admin');
$$;
```

| Table | Student | TD admin |
|---|---|---|
| `profiles` | read/update own row only | read all; may not change `role` |
| `roster_students` | **no access** (leaking it exposes the student directory) | full |
| `buses`, `routes`, `stops`, `route_stops` | read non-archived | full |
| `trips` | read `status IN ('running','completed')` | full |
| `positions` | read only for trips they subscribe to, last 24 h | full |
| `favourites`, `trip_subscriptions`, `walk_eta_cache` | own rows only | no read (privacy) |
| `push_subscriptions` | own rows only | no read |
| `notification_recipients` | own rows only | aggregate counts only |
| `notifications` | read via own recipient rows | full |
| `tickets`, `ticket_events` | read open/resolved; no write | full |
| `roster_uploads`, `audit_log`, `announcement_recipients` | none | full |
| `dead_zones`, `signal_outages` | read `dead_zones` only | full |

⚠️ The ingest path, the engine workers and the notification fan-out use the **service role**, which bypasses RLS. That is correct — they are trusted server-side components — but it means *their* authorisation logic must be unit-tested, because the database will not catch their mistakes.

---

## 10. Redis key registry

Typed and centralised in `packages/redis/keys.ts`. Never construct a key string inline.

⚠️ **The SSE connection cap is tracked as per-connection keys with a TTL, not as a SET.** A SET of connection ids has no way to forget an entry: one `SIGKILL` of the gateway and every phantom id stays in it permanently, so the user hits the 3-stream cap against connections that no longer exist and cannot reconnect until someone edits Redis by hand. A key that expires unless the heartbeat renews it makes the cap self-healing, which matters because the failure mode of the alternative is "this student can never open the app again."

| Key | Type | TTL | Contents |
|---|---|---|---|
| `fleet:live` | HASH | — | `bus_id` → `{lat,lng,spd,hdg,s,seq,tripId,ts,state,cadence}` |
| `bus:{id}:hb` | STRING | 12 × cadence | heartbeat marker (belt-and-braces beside the sweeper) |
| `bus:{id}:ewma` | STRING | 1 h | EWMA speed, km/h |
| `bus:{id}:snapidx` | STRING | 1 h | last snapped vertex index (windowed search hint) |
| `trip:{id}:seq` | STRING | 12 h | highest stop index reached — monotonic |
| `trip:{id}:eta` | HASH | 5 m | `stop_id` → `{p50,p90,computedAt}` |
| `route:{id}:geom` | STRING | 24 h | packed polyline + `cumulative_dist_m` |
| `stream:pings` | STREAM | maxlen 100 k | raw validated pings; consumer groups `geo`, `persist` |
| `stream:events` | STREAM | maxlen 50 k | domain events for SSE replay (`Last-Event-ID`) |
| `sse:conn:{userId}:{connId}` | STRING | 45 s | one key per live stream, refreshed by the 15 s heartbeat; counted by `SCAN` for the 3-stream cap |
| `search:stops:{hash}` | STRING | 5 m | cached stop-search result |
| `bull:*` | — | — | BullMQ internals |

---

## 11. Enum reference

```sql
CREATE TYPE cohort_t       AS ENUM ('junior','senior');
CREATE TYPE role_t         AS ENUM ('student','driver','td_admin','super_admin');
CREATE TYPE travel_mode_t  AS ENUM ('foot','bicycle','motorbike','car');
CREATE TYPE bus_status_t   AS ENUM ('active','maintenance','out_of_commission','retired');
CREATE TYPE tracker_kind_t AS ENUM ('driver_phone','hardware');
CREATE TYPE direction_t    AS ENUM ('inbound','outbound');
CREATE TYPE route_source_t AS ENUM ('gps_survey','osrm_derived','manual_draw');
CREATE TYPE shift_t        AS ENUM ('morning','evening');
CREATE TYPE trip_status_t  AS ENUM ('scheduled','running','dark','completed','cancelled');
CREATE TYPE stop_event_t   AS ENUM ('arrived','departed','skipped');
CREATE TYPE event_source_t AS ENUM ('crossing','inferred','manual');
CREATE TYPE fav_kind_t     AS ENUM ('main','starred');
CREATE TYPE sub_state_t    AS ENUM ('active','muted','boarded','completed','missed');
CREATE TYPE notif_channel_t AS ENUM ('push','sms','inapp_only');
CREATE TYPE notif_category_t AS ENUM ('bus_activated','stop_reached','leave_now',
                                      'signal_lost','signal_restored','delay',
                                      'announcement','roster_published',
                                      'ticket_opened','ticket_resolved');
CREATE TYPE ticket_kind_t   AS ENUM ('out_of_commission','breakdown','route_change',
                                     'delay','signal_lost','other');
CREATE TYPE ticket_status_t AS ENUM ('open','acknowledged','resolved','cancelled');
CREATE TYPE audience_t      AS ENUM ('all','juniors','seniors','route','bus','custom');
CREATE TYPE upload_kind_t   AS ENUM ('student_roster','event_day_buses');
CREATE TYPE upload_status_t AS ENUM ('pending','parsed','preview_ready','applied',
                                     'rejected','failed');
```

---

## 12. Retention

| Data | Retention | Then |
|---|---|---|
| `positions` | 90 days (weekly partitions → real retention 90–97 days) | aggregated into `segment_speeds`, partition dropped |
| `trips`, `trip_stop_events` | indefinite | small, and the basis of all reporting |
| `notification_recipients` | 180 days | deleted |
| `audit_log` | 2 years | archived to Storage as Parquet |
| `claim_challenges` | 24 hours | deleted hourly by `pg_cron` |
| `signal_outages` | 1 year | retained — it is the dead-zone training set |
