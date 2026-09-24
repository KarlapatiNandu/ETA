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
-- the admin work queue: rows that cannot be claimed until the TD supplies a number
CREATE INDEX roster_missing_phone ON roster_students (roll_no)
  WHERE phone_e164 IS NULL AND claimed_at IS NULL;
```

⚠️ **`phone_e164` is nullable on purpose, and that is a concession to a risk we have already rated High.** The build plan's risk register expects the Transport Department roster to arrive late, incomplete, or without phone numbers. A `NOT NULL` column would make the *import* fail on exactly the roster we expect to receive, blocking Stage 4 entirely — when the only thing that genuinely needs a phone number is the OTP claim and the T0/T1 SMS fallback. So: import accepts rows without a phone; **claiming requires one**. Students missing a number are surfaced in the admin console as a work queue for the TD to fill in, and the fallback claim channel (admin-created accounts for the pilot cohort) covers the rest.

**`cohort` is recomputed, not frozen.** A nightly job promotes `junior → senior` at the start of each academic year based on `admission_year`. Storing the derived value keeps the notification audience query a simple indexed lookup instead of a date calculation across 300 rows on every send.

The rule lives in exactly one place, the SQL function `derive_cohort(admission_year, as_of, academic_year_start_month DEFAULT 8, junior_max_year DEFAULT 1)`. Both the roster import and `promote_cohorts(as_of DEFAULT operating_date())` call it. `promote_cohorts` is idempotent and scheduled daily by `pg_cron` at 00:05 IST, so it only changes rows on the boundary day. The defaults (the year starts 1 August, and only first-years are juniors) are a **working assumption pending TD confirmation**. Changing the rule means changing those two defaults and nothing else. `operating_date()` is today in `Asia/Kolkata`.

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

The migration also adds range `CHECK`s the DDL above omits: `max_tier` 0–4, `quiet_start_min` 0–1439, `quiet_duration_min` 1–1440 and `default_buffer_s` 0–3600. Students write these columns directly under RLS, so the database has to validate them.

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
  roll_no       text NOT NULL,          -- no FK on purpose: rows exist for unknown roll numbers too
  purpose       challenge_purpose_t NOT NULL DEFAULT 'claim',  -- 'claim' | 'recover'
  otp_hash      text NOT NULL,          -- bcrypt; never store the code itself
  attempts      smallint NOT NULL DEFAULT 0,
  expires_at    timestamptz NOT NULL,   -- now() + 10 min
  locked_until  timestamptz,            -- set on the 5th failed attempt: now() + 30 min
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON claim_challenges (roll_no, expires_at DESC);
```

Rate limit: 3 challenges per roll number per hour, 5 OTP attempts per challenge, then lock out for 30 minutes (`locked_until`). Password recovery reuses the table with `purpose = 'recover'`.

⚠️ **Every start request inserts a challenge, including requests for roll numbers that are not on the roster.** Those rows hold the bcrypt hash of a code nobody receives. This is what makes the enumeration defence structural rather than cosmetic. A real roll and a fake one do the same work, get the same response shape, and hit the same rate limit and lockout at the same moment. Counting only real challenges would make the fourth request a 429 for real rolls and a 200 for fake ones, which leaks the roster one request at a time. See `vault/decisions/ADR-0006-uniform-claim-responses.md`.

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
  driver_id       uuid REFERENCES drivers(id),   -- the bus's regular driver (0007)
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
  secret_prev_enc bytea,                  -- the previous secret, during the rotation overlap
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

Rotation issues a fresh secret, returns it exactly once to the device being provisioned, moves the old one to `secret_prev_enc` and sets `secret_rotated_at`. Both secrets verify for a 10-minute overlap so a rotation cannot brick a bus mid-route — which is why the old one has to be *kept*, not merely allowed. The gateway caches decrypted secrets for 60 s and serves that cache when Postgres is unreachable (ARCH §11), so a rotation or a revocation takes effect within a minute rather than instantly; that is the price of ingest surviving a database outage.

`cadence_s` is the tracker's current reporting interval, echoed in every `PingBatch` and copied into `fleet:live`. The presence sweeper derives `DEGRADED` / `DARK` thresholds from it (ARCHITECTURE §5.7) rather than from absolute seconds.

