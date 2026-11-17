-- 2033 — Security Hardening — ROLLBACK
--
-- Reverses the additive changes in up.sql. Run ONLY if this migration must
-- be fully backed out (e.g. before reverting the matching app-code
-- deployment). Take a fresh backup before running this, same as before
-- running up.sql.
--
-- NOTE on the enum values (SESSIONS_REVOKED, PERMISSION_GROUP_CHANGED):
-- Postgres has NO "ALTER TYPE ... DROP VALUE" statement, so those two
-- enum values CANNOT be automatically removed from
-- user_audit_log_action_enum here (same documented limitation as
-- migrations/2027_monitoring/down.sql). If a full rollback requires their
-- removal, the only two options are either (a) accept that they remain
-- defined-but-unused in the enum type (harmless — see note in up.sql), or
-- (b) manually rebuild the enum type (create a new type without them,
-- ALTER TABLE ... ALTER COLUMN ... TYPE new_type USING ..., drop the old
-- type, rename) after first confirming with the pre-check query below that
-- no row in user_audit_log actually uses either value.
--
-- Pre-check (run BEFORE attempting any manual enum-shrink step above):
--   SELECT action, count(*) FROM user_audit_log
--   WHERE action IN ('SESSIONS_REVOKED', 'PERMISSION_GROUP_CHANGED')
--   GROUP BY action;
-- If this returns any rows with count > 0, those audit log entries would
-- be destroyed/invalidated by removing the enum value — do not proceed
-- with a manual enum rebuild while real audit history depends on these
-- values.
--
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2033_security_hardening/down.sql

BEGIN;

-- Drop the tokenVersion column. WARNING: this is destructive — any
-- currently-issued JWT that embeds a tokenVersion claim will, after this
-- column is dropped AND the app code is reverted to the pre-2033
-- auth.middleware.ts (which never read it), simply have that claim
-- ignored again. No data loss of consequence since this column has no
-- meaning once the enforcing app code is gone.
ALTER TABLE "user" DROP COLUMN IF EXISTS "tokenVersion";

COMMIT;

-- Enum values are intentionally NOT dropped here — see the note above.
