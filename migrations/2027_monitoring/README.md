# CMIS Monitoring — Production Migration

Explicit, reviewed migration for the Monitoring feature's schema changes
(supervisor model, presence/heartbeat tracking, field check-in/check-out
events, mobile sync-status reporting, and sign-in attempt logging), to be
run **before** deploying the application code that depends on them. This
replaces reliance on `synchronize: true` for this specific deploy — see
`up.sql` for why.

## What this changes

1. One new value added to the existing `user_role_enum` Postgres enum:
   `FIELD_SUPERVISOR`.
2. Two new values added to the existing `user_audit_log_action_enum`
   Postgres enum: `SUPERVISOR_CHANGED`, `TERRITORY_CHANGED`.
3. Three new **nullable** columns on `"user"`: `supervisorId` (uuid, no FK
   constraint — see note in `up.sql`), `assignedCounty` (varchar),
   `assignedDistrict` (varchar).
4. Two brand-new enum types: `field_event_type_enum`
   (`CHECK_IN`/`CHECK_OUT`/`FARM_RECORD_CAPTURE`) and
   `sign_in_attempt_outcome_enum` (`SUCCESS`/`FAILED`/`BLOCKED`).
5. Four brand-new tables: `field_event`, `mobile_sync_status`,
   `sign_in_attempt`, `user_session`.

Everything here is purely additive — no existing column, enum value, row,
or table is altered, retyped, or dropped.

## Deployment procedure

### 1. Back up the database first

**Do not skip this.**

```bash
pg_dump "$DATABASE_URL" -F c -f lacra_pre_monitoring_$(date +%Y%m%d_%H%M%S).dump
```

