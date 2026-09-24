-- 0002 — identity and roster (SCHEMA §1, §7 roster_uploads, §8, §9). Stage 4.
--
-- Creation order differs from SCHEMA's reading order: roster_uploads ↔ profiles reference
-- each other, so roster_uploads is created first and its profile FKs are added afterwards.

-- ── tables ────────────────────────────────────────────────────────────────

CREATE TABLE roster_uploads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          upload_kind_t NOT NULL,
  service_date  date,
  cohort        cohort_t,
  file_path     text NOT NULL,
  original_name text NOT NULL,
  content_hash  text NOT NULL,
  row_count     integer,
  status        upload_status_t NOT NULL DEFAULT 'pending',
  diff_summary  jsonb,
  error_log     jsonb,
  uploaded_by   uuid NOT NULL,
  applied_by    uuid,
  applied_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roster_students (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  roll_no         text NOT NULL UNIQUE,
  full_name       text NOT NULL,
  admission_year  smallint NOT NULL,
  cohort          cohort_t NOT NULL,
  phone_e164      text,
  branch          text,
  claimed_at      timestamptz,
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

CREATE TABLE profiles (
  id                     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  roll_no                text NOT NULL UNIQUE REFERENCES roster_students(roll_no),
  full_name              text NOT NULL,
  cohort                 cohort_t NOT NULL,
  role                   role_t NOT NULL DEFAULT 'student',
  phone_e164             text NOT NULL,
  phone_verified_at      timestamptz,
  home_location          geography(Point, 4326),
  home_label             text,
  travel_mode            travel_mode_t NOT NULL DEFAULT 'foot',
  alerts_paused_until    timestamptz,
  max_tier               smallint NOT NULL DEFAULT 3 CHECK (max_tier BETWEEN 0 AND 4),
  critical_breakthrough  boolean NOT NULL DEFAULT true,
  quiet_start_min        smallint CHECK (quiet_start_min BETWEEN 0 AND 1439),
  quiet_duration_min     smallint CHECK (quiet_duration_min BETWEEN 1 AND 1440),
  default_buffer_s       integer NOT NULL DEFAULT 180 CHECK (default_buffer_s BETWEEN 0 AND 3600),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON profiles (role) WHERE role <> 'student';
CREATE INDEX ON profiles (cohort);
CREATE INDEX ON profiles USING GIST (home_location);

ALTER TABLE roster_uploads
  ADD FOREIGN KEY (uploaded_by) REFERENCES profiles(id),
  ADD FOREIGN KEY (applied_by)  REFERENCES profiles(id);

CREATE TABLE claim_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  roll_no       text NOT NULL,          -- no FK on purpose: rows exist for unknown roll numbers too
  purpose       challenge_purpose_t NOT NULL DEFAULT 'claim',
  otp_hash      text NOT NULL,          -- bcrypt; never the code itself
  attempts      smallint NOT NULL DEFAULT 0,
  expires_at    timestamptz NOT NULL,
  locked_until  timestamptz,            -- set on the 5th failed attempt
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON claim_challenges (roll_no, expires_at DESC);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES profiles(id),
  action      text NOT NULL,
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

CREATE TRIGGER roster_students_updated_at BEFORE UPDATE ON roster_students
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── role helpers (SCHEMA §9) ──────────────────────────────────────────────
-- SECURITY DEFINER is required, not a nicety: the profiles policy calls is_admin(), which
-- reads profiles. As SECURITY INVOKER that read re-enters the profiles policy and Postgres
-- aborts with "infinite recursion detected in policy for relation profiles".

CREATE FUNCTION auth_role() RETURNS role_t
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT role FROM profiles WHERE id = auth.uid()), 'student'::role_t);
$$;

CREATE FUNCTION is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth_role() IN ('td_admin', 'super_admin');
$$;

