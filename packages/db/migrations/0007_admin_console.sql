-- 0007 — Stage 7, the admin console (SCHEMA §2 drivers, §5 favourites, §6 tickets and
-- announcements, §7 event-day lists).
--
-- `favourites` belongs to the student's side (Stage 6 builds the starring UI), but it lands here
-- because the admin console's audience preview counts it: "everyone connected to Bus 14" is the
-- students who favourited Bus 14 plus those following its trip today. One resolver serves both
-- the preview count and the fan-out, so the number the TD confirms is the number that buzzes.
--
-- announcements.notification_id has no foreign key yet: `notifications` is Stage 6 (0008 adds it).

-- ── drivers (SCHEMA §2) ───────────────────────────────────────────────────
-- A bus's regular driver, as the TD knows them. Not a login: trackers authenticate the phone
-- (ARCH §10), and driver identity is linked to a bus, never to positions.

CREATE TABLE drivers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   text NOT NULL CHECK (length(trim(full_name)) BETWEEN 1 AND 120),
  phone_e164  text CHECK (phone_e164 ~ '^\+91[6-9][0-9]{9}$'),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER drivers_updated_at BEFORE UPDATE ON drivers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE buses ADD COLUMN driver_id uuid REFERENCES drivers(id);

-- ── favourites (SCHEMA §5) ────────────────────────────────────────────────

CREATE TABLE favourites (
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  bus_id      uuid NOT NULL REFERENCES buses(id) ON DELETE CASCADE,
  kind        fav_kind_t NOT NULL,      -- 'main' | 'starred'
  muted_until timestamptz,              -- "not today" without losing the star
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bus_id)
);
-- exactly one main favourite per student, in the database
CREATE UNIQUE INDEX one_main_fav ON favourites (user_id) WHERE kind = 'main';
CREATE INDEX ON favourites (bus_id);

-- ── tickets (SCHEMA §6) ───────────────────────────────────────────────────

CREATE TABLE tickets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            ticket_kind_t NOT NULL,
  severity        smallint NOT NULL CHECK (severity BETWEEN 0 AND 4),  -- mirrors notification tier
  bus_id          uuid REFERENCES buses(id),
  trip_id         uuid REFERENCES trips(id),
  route_id        uuid REFERENCES routes(id),
  title           text NOT NULL,
  description     text,
  status          ticket_status_t NOT NULL DEFAULT 'open',
  assigned_to     uuid REFERENCES profiles(id),
  opened_by       uuid REFERENCES profiles(id),  -- NULL = auto-opened by the system
  opened_at       timestamptz NOT NULL DEFAULT now(),
  resolved_by     uuid REFERENCES profiles(id),
  resolved_at     timestamptz,
  resolution_note text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tickets_open ON tickets (opened_at DESC) WHERE status IN ('open', 'acknowledged');
CREATE INDEX ON tickets (bus_id, opened_at DESC);
-- A bus is out of commission once, not twice: a double-click or a second admin finds the
-- open ticket instead of firing a second T0.
CREATE UNIQUE INDEX one_open_commission_ticket ON tickets (bus_id)
  WHERE kind = 'out_of_commission' AND status IN ('open', 'acknowledged');
-- one automatic signal-loss ticket per trip, however many sweeps see the outage
CREATE UNIQUE INDEX one_open_signal_ticket ON tickets (trip_id)
  WHERE kind = 'signal_lost' AND status IN ('open', 'acknowledged');
CREATE TRIGGER tickets_updated_at BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ticket_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor_id    uuid REFERENCES profiles(id),
  from_status ticket_status_t,
  to_status   ticket_status_t NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ticket_events (ticket_id, created_at);

-- ── announcements (SCHEMA §6) ─────────────────────────────────────────────