`kind` is the seam that lets Stage 9 swap driver phones for wired hardware **without touching the ingest contract** — only the adapter in front of it changes.

```sql
-- migration 0007 (Stage 7): the bus's regular driver, as the Transport Department knows them
CREATE TABLE drivers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   text NOT NULL,          -- CHECK 1–120 characters
  phone_e164  text,                   -- CHECK '^\+91[6-9][0-9]{9}$'
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

A driver is **not a login**. Trackers authenticate the phone (ARCH §10), `trips.driver_id` stays reserved for a driver *account* should one ever exist, and a driver is linked to a bus, never to its positions — driver location is fleet data, not personal tracking. The phone number is a member of staff's, so the table is admin-only under RLS.

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

**Trigrams alone are not enough for Hyderabad names**, which are typed the way they sound and romanised several ways at once. Plain trigram similarity ranks "kothi" nearer "Kothapet" than "Koti". Migration `0006` therefore adds `fold_place(text)`, an `IMMUTABLE` phonetic key. It lower-cases, drops the `h` of aspirates (`kh th dh ph bh gh ch jh sh`), folds `ee`/`ii` to `i` and `oo`/`uu` to `u`, and collapses doubled letters. Search scores every field on its spelling *and* on its fold, and takes the better. "Dilshuknagar", "Kothi" and "Amirpet" then fold to the same key as the stop they mean. At a few hundred stops the scan needs no index on the fold; add a trigram index on `fold_place(name)` if stops ever number in the thousands.

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

### `route_surveys` — where a route comes from

There is no route geometry to import: it is captured by driving each route once with the driver
app in survey mode (BUILD_PLAN Stage 1). The raw trace is uploaded untouched and kept, so a
route can be re-matched later without driving it again.

```sql
CREATE TABLE route_surveys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracker_id   uuid NOT NULL REFERENCES trackers(id),  -- signed upload: the paired phone
  bus_id       uuid REFERENCES buses(id),
  label        text,                     -- what the surveyor typed on the phone
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz NOT NULL,
  point_count  integer NOT NULL,
  file_path    text NOT NULL,            -- raw 1 Hz trace, Storage bucket `route-surveys`
  status       survey_status_t NOT NULL DEFAULT 'uploaded',  -- uploaded | matched | discarded
  route_id     uuid REFERENCES routes(id),  -- the draft the pipeline produced
  match_report jsonb,                    -- {inputPoints, chunks, gaps, matchedPct, lengthM, …}
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON route_surveys (created_at DESC);
```

The trace itself lives in Storage rather than in a column: it is 2,000–3,000 points of raw GPS
for a 45-minute route, it is written once and read once, and keeping it out of the row keeps
`route_surveys` cheap to list in the admin console. `match_report.gaps` counts joins where two
matched chunks had no commonly matched point — the seams an admin should look at before
publishing.

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
CREATE INDEX ON signal_outages (trip_id);
-- one open outage per trip: a sweeper restarted mid-outage finds it instead of opening a second
CREATE UNIQUE INDEX one_open_outage ON signal_outages (trip_id) WHERE recovered_at IS NULL;
```

Migration `0005_live_delivery` also adds `CHECK (confidence BETWEEN 0 AND 1)` on `dead_zones`. The presence sweeper opens a `signal_outages` row when a bus goes DARK, with `started_at` set to the **last fix before the silence** rather than the moment the sweeper noticed, and closes it with an exit point when the bus reports again. `dead_zone_id` is set when the entry point falls inside a learned zone.

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

**Weekly partitions**, created ahead by a `pg_cron` job (`ensure_positions_partitions(weeks_back, weeks_ahead)`, two weeks back and eight ahead, daily at 01:00 IST), dropped once fully older than 90 days (aggregated into `segment_speeds` first) by `drop_expired_positions_partitions(retention)`. ⚠️ **The drop function exists but is deliberately not scheduled until Stage 5**, because the aggregation it depends on is built there; scheduling it first would delete history nothing had learned from yet.