-- Supabase custom access token hook: stamps `user_role` into every JWT so the gateway and
-- the Next.js middleware can gate routes without a query. RLS still reads profiles (above),
-- so a demotion takes effect on the next query, not at token expiry.
CREATE FUNCTION custom_access_token_hook(event jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r role_t;
BEGIN
  SELECT role INTO r FROM profiles WHERE id = (event->>'user_id')::uuid;
  RETURN jsonb_set(event, '{claims,user_role}', to_jsonb(COALESCE(r, 'student'::role_t)));
END $$;
REVOKE ALL ON FUNCTION custom_access_token_hook(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION custom_access_token_hook(jsonb) TO supabase_auth_admin;

-- ── cohort (SCHEMA §1) ────────────────────────────────────────────────────
-- The one definition of a cohort. Defaults encode the working assumption — academic year
-- starts 1 August, only first-years are juniors — which is PENDING TD confirmation
-- (tracker §2). Changing the rule means changing these defaults, nowhere else.

CREATE FUNCTION derive_cohort(
  admission_year smallint,
  as_of date,
  academic_year_start_month int DEFAULT 8,
  junior_max_year int DEFAULT 1
) RETURNS cohort_t LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN (EXTRACT(year FROM as_of)::int
          - CASE WHEN EXTRACT(month FROM as_of)::int >= academic_year_start_month THEN 0 ELSE 1 END
          - admission_year + 1) <= junior_max_year
    THEN 'junior'::cohort_t ELSE 'senior'::cohort_t END;
$$;

-- today's operating date: service days are Asia/Kolkata days (SCHEMA §0)
CREATE FUNCTION operating_date() RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date;
$$;

-- The promotion job. Idempotent: run daily, it changes rows only on the boundary day.
CREATE FUNCTION promote_cohorts(as_of date DEFAULT operating_date()) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  UPDATE roster_students SET cohort = derive_cohort(admission_year, as_of)
   WHERE cohort IS DISTINCT FROM derive_cohort(admission_year, as_of);
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE profiles p SET cohort = r.cohort
    FROM roster_students r
   WHERE r.roll_no = p.roll_no AND p.cohort IS DISTINCT FROM r.cohort;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION promote_cohorts(date) FROM PUBLIC, anon, authenticated;

-- ── audit (SCHEMA §8) ─────────────────────────────────────────────────────
-- Trigger arguments name columns to redact from before/after. The gateway pushes request
-- context with set_config(..., true) inside the same transaction (see packages/db withContext).

CREATE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  candidate uuid := COALESCE(auth.uid(), NULLIF(current_setting('app.actor_id', true), '')::uuid);
  actor     uuid;
  b jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  a jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  col text;
BEGIN
  -- a student editing their own preferences is not an admin action
  IF TG_TABLE_NAME = 'profiles' AND TG_OP = 'UPDATE' AND candidate = NEW.id THEN
    RETURN NEW;
  END IF;
  SELECT id INTO actor FROM profiles WHERE id = candidate;
  -- TG_ARGV is NULL, not '{}', for a trigger declared without arguments
  FOREACH col IN ARRAY COALESCE(TG_ARGV, '{}') LOOP
    b := b - col;
    a := a - col;
  END LOOP;
  INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after, ip, user_agent)
  VALUES (
    actor,
    TG_TABLE_NAME || '.' || lower(TG_OP),
    TG_TABLE_NAME,
    COALESCE((a->>'id')::uuid, (b->>'id')::uuid),
    b, a,
    NULLIF(current_setting('app.client_ip', true), '')::inet,
    NULLIF(current_setting('app.user_agent', true), '')
  );
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER audit_roster_students AFTER INSERT OR UPDATE OR DELETE ON roster_students
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_roster_uploads AFTER INSERT OR UPDATE OR DELETE ON roster_uploads
  FOR EACH ROW EXECUTE FUNCTION audit_row();
-- pinned home location never reaches the audit log: admins can read it (ARCH §10)
CREATE TRIGGER audit_profiles AFTER INSERT OR UPDATE OR DELETE ON profiles
  FOR EACH ROW EXECUTE FUNCTION audit_row('home_location', 'home_label');

-- ── row-level security (SCHEMA §9) — deny by default ──────────────────────
-- Supabase grants every privilege on new public tables to anon/authenticated by default,
-- so each table first loses all of them and then gets back exactly what its policies need.

ALTER TABLE roster_uploads   ENABLE ROW LEVEL SECURITY;
ALTER TABLE roster_students  ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log        ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON roster_uploads, roster_students, profiles, claim_challenges, audit_log
  FROM anon, authenticated;

-- roster_students: students have no access at all (it is the student directory)
GRANT SELECT, INSERT, UPDATE, DELETE ON roster_students TO authenticated;
CREATE POLICY roster_students_admin ON roster_students FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- roster_uploads: admin only
GRANT SELECT, INSERT, UPDATE ON roster_uploads TO authenticated;
CREATE POLICY roster_uploads_admin ON roster_uploads FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- profiles: own row or admin. Updates are limited by column grant, so nobody — student or
-- admin — can change role, roll_no, cohort or phone through the API. Role changes are a
-- service-role operation.
GRANT SELECT ON profiles TO authenticated;
GRANT UPDATE (home_location, home_label, travel_mode, alerts_paused_until, max_tier,
              critical_breakthrough, quiet_start_min, quiet_duration_min, default_buffer_s)
  ON profiles TO authenticated;
CREATE POLICY profiles_read ON profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR is_admin());
CREATE POLICY profiles_update_own ON profiles FOR UPDATE TO authenticated
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());

-- audit_log: admin read only; rows arrive via the SECURITY DEFINER trigger
GRANT SELECT ON audit_log TO authenticated;
CREATE POLICY audit_log_admin_read ON audit_log FOR SELECT TO authenticated
  USING (is_admin());

-- claim_challenges: RLS on, no policy, no grant — service role only (the claim endpoints).

-- ── scheduling ────────────────────────────────────────────────────────────
-- Daily at 00:05 IST (18:35 UTC). Guarded because pg_cron exists on Supabase but not in the
-- in-process test database.
DO $$
BEGIN
  -- pg_cron can only be created in its configured database (cron.database_name, 'postgres'
  -- on Supabase); a throwaway test database on the same server must skip it.
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
     AND current_database() = COALESCE(current_setting('cron.database_name', true), 'postgres') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.schedule('promote-cohorts', '35 18 * * *', 'SELECT public.promote_cohorts()');
    PERFORM cron.schedule('purge-claim-challenges', '0 * * * *',
      $cmd$DELETE FROM public.claim_challenges WHERE created_at < now() - interval '24 hours'$cmd$);
  END IF;
END $$;