CREATE TABLE announcements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid,                  -- REFERENCES notifications(id), added by 0008 (Stage 6)
  tier            smallint NOT NULL CHECK (tier BETWEEN 0 AND 4),
  audience        audience_t NOT NULL,
  audience_ref    uuid,                  -- route_id or bus_id when scoped
  title           text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 80),
  body_md         text NOT NULL CHECK (length(body_md) BETWEEN 1 AND 2000),
  attachment_path text,
  -- the recipient count the admin saw and confirmed (invariant 11); the send re-resolves
  confirmed_count integer NOT NULL CHECK (confirmed_count >= 0),
  scheduled_for   timestamptz,           -- NULL = send on confirm
  published_at    timestamptz,           -- when it was actually sent; NULL while scheduled
  cancelled_at    timestamptz,
  created_by      uuid NOT NULL REFERENCES profiles(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- a route or bus audience names exactly one; every other audience names none
  CHECK ((audience IN ('route', 'bus')) = (audience_ref IS NOT NULL)),
  CHECK (published_at IS NULL OR cancelled_at IS NULL)
);
CREATE INDEX ON announcements (created_at DESC);
-- the scheduler's queue: rows waiting for their time
CREATE INDEX announcements_due ON announcements (scheduled_for)
  WHERE published_at IS NULL AND cancelled_at IS NULL;

-- 'custom' audiences: audience_ref is one uuid and cannot hold a list
CREATE TABLE announcement_recipients (
  announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (announcement_id, user_id)
);

-- ── event-day bus lists (SCHEMA §7) ───────────────────────────────────────
-- Only applied lists live here: a preview is computed from the uploaded file and never written,
-- so this table is exactly what students have been told.

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

-- ── audit (SCHEMA §8) ─────────────────────────────────────────────────────
-- Every admin-mutable table. favourites is a student's own data, not an admin action.

CREATE TRIGGER audit_drivers AFTER INSERT OR UPDATE OR DELETE ON drivers
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_tickets AFTER INSERT OR UPDATE OR DELETE ON tickets
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_ticket_events AFTER INSERT OR UPDATE OR DELETE ON ticket_events
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_announcements AFTER INSERT OR UPDATE OR DELETE ON announcements
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_announcement_recipients AFTER INSERT OR UPDATE OR DELETE
  ON announcement_recipients FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_event_day_buses AFTER INSERT OR UPDATE OR DELETE ON event_day_buses
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- ── row-level security (SCHEMA §9) — deny by default ──────────────────────

ALTER TABLE drivers                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE favourites              ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements           ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcement_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_day_buses         ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON drivers, favourites, tickets, ticket_events, announcements,
              announcement_recipients, event_day_buses FROM anon, authenticated;

-- drivers: a phone number of a member of staff — admins only
GRANT SELECT, INSERT, UPDATE, DELETE ON drivers TO authenticated;
CREATE POLICY drivers_admin ON drivers FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- favourites: a student's own rows; admins do not read them (privacy — the audience count is
-- computed server-side and returns a number, never the list)
GRANT SELECT, INSERT, UPDATE, DELETE ON favourites TO authenticated;
CREATE POLICY favourites_own ON favourites FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- tickets: students see every ticket that is not cancelled (a ticket card in the notification
-- center updates as the TD works it); only admins write
GRANT SELECT, INSERT, UPDATE ON tickets TO authenticated;
CREATE POLICY tickets_read ON tickets FOR SELECT TO authenticated
  USING (status <> 'cancelled' OR is_admin());
CREATE POLICY tickets_admin ON tickets FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

GRANT SELECT, INSERT ON ticket_events TO authenticated;
CREATE POLICY ticket_events_read ON ticket_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_id));  -- tickets' own policy applies
CREATE POLICY ticket_events_admin ON ticket_events FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- announcements reach students as notifications (Stage 6), not as this table
GRANT SELECT, INSERT, UPDATE ON announcements TO authenticated;
CREATE POLICY announcements_admin ON announcements FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());
GRANT SELECT, INSERT, DELETE ON announcement_recipients TO authenticated;
CREATE POLICY announcement_recipients_admin ON announcement_recipients FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- event-day lists hold only applied (published) rows, so students may read them
GRANT SELECT, INSERT, UPDATE, DELETE ON event_day_buses TO authenticated;
CREATE POLICY event_day_buses_read ON event_day_buses FOR SELECT TO authenticated USING (true);
CREATE POLICY event_day_buses_admin ON event_day_buses FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());
