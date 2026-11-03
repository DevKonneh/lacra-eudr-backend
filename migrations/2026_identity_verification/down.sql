-- Identity Verification feature — rollback migration (DOWN)
--
-- IMPORTANT ASYMMETRY — read before running:
--   - Dropping the 4 new columns (step 1) is simple and safe: it only
--     discards Identity Verification data captured SINCE this feature was
--     deployed (who verified a farmer, when, and why). It does NOT touch
--     any other farmer field.
--   - Removing the 3 new enum values (step 2) is NOT simple in Postgres —
--     there is no `ALTER TYPE ... DROP VALUE`. The only way to truly
--     remove an enum value is to create a new enum type without it,
--     re-point every column/row to the new type, then drop the old type.
--     That is NOT included here as an automatic step because it is only
--     safe if NO existing "farmer_audit_log" row currently uses one of
--     the 3 new values — see the pre-check query below. If any row DOES
--     use one of these values, removing the enum value would require
--     either deleting/remapping those audit rows (destroys audit
--     history) or leaving the "old" enum type in place. For an
--     *immutable audit trail* (the explicit design intent of
--     FarmerAuditLog — see its header comment), the recommended rollback
--     is simply: **stop deploying the application code that writes these
--     values** (steps 2-3 of the recovery runbook in README.md), and
--     leave the 3 enum values and their existing audit rows in place.
--     They are inert if the feature's endpoints are not called.
--
-- PRE-REQUISITE: take a database backup/snapshot before running this, same
-- as before the up-migration.
--
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2026_identity_verification/down.sql

BEGIN;

-- Step 1: drop the 4 new columns (safe, reversible only by re-running
-- up.sql — the verification metadata itself is NOT recoverable once
-- dropped, so only do this as a last resort, e.g. reverting a bad
-- deploy before any real verification decisions have been made).
ALTER TABLE "farmer" DROP COLUMN IF EXISTS "identityVerifiedAt";
ALTER TABLE "farmer" DROP COLUMN IF EXISTS "identityVerifiedByUserId";
ALTER TABLE "farmer" DROP COLUMN IF EXISTS "identityVerifiedByName";
ALTER TABLE "farmer" DROP COLUMN IF EXISTS "identityStatusReason";

COMMIT;

-- Step 2 (NOT automated — read the header above): to actually remove the
-- 3 new enum values from farmer_audit_log_action_enum, first run this
-- pre-check. If it returns any rows, STOP — do not remove the enum
-- values, since doing so would break those existing audit rows.
--
--   SELECT action, count(*) FROM "farmer_audit_log"
--   WHERE action IN ('IDENTITY_VERIFIED', 'IDENTITY_CONFLICT_FLAGGED', 'IDENTITY_REVERTED_TO_UNVERIFIED')
--   GROUP BY action;
--
-- Only if that query returns ZERO rows for all three values, the enum
-- values can be removed by recreating the type (example, adjust the
-- "OLD" value list to exactly what existed before this feature):
--
--   ALTER TYPE "farmer_audit_log_action_enum" RENAME TO "farmer_audit_log_action_enum_old";
--   CREATE TYPE "farmer_audit_log_action_enum" AS ENUM (
--       'CONTACT_UPDATED', 'FARM_ADDED', 'IDENTITY_CONFIRMED',
--       'COMMODITY_ADDED', 'COMMODITY_UPDATED', 'COMMODITY_DEACTIVATED'
--   );
--   ALTER TABLE "farmer_audit_log"
--       ALTER COLUMN "action" TYPE "farmer_audit_log_action_enum"
--       USING ("action"::text::"farmer_audit_log_action_enum");
--   DROP TYPE "farmer_audit_log_action_enum_old";
--
-- This is intentionally left as a manual, reviewed step rather than part
-- of the automatic down.sql, because it is destructive to run against the
-- wrong assumption (data loss / broken existing rows) and this codebase's
-- audit log is explicitly designed to be immutable.