⚠️ **Every partition is its own table, and RLS does not reach it from the parent.** A client with a grant on `positions_p20260921` can read it directly and bypass every policy on `positions`. The maintenance function therefore enables RLS and revokes all client privileges on each partition as it creates it, and the RLS suite fails if any partition ever carries a grant. Monthly partitions would be the obvious choice at this volume, but a partition can only be dropped when its *newest* row is past retention — so monthly buckets mean data actually lives 90–120 days, and the retention promise in §12 (and the privacy commitment in ARCHITECTURE §10, which drivers are told about out loud) would be quietly wrong by up to a month. Weekly buckets hold the real retention to 90–97 days. At ~86 k rows/day each partition is ~600 k rows, which is still nothing.

The unique index on `(trip_id, recorded_at)` is the ingest idempotency guarantee — a tracker that retries a batch after a timeout cannot create duplicates. Note that it includes `recorded_at`, the partition key, because a unique index on a partitioned table must.

⚠️ **`COPY` cannot enforce that index gracefully, and the persister must be built around this.** `COPY` has no `ON CONFLICT` clause: a single duplicate row aborts the entire batch transaction, so the naive "batch 200 rows and `COPY` them in" design fails the first time a tracker retries — which is a designed-for, everyday event, not an anomaly. The persister therefore:

```
CREATE TEMP TABLE positions_staging (…) ON COMMIT DROP
COPY batch → positions_staging
INSERT INTO positions SELECT … FROM positions_staging
  ON CONFLICT (trip_id, recorded_at) DO NOTHING
```

The staging table is **transaction-scoped and temporary** rather than one shared unlogged table.
A temp table is unlogged by definition and gives the same throughput, and it removes the
question of what two persister processes do to each other's rows between `COPY` and `TRUNCATE`.
It is dropped at commit, so a crash mid-batch leaves nothing behind.

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
  weekday       smallint,              -- 0..6 the day (0 Sunday); 7 any weekday, 8 weekend; NULL = any day
  tod_bucket    smallint,              -- 15-minute bucket 0..95 (IST); NULL = aggregated
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

**As built (migration `0006`).** The four rungs written are exactly the ARCH §5.5 ladder: `(day, tod)`, `(weekday class, tod)`, `(tod)` and `(any)`. The weekday class has no column of its own, so it is stored in `weekday` as **7 (Monday–Friday) or 8 (Saturday–Sunday)**; `CHECK (weekday BETWEEN 0 AND 8)` and `CHECK (tod_bucket BETWEEN 0 AND 95)` hold the encoding. A sample is two consecutive fixes of one trip, at most 60 s apart, that made at least 1 m of forward progress, attributed to the 200 m segment of their midpoint. Standing still is excluded, because dwell is modelled separately (`route_stops.expected_dwell_s`) and counting it here would charge every stop twice. Samples above 100 km/h are GPS spikes and are dropped.

Merging a new night into existing rows weights each statistic by sample count. That is exact for the first night and an **approximation** of the true median after it, which is the price of not keeping raw samples beyond the 90-day retention. Idempotency per day is a ledger, not care:

```sql
CREATE TABLE segment_speed_runs (
  service_date date PRIMARY KEY,   -- a day is aggregated once, however often the job runs
  samples      integer NOT NULL DEFAULT 0,
  ran_at       timestamptz NOT NULL DEFAULT now()
);
```

`aggregate_segment_speeds(day)` does one day. `aggregate_segment_speeds_catchup(days DEFAULT 14)` does every unaggregated day of the last fortnight, and is what `pg_cron` runs at 01:30 IST. A job that fails for three nights catches up on the fourth instead of leaving holes. `drop_expired_positions_partitions()` is now scheduled at 02:00 IST (it waited for this aggregation, see above), and 90-day retention leaves 76 days of margin over the catch-up window.

```sql
CREATE TABLE eta_predictions (
  trip_id              uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  seq                  smallint NOT NULL,
  stop_id              uuid NOT NULL REFERENCES stops(id),
  horizon_s            integer NOT NULL,   -- 600 / 300 / 120
  predicted_at         timestamptz NOT NULL,
  p50_s                integer NOT NULL,
  p90_s                integer NOT NULL,
  confidence           text NOT NULL,
  rung                 smallint,           -- v_hist rung used (1 exact … 4 any); NULL = cold start
  predicted_arrival_at timestamptz NOT NULL,
  actual_arrival_at    timestamptz,        -- from trip_stop_events
  error_s              integer GENERATED ALWAYS AS
                         (EXTRACT(epoch FROM actual_arrival_at - predicted_arrival_at)::integer) STORED,
  PRIMARY KEY (trip_id, seq, horizon_s)
);
```

