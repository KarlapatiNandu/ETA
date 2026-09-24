-- The slice of Supabase that migrations and RLS depend on, for a fresh test database
-- (PGlite, or a throwaway database on a real server). Real Supabase already has all of this; migrations must never create it.
-- Roles are cluster-wide: on a real Supabase server they already exist.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role','supabase_auth_admin'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      -- service_role bypasses RLS; on Supabase it already does and cannot be altered
      EXECUTE format('CREATE ROLE %I NOLOGIN%s', r, CASE WHEN r = 'service_role' THEN ' BYPASSRLS' ELSE '' END);
    END IF;
  END LOOP;
END $$;

CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  encrypted_password text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- identical in behaviour to Supabase's auth.uid(): the JWT `sub` claim, or NULL.
-- The NULLIF *before* the cast matters: once a transaction-local set_config() on
-- request.jwt.claims has been rolled back, the setting reads '' (not NULL) for the rest of
-- the session, and ''::jsonb throws. Supabase's own definition guards the same way.
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb->>'sub', '')::uuid;
$$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- mimic Supabase's default privileges, so the migrations' REVOKEs are actually exercised
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
