-- CMIS Monitoring feature — rollback migration (DOWN)
--
-- IMPORTANT ASYMMETRY — read before running:
--   - Dropping the 4 new tables (step 1) and the 3 new nullable columns on
--     "user" (step 2) is simple and safe in the sense that it only
--     discards Monitoring-feature data (field events, sync status,
--     sign-in attempts, session heartbeats, supervisor/territory
--     assignments) captured SINCE this feature was deployed. It does NOT
--     touch any pre-existing "user", "farmer", or "farm" data.
--   - Removing the "FIELD_SUPERVISOR" value from "user_role_enum" and the
--     "SUPERVISOR_CHANGED"/"TERRITORY_CHANGED" values from
--     "user_audit_log_action_enum" is NOT simple in Postgres — there is no
--     `ALTER TYPE ... DROP VALUE`. The only way to truly remove an enum
--     value is to create a new enum type without it, re-point every
--     column/row to the new type, then drop the old type. That is NOT
--     included here as an automatic step because:
--       * it is only safe for user_role_enum if NO existing "user" row
--         currently has role = 'FIELD_SUPERVISOR' (see pre-check below);
--       * removing SUPERVISOR_CHANGED/TERRITORY_CHANGED would break any
--         existing "user_audit_log" row that already uses one of those
--         values, and user_audit_log (like farmer_audit_log) is an
--         intentionally immutable audit trail.
--     The recommended rollback in the common case ("turn the feature
--     off") is simply: stop deploying the application code that writes
--     these values / tables, and leave the additive schema in place — it
--     is inert if the feature's endpoints are not called.
--
-- PRE-REQUISITE: take a database backup/snapshot before running this, same
-- as before the up-migration.
--
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2027_monitoring/down.sql

BEGIN;

-- Step 1: drop the 4 new tables (safe, reversible only by re-running
-- up.sql — the field-event/sync-status/sign-in-attempt/session data
-- itself is NOT recoverable once dropped).
DROP TABLE IF EXISTS "field_event";
DROP TABLE IF EXISTS "mobile_sync_status";
DROP TABLE IF EXISTS "sign_in_attempt";
DROP TABLE IF EXISTS "user_session";

-- Step 2: drop the 3 new nullable columns on "user" (safe, reversible
-- only by re-running up.sql — supervisor/territory assignments are NOT
-- recoverable once dropped).
ALTER TABLE "user" DROP COLUMN IF EXISTS "supervisorId";
ALTER TABLE "user" DROP COLUMN IF EXISTS "assignedCounty";
ALTER TABLE "user" DROP COLUMN IF EXISTS "assignedDistrict";

COMMIT;

-- Step 3 (NOT automated — read the header above): to actually remove the
-- "field_event_type_enum" and "sign_in_attempt_outcome_enum" TYPES
-- entirely, this is safe and simple ONLY because they are brand-new types
-- used exclusively by the 2 tables just dropped in Step 1 above (no other
-- table/column references them), so no pre-check against existing rows is
-- needed here — unlike Step 4 below.
DROP TYPE IF EXISTS "field_event_type_enum";
DROP TYPE IF EXISTS "sign_in_attempt_outcome_enum";

-- Step 4 (NOT automated — read the header above): to actually remove
-- 'FIELD_SUPERVISOR' from user_role_enum, first run this pre-check. If it
-- returns any rows, STOP — do not remove the enum value, since doing so
-- would break those existing "user" rows (and `supervisorId` references
-- that may still logically point at a now-invalid role).
--
--   SELECT role, count(*) FROM "user" WHERE role = 'FIELD_SUPERVISOR' GROUP BY role;
--
-- Only if that query returns ZERO rows, the enum value can be removed by
-- recreating the type (adjust the "OLD" value list to exactly what
-- existed in user_role_enum before this feature):
--
--   ALTER TYPE "user_role_enum" RENAME TO "user_role_enum_old";
--   CREATE TYPE "user_role_enum" AS ENUM (
--       'ADMIN', 'INSPECTOR', 'BUYER', 'EXPORTER', 'FARMER', 'COMMERCIAL',
--       'DG', 'TECHNICAL', 'FINANCE', 'IT'
--   );
--   ALTER TABLE "user"
--       ALTER COLUMN "role" TYPE "user_role_enum"
--       USING ("role"::text::"user_role_enum");
--   ALTER TABLE "user" ALTER COLUMN "role" SET DEFAULT 'INSPECTOR'::"user_role_enum";
--   DROP TYPE "user_role_enum_old";
--
-- Similarly, to remove 'SUPERVISOR_CHANGED'/'TERRITORY_CHANGED' from
-- user_audit_log_action_enum, first run:
--
--   SELECT action, count(*) FROM "user_audit_log"
--   WHERE action IN ('SUPERVISOR_CHANGED', 'TERRITORY_CHANGED')
--   GROUP BY action;
--
-- Only if that query returns ZERO rows for both values, recreate the type
-- analogously (full original value list in up.sql's header/README.md).
--
-- Both of these type-recreate steps are intentionally left as manual,
-- reviewed SQL rather than automatic down.sql statements, for the same
-- immutable-audit-trail / destructive-if-wrong-assumption reasons as
-- migrations/2026_identity_verification/down.sql.