`eta_predictions` is the evidence for the Stage 5 accuracy gate ("MAE under 90 s at a 10-minute horizon"). The ETA worker logs one prediction per stop as its p50 enters each horizon bucket `(H − 60, H]`. The stop-events worker fills `actual_arrival_at` when the arrival is recorded. MAE at the 10-minute horizon is `avg(abs(error_s)) WHERE horizon_s = 600`. It is kept indefinitely: a row per stop per trip is small, and it is the only record of how good the product's central number has been.

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

**Created by migration `0007` (Stage 7), not Stage 6.** The admin console's audience preview counts "everyone connected to Bus 14" — the students who favourited it plus those following its trip today — so the table had to exist before the starring UI does. `0007` also indexes `favourites (bus_id)` for that count. It is not audited: a student's own favourites are not an admin action.

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

**The database keeps both promises about the pin (migration `0006`).** A `BEFORE` trigger on `profiles` rounds `home_location` to three decimal places, about 111 m of latitude and 106 m of longitude at Hyderabad, whoever writes it. No client, bug or future code path can store a student's exact front door. An `AFTER UPDATE OF home_location, travel_mode` trigger empties the student's `walk_eta_cache`, so a moved pin can never serve a stale walk. `trip_subscriptions` also gains `CHECK`s on `travel_time_s >= 0` and `buffer_s BETWEEN 0 AND 3600`. Travel time by mode is: `foot` from OSRM foot; `bicycle` as the foot route's distance at 15 km/h (there is no bicycle graph); `motorbike` and `car` from OSRM car, which is free-flow and therefore optimistic in traffic.

---

## 6. Notifications and tickets

```sql
CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key   text NOT NULL UNIQUE,     -- what caused it: 'announcement:<id>', 'stop:<trip>:<seq>:arrived'… (0008)
  tier         smallint NOT NULL,        -- 0 CRITICAL … 4 AMBIENT
  category     notif_category_t NOT NULL,
        -- bus_activated | stop_reached | leave_now | signal_lost | signal_restored
        -- | delay | announcement | roster_published | ticket_opened | ticket_resolved
  title        text NOT NULL,
  body         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  collapse_tag text,                     -- Web Push `tag`; T3 progress updates share one
  bus_id       uuid REFERENCES buses(id),
  trip_id      uuid REFERENCES trips(id) ON DELETE SET NULL,
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
  deliver_after   timestamptz NOT NULL DEFAULT now(),  -- quiet hours defer the transport (0008)
  sent_at         timestamptz,       -- claimed for transport, compare-and-set on NULL (0008)
  delivered_at    timestamptz,       -- push service accepted it / SMS provider receipt
  read_at         timestamptz,
  acknowledged_at timestamptz,       -- T0 requires this
  failure_reason  text,
  provider_ref    text,              -- MSG91 request id, matched by the receipt webhook (0008)
  PRIMARY KEY (notification_id, user_id)
);
CREATE UNIQUE INDEX notif_dedupe ON notification_recipients (dedupe_key);
CREATE INDEX notif_unread ON notification_recipients (user_id, queued_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX notif_user ON notification_recipients (user_id, queued_at DESC);
-- the notify worker's queue
CREATE INDEX notif_pending ON notification_recipients (deliver_after) WHERE sent_at IS NULL;
```

`notif_dedupe` is the guarantee described in ARCHITECTURE §6.2 — **the database, not the worker, is what makes double-notification impossible.**

