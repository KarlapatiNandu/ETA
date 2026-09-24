-- 0001 — extensions, every enum from SCHEMA §11, shared trigger functions.
-- Enums are created up front: adding a value later is cheap, but reordering or removing
-- one under live RLS policies is not (SCHEMA §1 cohort note).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TYPE cohort_t        AS ENUM ('junior','senior');
CREATE TYPE role_t          AS ENUM ('student','driver','td_admin','super_admin');
CREATE TYPE travel_mode_t   AS ENUM ('foot','bicycle','motorbike','car');
CREATE TYPE bus_status_t    AS ENUM ('active','maintenance','out_of_commission','retired');
CREATE TYPE tracker_kind_t  AS ENUM ('driver_phone','hardware');
CREATE TYPE direction_t     AS ENUM ('inbound','outbound');
CREATE TYPE route_source_t  AS ENUM ('gps_survey','osrm_derived','manual_draw');
CREATE TYPE shift_t         AS ENUM ('morning','evening');
CREATE TYPE trip_status_t   AS ENUM ('scheduled','running','dark','completed','cancelled');
CREATE TYPE stop_event_t    AS ENUM ('arrived','departed','skipped');
CREATE TYPE event_source_t  AS ENUM ('crossing','inferred','manual');
CREATE TYPE fav_kind_t      AS ENUM ('main','starred');
CREATE TYPE sub_state_t     AS ENUM ('active','muted','boarded','completed','missed');
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

-- SCHEMA §0: mutable tables have a trigger-maintained updated_at.
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
