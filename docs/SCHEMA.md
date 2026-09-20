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

---

## 1. Identity and roster

Sign-in is **roll number + password, seeded from a Transport Department roster**. The roster is the allowlist: nobody who is not on it can create an account.

### `roster_students` — the allowlist

```sql
CREATE TABLE roster_students (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  roll_no         text NOT NULL UNIQUE,
  full_name       text NOT NULL,
  admission_year  smallint NOT NULL,
  cohort          cohort_t NOT NULL,          -- 'junior' | 'senior'
  phone_e164      text NOT NULL,              -- +91XXXXXXXXXX, required for SMS fallback
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
  min_tier               smallint NOT NULL DEFAULT 3,  -- suppress tiers numerically above this
  critical_breakthrough  boolean NOT NULL DEFAULT true, -- T0 ignores the kill switch
  quiet_hours            int4range,            -- minutes from local midnight, NULL = none
  default_buffer_s       integer NOT NULL DEFAULT 180,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON profiles (role) WHERE role <> 'student';
CREATE INDEX ON profiles (cohort);
CREATE INDEX ON profiles USING GIST (home_location);
```

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
  secret_hash   text NOT NULL,            -- bcrypt of the HMAC shared secret
  secret_rotated_at timestamptz,
  firmware      text,
  last_seen_at  timestamptz,
  battery_pct   smallint,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON trackers (bus_id) WHERE bus_id IS NOT NULL;
```

`kind` is the seam that lets Stage 9 swap driver phones for wired hardware **without touching the ingest contract** — only the adapter in front of it changes.

---

## 3. Geography

### `routes`

```sql
CREATE TABLE routes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
```

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
  PRIMARY KEY (route_id, seq),
  UNIQUE (route_id, stop_id)
);
```

`cumulative_dist_m` is the single number the entire arrival algorithm runs on. It is computed at route-publish time by projecting each stop onto the route geometry.

### `dead_zones` — learned, not configured

```sql
CREATE TABLE dead_zones (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  polygon          geography(Polygon, 4326) NOT NULL,
  route_id         uuid REFERENCES routes(id),
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
  status        trip_status_t NOT NULL DEFAULT 'scheduled',
        -- scheduled | running | dark | completed | cancelled
  started_at    timestamptz,
  ended_at      timestamptz,
  last_offset_m double precision,          -- s: progress along the route
  last_seq      smallint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bus_id, service_date, shift)
);
CREATE INDEX ON trips (service_date, status);
CREATE INDEX trips_running ON trips (bus_id) WHERE status = 'running';
```

That `UNIQUE (bus_id, service_date, shift)` is doing real work: it makes trip creation idempotent. A driver who force-quits and reopens the app resumes the same trip rather than starting a duplicate.

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

**Monthly partitions**, created ahead by a `pg_cron` job, dropped after 90 days (aggregated into `segment_speeds` first). At ~86 k rows/day this keeps every partition comfortably small and makes retention a metadata operation rather than a mass `DELETE`.

The unique index on `(trip_id, recorded_at)` is the ingest idempotency guarantee — a tracker that retries a batch after a timeout cannot create duplicates.

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
  UNIQUE (trip_id, stop_id, event)      -- the idempotency backstop
);

CREATE TABLE segment_speeds (
  route_id      uuid NOT NULL REFERENCES routes(id),
  segment_idx   integer NOT NULL,      -- 200 m bucket index along the route
  weekday       smallint NOT NULL,     -- 0..6
  tod_bucket    smallint NOT NULL,     -- 15-minute bucket, 0..95
  median_kmh    real NOT NULL,
  p10_kmh       real NOT NULL,
  p90_kmh       real NOT NULL,
  sample_count  integer NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (route_id, segment_idx, weekday, tod_bucket)
);
```

`segment_speeds` is the learned traffic model — rebuilt nightly from `positions` before the raw rows are aged out. It is what turns a cold-start OSRM guess into an ETA that knows the Dilsukhnagar junction crawls at 6 p.m. on weekdays.

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
        -- | announcement | roster_published | ticket_opened | ticket_resolved
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
  resolution_note text
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
  audience_ref    uuid,                  -- route_id or bus_id when scoped
  title           text NOT NULL,
  body_md         text NOT NULL,
  attachment_path text,                  -- Supabase Storage key
  published_at    timestamptz,
  created_by      uuid NOT NULL REFERENCES profiles(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

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
| `roster_uploads`, `audit_log` | none | full |
| `dead_zones`, `signal_outages` | read `dead_zones` only | full |

⚠️ The ingest path, the engine workers and the notification fan-out use the **service role**, which bypasses RLS. That is correct — they are trusted server-side components — but it means *their* authorisation logic must be unit-tested, because the database will not catch their mistakes.

---

## 10. Redis key registry

Typed and centralised in `packages/redis/keys.ts`. Never construct a key string inline.

| Key | Type | TTL | Contents |
|---|---|---|---|
| `fleet:live` | HASH | — | `bus_id` → `{lat,lng,spd,hdg,s,seq,tripId,ts,state}` |
| `bus:{id}:hb` | STRING | 90 s | heartbeat marker (belt-and-braces beside the sweeper) |
| `bus:{id}:ewma` | STRING | 1 h | EWMA speed, km/h |
| `bus:{id}:snapidx` | STRING | 1 h | last snapped vertex index (windowed search hint) |
| `trip:{id}:seq` | STRING | 12 h | highest stop index reached — monotonic |
| `trip:{id}:eta` | HASH | 5 m | `stop_id` → `{p50,p90,computedAt}` |
| `route:{id}:geom` | STRING | 24 h | packed polyline + `cumulative_dist_m` |
| `stream:pings` | STREAM | maxlen 100 k | raw validated pings; consumer groups `geo`, `persist` |
| `stream:events` | STREAM | maxlen 50 k | domain events for SSE replay (`Last-Event-ID`) |
| `sse:user:{id}` | SET | — | active connection ids (3-stream cap) |
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
                                      'signal_lost','signal_restored','announcement',
                                      'roster_published','ticket_opened','ticket_resolved');
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
| `positions` | 90 days | aggregated into `segment_speeds`, partition dropped |
| `trips`, `trip_stop_events` | indefinite | small, and the basis of all reporting |
| `notification_recipients` | 180 days | deleted |
| `audit_log` | 2 years | archived to Storage as Parquet |
| `claim_challenges` | 24 hours | deleted hourly by `pg_cron` |
| `signal_outages` | 1 year | retained — it is the dead-zone training set |