**As built (migration `0008`, Stage 6).** Both halves of the advice below are taken: the parent and every recipient row are written in one transaction, *and* the parent has an idempotency key, `source_key`, so a replayed or retried event finds its notification instead of creating a second one. Three columns make the transport at-most-once: a recipient row is written with `sent_at` NULL, the worker claims due rows with `UPDATE … SET sent_at = now() WHERE sent_at IS NULL` (so no row is ever claimed twice), and only then sends. A student suppressed by a filter (kill switch, "not today", `max_tier`, or an event too old to be news) gets their row with `channel = 'inapp_only'` and the reason in `failure_reason`, already claimed — the center is written, nothing is sent. Quiet hours set `deliver_after` to the end of the window instead. `provider_ref` holds MSG91's request id for the delivery-receipt webhook.

`notification_delivery(notification_id)` is a `SECURITY DEFINER` function returning counts only (recipients, pushed, texted, in-app only, pending, read, acknowledged), for admins; it returns zeros to anyone else. Retention (§12) is a `pg_cron` job at 03:00 IST.

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
  backoff_until timestamptz,        -- after a 429 from the push service (0008)
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
  assigned_to   uuid REFERENCES profiles(id),  -- the admin working it (0007)
  opened_by     uuid REFERENCES profiles(id),  -- NULL = auto-opened by the system
  opened_at     timestamptz NOT NULL DEFAULT now(),
  resolved_by   uuid REFERENCES profiles(id),
  resolved_at   timestamptz,
  resolution_note text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tickets_open ON tickets (opened_at DESC) WHERE status IN ('open','acknowledged');
-- a bus is out of commission once: a double click or a second admin finds the open ticket
CREATE UNIQUE INDEX one_open_commission_ticket ON tickets (bus_id)
  WHERE kind = 'out_of_commission' AND status IN ('open','acknowledged');
-- one automatic signal-loss ticket per trip, however many sweeps see the outage
CREATE UNIQUE INDEX one_open_signal_ticket ON tickets (trip_id)
  WHERE kind = 'signal_lost' AND status IN ('open','acknowledged');

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

`severity` has `CHECK (severity BETWEEN 0 AND 4)`. Transitions are compare-and-set on the current status, and every transition writes a `ticket_events` row, so the timeline is complete and two admins clicking at once produce one transition and one conflict. An out-of-commission ticket can only be *resolved* (never cancelled): resolving it returns the bus to `active` and tells the same students "back in service" (T2) — cancelling would leave them believing the bus is still out.

A ticket is a notification with a **lifecycle**. Students see it in the notification center with a live status badge that updates over SSE as the Transport Department works it — so "Bus 14 is out of commission" later becomes "Bus 14 is back in service" on the same card, rather than as a second, disconnected message.

```sql
CREATE TABLE announcements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid REFERENCES notifications(id),
  tier            smallint NOT NULL,
  audience        audience_t NOT NULL,   -- all | juniors | seniors | route | bus | custom
  audience_ref    uuid,                  -- route_id or bus_id when scoped; NULL for 'custom'
  title           text NOT NULL,         -- CHECK 1–80 characters
  body_md         text NOT NULL,         -- CHECK 1–2000 characters
  attachment_path text,                  -- Supabase Storage key
  confirmed_count integer NOT NULL,      -- the recipient count the admin confirmed (0007)
  scheduled_for   timestamptz,           -- NULL = sent on confirm (0007)
  published_at    timestamptz,           -- when it was actually sent; NULL while scheduled
  cancelled_at    timestamptz,           -- a scheduled announcement withdrawn (0007)
  created_by      uuid NOT NULL REFERENCES profiles(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((audience IN ('route','bus')) = (audience_ref IS NOT NULL)),
  CHECK (published_at IS NULL OR cancelled_at IS NULL)
);
-- the scheduler's queue
CREATE INDEX announcements_due ON announcements (scheduled_for)
  WHERE published_at IS NULL AND cancelled_at IS NULL;

-- 'custom' audiences need somewhere to live; a single audience_ref uuid cannot hold a list
CREATE TABLE announcement_recipients (
  announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (announcement_id, user_id)
);
```

⚠️ `audience_t` includes `'custom'`, but `audience_ref` is a single uuid — it can name one route or one bus and cannot hold an arbitrary set of students. `announcement_recipients` is that set. It is populated at compose time from the admin console's picker, which is also what the live recipient-count preview (BUILD_PLAN Stage 7) counts. For every non-custom audience the table stays empty and the audience is resolved by query.