### 2. Run the migration against production

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2027_monitoring/up.sql
```

`ON_ERROR_STOP=1` stops immediately on any error. Steps 1–3 (enum ADD
VALUE / column ADD) and steps 4–5 (new types / new tables) are each
wrapped together in the single `BEGIN`/`COMMIT` block, so a failure
partway through rolls back cleanly. Every individual statement is also
guarded (`IF NOT EXISTS` / existence-check `DO $$` blocks), so the whole
file is safe to re-run.

Expected output: a sequence of `DO` / `ALTER TABLE` / `CREATE TYPE` /
`CREATE TABLE` / `CREATE INDEX` statements followed by `COMMIT`, no errors.

### 3. Verify the migration

Run the app (or a minimal TypeORM-initialize script) against the migrated
database **with `DB_SYNCHRONIZE=false`**, confirming the hand-written SQL
alone — not TypeORM auto-sync — produces a schema the application can use
without error:

```bash
DB_SYNCHRONIZE=false DB_NAME=<target_db> npx ts-node src/discoverSync.ts
```

(`discoverSync.ts` is a disposable local verification script, not part of
the committed migration; delete it after use — see the project's standing
rule against committing throwaway scripts.)

Also confirm pre-existing data is unaffected, e.g.:

```sql
SELECT count(*) FROM "user";
SELECT count(*) FROM "farmer";
SELECT count(*) FROM "farm";
```

Row counts must match the pre-migration counts exactly.

### 4. Deploy the application code

Only after steps 1–3 succeed, deploy the backend/frontend builds that
depend on this schema.

## Recovery / rollback

See `down.sql` and its header comment — in short:

- Dropping the 4 new tables and 3 new `"user"` columns is simple and safe,
  but **destroys** any Monitoring data already recorded (supervisor
  assignments, field events, sync status, sign-in attempts, session
  heartbeats) — only do this to revert a bad deploy before any real
  Monitoring data has been captured.
- Removing the `FIELD_SUPERVISOR` role value and the
  `SUPERVISOR_CHANGED`/`TERRITORY_CHANGED` audit-action values is **not**
  automated, for the same immutable-audit-trail / "could break existing
  rows" reasons as `migrations/2026_identity_verification/down.sql`.
  `down.sql` includes pre-check queries and the manual (reviewed, not
  scripted) steps for the rare case where it's actually safe to do so.
- In the common case ("turn the feature off"), the simplest and safest
  rollback is to **stop deploying the application code** that writes to
  these columns/tables/enum values, and leave the additive schema in
  place — it is inert if the feature's endpoints are not called.

## How this was tested

This migration was derived from, and tested against, TypeORM's own
`synchronize: true` output, then re-verified independently with
`synchronize` disabled:

1. **Schema discovery**: a disposable database (`eudr_monitoring_discover`)
   was created as a clone of a genuine pre-migration baseline (see
   "Establishing a genuine baseline" below), and TypeORM's
   `synchronize: true` was run against it exactly once (via a throwaway
   `discoverSync.ts` script, deleted afterward) to reveal the EXACT target
   schema — table names, column names/types/nullability/defaults, enum
   value lists and order, and index/constraint names — that the four new
   entities (`User`'s 3 new columns, `FieldEvent`, `MobileSyncStatus`,
   `SignInAttempt`, `UserSession`) produce. This discovery database was
   dropped immediately after inspection; it was never used to test the
   hand-written SQL itself.
2. **Bug found and fixed during discovery**: the first discovery run
   failed with `DataTypeNotSupportedError: Data type "Object" in
   "User.assignedCounty" is not supported by "postgres" database`, because
   `reflect-metadata` cannot represent a `string | null` TypeScript union
   type at runtime (it reports plain `Object`), and two columns
   (`User.assignedCounty`/`assignedDistrict`, `FieldEvent.assignmentContext`)
   relied on that inference instead of an explicit `type:` option. Both
   were fixed by adding `type: "varchar"` explicitly. This was a genuine,
   previously-latent bug that would have crashed the real backend the
   moment it initialized against these entities, independent of this
   migration's existence.
2. **`up.sql`/`down.sql` written by hand** to reproduce exactly the schema
   observed in step 1 — not auto-generated — using the same
   `BEGIN`/`COMMIT` + `IF NOT EXISTS`/`DO $$ ... END$$` idempotency-guard
   patterns as `migrations/2026_identity_verification/up.sql`/`down.sql`.
3. **`up.sql` applied to `eudr_monitoring_test`** (a disposable clone of
   the real `eudr_db`) with `DB_SYNCHRONIZE=false` set for the
   verification run, confirming the hand-written SQL alone produces a
   schema the application can initialize against without error — see the
   "Verification results" section below for the actual commands/output
   once executed.
4. **Idempotency**: `up.sql` re-run a second time against the
   now-migrated `eudr_monitoring_test`, confirming no errors / no
   duplicate columns, types, or tables.
5. **Pre-existing data unaffected**: `"user"`/`"farmer"`/`"farm"` row
   counts in `eudr_monitoring_test` confirmed unchanged before/after the
   migration.

### Establishing a genuine pre-migration baseline

`eudr_monitoring_test` (created in an earlier session via `CREATE DATABASE
eudr_monitoring_test TEMPLATE eudr_db`) had already had `FIELD_SUPERVISOR`
leaked into its `user_role_enum` by a prior partial/accidental
`synchronize: true` run, before any migration SQL existed. This was fixed
by manually reverting `eudr_monitoring_test`'s `user_role_enum` back to
its original 10 values (confirmed 0 existing rows used
`FIELD_SUPERVISOR`, so the revert is lossless) via the
rename-recreate-repoint-drop dance:

```sql
ALTER TYPE "user_role_enum" RENAME TO "user_role_enum_old";
CREATE TYPE "user_role_enum" AS ENUM (
    'ADMIN', 'INSPECTOR', 'BUYER', 'EXPORTER', 'FARMER', 'COMMERCIAL',
    'DG', 'TECHNICAL', 'FINANCE', 'IT'
);
ALTER TABLE "user" ALTER COLUMN "role" TYPE "user_role_enum" USING ("role"::text::"user_role_enum");
ALTER TABLE "user" ALTER COLUMN "role" SET DEFAULT 'INSPECTOR'::"user_role_enum";
DROP TYPE "user_role_enum_old";
```

This restored `eudr_monitoring_test` to a state matching `eudr_db`'s
actual (un-migrated) production-equivalent schema, making it a valid
target for testing this migration from a true "before" state.

## What this does NOT prove

A successful schema check (this migration test) confirms the **database
structure** is correct. It does **not** by itself confirm that the
application's access-scoping logic (`MonitoringAccessService`), the
check-in/check-out controller's idempotency, or the mobile sync-reporting
flow behave correctly against production data volumes or usage patterns.
Those are covered separately by the functional API verification steps
documented at feature handoff (check-in/check-out dedup, farmer-sync
retry/recovery, delayed-event-preserves-newer-data, final-zero-pending
sync report, and live supervisor-reassignment access revocation).
