-- 0008 — Stage 6, the notification spine (SCHEMA §6, ARCHITECTURE §6).
--
-- Three promises live in this file rather than in the worker:
--   * a student is never notified twice for the same thing — `notif_dedupe` (invariant 5);
--   * a retried event never creates a second parent — `notifications.source_key`;
--   * the notification center is the record, written whether or not any transport works
--     (invariant 14) — every recipient row is written first, transports are attempted after.

-- ── notifications (the parent: one per event) ─────────────────────────────

CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- what caused it, e.g. 'announcement:<id>', 'ticket:<id>:opened', 'stop:<trip>:<seq>':
  -- a retried or replayed event finds its parent instead of making a second one
  source_key   text NOT NULL UNIQUE,
  tier         smallint NOT NULL CHECK (tier BETWEEN 0 AND 4),
  category     notif_category_t NOT NULL,
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
CREATE INDEX ON notifications (ticket_id) WHERE ticket_id IS NOT NULL;

-- ── recipients (one per student per notification) ─────────────────────────

CREATE TABLE notification_recipients (
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  dedupe_key      text NOT NULL,
  channel         notif_channel_t,       -- push | sms | inapp_only, once decided
  queued_at       timestamptz NOT NULL DEFAULT now(),
  -- quiet hours defer the transport (never the center entry) to the end of the window
  deliver_after   timestamptz NOT NULL DEFAULT now(),
  -- claimed for transport: a compare-and-set on NULL, so a restarted worker never sends twice
  sent_at         timestamptz,
  delivered_at    timestamptz,           -- push service accepted it / SMS provider receipt
  read_at         timestamptz,
  acknowledged_at timestamptz,           -- T0 requires this
  failure_reason  text,                  -- why a transport was not used or did not work
  provider_ref    text,                  -- MSG91 request id, for the delivery receipt
  PRIMARY KEY (notification_id, user_id)
);
CREATE UNIQUE INDEX notif_dedupe ON notification_recipients (dedupe_key);
CREATE INDEX notif_unread ON notification_recipients (user_id, queued_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX notif_user ON notification_recipients (user_id, queued_at DESC);
-- the worker's queue: rows whose transport has not been attempted yet
CREATE INDEX notif_pending ON notification_recipients (deliver_after) WHERE sent_at IS NULL;
CREATE INDEX notif_provider ON notification_recipients (provider_ref) WHERE provider_ref IS NOT NULL;

-- ── push subscriptions ────────────────────────────────────────────────────

CREATE TABLE push_subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  endpoint        text NOT NULL UNIQUE,
  p256dh          text NOT NULL,
  auth            text NOT NULL,
  user_agent      text,
  is_standalone   boolean,               -- true = installed PWA; iOS push needs this
  failure_count   smallint NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  backoff_until   timestamptz,           -- after a 429 from the push service (ARCH §6.3)
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON push_subscriptions (user_id) WHERE failure_count < 5;

-- the FK 0007 left for this migration
ALTER TABLE announcements
  ADD CONSTRAINT announcements_notification_id_fkey
  FOREIGN KEY (notification_id) REFERENCES notifications(id);

-- ── delivery counts for admins (SCHEMA §9: aggregate counts only) ────────
-- Admins may know how many students got a notification and through what — never who.
CREATE FUNCTION notification_delivery(nid uuid)
RETURNS TABLE (recipients integer, pushed integer, texted integer, in_app_only integer,
               pending integer, read integer, acknowledged integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::int,
         count(*) FILTER (WHERE channel = 'push')::int,
         count(*) FILTER (WHERE channel = 'sms')::int,
         count(*) FILTER (WHERE channel = 'inapp_only')::int,
         count(*) FILTER (WHERE sent_at IS NULL)::int,
         count(read_at)::int,
         count(acknowledged_at)::int
    FROM notification_recipients
   WHERE notification_id = nid AND is_admin();
$$;
REVOKE ALL ON FUNCTION notification_delivery(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION notification_delivery(uuid) TO authenticated;

-- ── row-level security (SCHEMA §9) ────────────────────────────────────────

ALTER TABLE notifications           ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions      ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON notifications, notification_recipients, push_subscriptions FROM anon, authenticated;

-- a student reads a notification through their own recipient row; admins read them all
GRANT SELECT ON notifications TO authenticated;
CREATE POLICY notifications_read ON notifications FOR SELECT TO authenticated
  USING (is_admin() OR EXISTS (SELECT 1 FROM notification_recipients r
                                WHERE r.notification_id = notifications.id AND r.user_id = auth.uid()));

-- own rows only; a student may mark read and acknowledge, nothing else. Admins: no read at all
-- (notification_delivery gives them counts)
GRANT SELECT ON notification_recipients TO authenticated;
GRANT UPDATE (read_at, acknowledged_at) ON notification_recipients TO authenticated;
CREATE POLICY notification_recipients_own ON notification_recipients FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY notification_recipients_mark ON notification_recipients FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- a browser's push endpoint is the student's own; admins do not read them
GRANT SELECT, INSERT, DELETE ON push_subscriptions TO authenticated;
CREATE POLICY push_subscriptions_own ON push_subscriptions FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ── retention (SCHEMA §12) ────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
     AND current_database() = COALESCE(current_setting('cron.database_name', true), 'postgres') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    -- 03:00 IST: recipients kept 180 days; a parent nobody holds any more goes with them
    PERFORM cron.schedule('purge-notifications', '30 21 * * *', $cmd$
      DELETE FROM public.notification_recipients WHERE queued_at < now() - interval '180 days';
      DELETE FROM public.notifications n WHERE n.created_at < now() - interval '180 days'
         AND NOT EXISTS (SELECT 1 FROM public.notification_recipients r WHERE r.notification_id = n.id)
         AND NOT EXISTS (SELECT 1 FROM public.announcements a WHERE a.notification_id = n.id);
    $cmd$);
  END IF;
END $$;