**As built (0007).** `notification_id` has no foreign key yet: `notifications` is Stage 6, and migration `0008` adds the constraint. `confirmed_count` records the number on the confirmation dialog; the gateway re-resolves the audience when the admin confirms and refuses if it has moved (ARCHITECTURE §6.3). A scheduled announcement is sent by the engine's scheduler (`workers/announcements.ts`) as a compare-and-set on `published_at IS NULL`, so it is published at most once and a cancel that races it either wins or is refused. For a scheduled cohort, route or bus audience the recipients are resolved at send time, not at confirm time; a custom list is frozen in `announcement_recipients` at confirm time.

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

**As built (0007).** `event_day_buses` holds only *applied* rows — a preview is computed from the uploaded file and never written — so students may read it under RLS. An upload replaces the list for the date **for the cohorts its rows mention**; a seniors-only file leaves the juniors' list alone. Removals are real (a bus off an event-day list is a bus not running for that cohort), unlike the roster, where uploads never delete. Unchanged rows are not rewritten, so an identical apply writes nothing to `audit_log`. Applying cancels any `scheduled`, never-started trip of an affected bus that the list no longer backs. The engine's `workers/schedule.ts` turns *today's* rows into `scheduled` trips with `scheduled_start_at`, one per bus at a time (`one_live_trip` counts scheduled trips), on the service day only — a trip scheduled for tomorrow would be resumed by today's START.

`content_hash` prevents the classic institutional failure: the Transport Department re-uploads the same file to "make sure it went through", and 300 students get buzzed twice. As built, two things stop it: the preview says the file is identical to one already applied (by `content_hash`), and an apply notifies only the cohorts whose list actually changed — an identical file changes nothing and notifies nobody.

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

The trigger function is `audit_row()`. Columns named as its trigger arguments are dropped from `before`/`after`. `profiles` redacts `home_location` and `home_label`, because admins can read the audit log and must never see a student's pinned home (ARCH §10). A student updating their own preferences is not an admin action and is not audited. The actor is `auth.uid()` for client calls, or `app.actor_id` when the gateway acts through the service role on an admin's behalf.

⚠️ **`ip` and `user_agent` cannot be populated by the trigger on their own.** A Postgres trigger has no visibility into the HTTP request that caused the write, so these two columns will silently be `NULL` forever unless the request context is pushed down into the session first. The gateway sets them per request:

```sql
SELECT set_config('app.actor_id',   $1, true);   -- true = transaction-scoped
SELECT set_config('app.client_ip',  $2, true);
SELECT set_config('app.user_agent', $3, true);
```

and the trigger reads `current_setting('app.client_ip', true)`. This constrains connection handling: the settings are transaction-local, so every audited mutation must run inside a transaction that sets them, and a pooled connection must never carry them across requests. Worth getting right in Stage 4 — an audit trail with a null actor context is not an audit trail, and the whole point of §8 is that a system which can buzz 300 phones has a paper trail.

---

## 9. Row-level security

Enabled on every table. The posture is **deny by default**; each policy is additive.

```sql
-- helper: the caller's role, read from profiles (not the JWT) so a demotion is immediate
CREATE FUNCTION auth_role() RETURNS role_t
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(
    (SELECT role FROM profiles WHERE id = auth.uid()),
    'student'::role_t
  );
$$;

CREATE FUNCTION is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth_role() IN ('td_admin', 'super_admin');
$$;
```

⚠️ **`SECURITY DEFINER` is required.** The `profiles` policy calls `is_admin()`, which reads `profiles`. As `SECURITY INVOKER`, that read re-enters the `profiles` policy and Postgres aborts every query with *infinite recursion detected in policy for relation "profiles"*. The earlier draft of this section had exactly that bug.

**The role is also a JWT claim.** `custom_access_token_hook(event jsonb)` is registered as Supabase's custom access token hook and stamps `user_role` into every token, so the gateway and the web middleware can gate routes without a query. RLS still reads `profiles`. The claim is advisory; the database is the boundary.

**Column-level grants back up the policies.** Supabase grants every privilege on new tables to `anon` and `authenticated`, so each migration first revokes them all and then grants back only what the policies need. On `profiles`, `authenticated` may UPDATE only the preference columns (`home_location`, `home_label`, `travel_mode`, `alerts_paused_until`, `max_tier`, `critical_breakthrough`, `quiet_*`, `default_buffer_s`). Nobody, student or admin, can change `role`, `roll_no`, `cohort` or `phone_e164` through the API. Role changes are a service-role operation.

| Table | Student | TD admin |
|---|---|---|
| `profiles` | read own row; update own preference columns only | read all; may not change `role` (nor edit a student's preferences) |
| `roster_students` | **no access** (leaking it exposes the student directory) | full |
| `buses`, `stops`, `route_stops` | read non-archived | full |
| `routes` | read **published** and non-archived versions only (drafts are not public) | full |
| `trackers` | none | read the non-secret columns only; `secret_enc`/`secret_prev_enc` are revoked from every client role, and provisioning and rotation are service-role operations |
| `route_surveys` | none | full |
| `trips` | read `status IN ('running','completed')` | full |
| `trip_stop_events` | read those of a visible trip | full |
| `positions` | read only for trips they subscribe to, last 24 h (`positions_subscriber_read`, migration 0006) | full |
| `favourites`, `trip_subscriptions`, `walk_eta_cache` | own rows only | no read (privacy — the audience preview is computed server-side and returns a count, never a list) |
| `push_subscriptions` | own rows only (select / insert / delete) | no read |
| `notification_recipients` | own rows only; may update `read_at`, `acknowledged_at` and nothing else | no read — counts via `notification_delivery()` |
| `notifications` | read via own recipient rows | full |
| `tickets`, `ticket_events` | read every ticket that is not cancelled; no write | full |
| `announcements` | none (students receive them as notifications) | full |
| `event_day_buses` | read (only applied lists are stored) | full |
| `drivers` | none | full |
| `roster_uploads`, `audit_log`, `announcement_recipients` | none | full (`audit_log`: read only; written by trigger) |
| `claim_challenges` | none | none — service role only (RLS on, zero policies, no grants) |
| `dead_zones`, `signal_outages` | read `dead_zones` only | full |
| `segment_speeds`, `segment_speed_runs`, `eta_predictions` | none | read only (written by the engine and `pg_cron`) |

⚠️ The ingest path, the engine workers and the notification fan-out use the **service role**, which bypasses RLS. That is correct — they are trusted server-side components — but it means *their* authorisation logic must be unit-tested, because the database will not catch their mistakes.

---

## 10. Redis key registry

Typed and centralised in `packages/redis/keys.ts`. Never construct a key string inline.

⚠️ **The SSE connection cap is tracked as per-connection keys with a TTL, not as a SET.** A SET of connection ids has no way to forget an entry: one `SIGKILL` of the gateway and every phantom id stays in it permanently, so the user hits the 3-stream cap against connections that no longer exist and cannot reconnect until someone edits Redis by hand. A key that expires unless the heartbeat renews it makes the cap self-healing, which matters because the failure mode of the alternative is "this student can never open the app again."

| Key | Type | TTL | Contents |
|---|---|---|---|
| `fleet:live` | HASH | — | `bus_id` → `{lat,lng,spd,hdg,s,seq,tripId,routeId,ts,state,cadence,flag,deadZone}`. `flag` is `off_route`, `resnapped`, `trip_end`, `dark_timeout` or `rehydrated` |
| `bus:{id}:hb` | STRING | 12 × cadence | heartbeat marker (belt-and-braces beside the sweeper) |
| `bus:{id}:ewma` | STRING | 1 h | EWMA speed, km/h |
| `bus:{id}:snapidx` | STRING | 1 h | last snapped vertex index (windowed search hint) |
| `trip:{id}:seq` | STRING | 12 h | highest stop index reached — monotonic |
| `trip:{id}:eta` | HASH | 5 m | `stop_id` → `{p50,p90,confidence,at,rung}`; `at` is the fix the prediction starts from, so the remaining time is `p50 − (now − at)`. Stops the bus has passed are removed, and the whole hash is deleted when the bus goes DARK, ENDED or off-route |
| `trip:{id}:geo` | STRING | 12 h | the geo worker's per-trip state (offset, snap hint, backward run, crossing state) — in Redis, not in worker memory, so a restarted worker resumes mid-trip |
| `route:{id}:geom` | STRING | 24 h | packed polyline + `cumulative_dist_m` |
| `stream:pings` | STREAM | maxlen 100 k | raw validated pings; consumer groups `geo`, `persist` |
| `stream:pings:dead` | STREAM | maxlen 10 k | pings the persister could not write even one row at a time, with the reason — a human queue, never retried automatically |
| `bus:{id}:outage` | STRING | 12 h | the bus's open `signal_outages` row: `{tripId, id, startedAt, lat, lng, deadZoneId}`. `id` is null while Postgres was unreachable; the sweeper retries the insert |
| `stream:events` | STREAM | maxlen 50 k | broadcast-class events (`bus.position`, `bus.status`, `stop.reached`) for SSE fan-out and `Last-Event-ID` replay. Consumer groups: `stop-events` writes `trip_stop_events` (and fills `eta_predictions.actual_arrival_at`); `eta` computes per-stop ETAs from every position |
| `sse:conn:{userId}:{connId}` | STRING | 45 s | one key per live stream, refreshed by the 15 s heartbeat; counted by `SCAN` for the 3-stream cap. Value `{inst, focus}`: the gateway instance holding it (reclaimed at that instance's boot) and the connection's focus (`bbox`, `busIds`) |
| `ingest:nonce:{signature}` | STRING | 10 m | one key per accepted tracker request: replaying the exact bytes is refused. Set only *after* the signature verifies, so forged requests cannot fill it |
| `ratelimit:ingest:{device}:{minute}` | STRING | 2 m | per-device ingest counter (120 requests/min: 12 at a 5 s cadence, plus reconnect flushes) |
| `ratelimit:http:*` | — | per rule | `@fastify/rate-limit`'s store for the auth endpoints, so per-IP limits hold across gateway instances |
| `search:stops:{hash}` | STRING | 5 m | cached stop-search *matching* (which stops, how they matched, the anchor). The buses and ETAs are joined fresh on every request: a five-minute-old ETA is not an ETA |
| `route:{id}:osrm` | STRING | 24 h | OSRM free-flow km/h per 200 m segment of a route version (`v_osrm`, ARCH §5.5) |
| `pubsub:notify` | PUB/SUB | — | per-user `notification` and `ticket.update` frames from the notify worker to the gateway, `{userIds, frame}` (Stage 6). Never replayed: the center is re-read on connect |
| `pubsub:eta` | PUB/SUB | — | ETA changes from the engine to the gateway's per-user `eta.update` frames. Pub/sub, not a stream: per-user frames are re-derived from `trip:{id}:eta`, never replayed |
| `stream:notify` | STREAM | maxlen 10 k | domain events for the notification spine: `leave_now` (Stage 5), the admin console's doorbells `announcement`, `ticket` (opened / resolved) and `event_day` (Stage 7), and `trip_start` from the driver's START (Stage 6) — each names a committed row the notify worker reads the truth from. Consumer group `notify` (Stage 6), which also reads `stream:events` for stop progress and signal alerts. They name a student or an admin action, so they never go on `stream:events` |
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
CREATE TYPE challenge_purpose_t AS ENUM ('claim','recover');
CREATE TYPE survey_status_t AS ENUM ('uploaded','matched','discarded');
```

---

## 12. Retention

| Data | Retention | Then |
|---|---|---|
| `positions` | 90 days (weekly partitions → real retention 90–97 days) | aggregated into `segment_speeds`, partition dropped |
| `trips`, `trip_stop_events` | indefinite | small, and the basis of all reporting |
| `segment_speeds`, `eta_predictions` | indefinite | the learned model and its measured accuracy |
| `walk_eta_cache` | refreshed after 24 h | emptied on pin or mode change |
| `notification_recipients` | 180 days | deleted |
| `audit_log` | 2 years | archived to Storage as Parquet |
| `claim_challenges` | 24 hours | deleted hourly by `pg_cron` |
| `signal_outages` | 1 year | retained — it is the dead-zone training set |
