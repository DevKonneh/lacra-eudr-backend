# Identity Verification — Production Migration

Explicit, reviewed migration for the Identity Verification feature's schema
changes, to be run **before** deploying the application code that depends
on them (`ec80141`, `e688e05`). This replaces reliance on `synchronize:
true` for this specific deploy — see `up.sql` for why.

## What this changes

1. Four new **nullable** columns on `"farmer"`:
   `identityVerifiedAt`, `identityVerifiedByUserId`, `identityVerifiedByName`,
   `identityStatusReason`.
2. Three new values added to the existing `farmer_audit_log_action_enum`
   Postgres enum: `IDENTITY_VERIFIED`, `IDENTITY_CONFLICT_FLAGGED`,
   `IDENTITY_REVERTED_TO_UNVERIFIED`.

Both are purely additive — no existing column, enum value, or row is
altered, retyped, or dropped. This was validated by running `up.sql`
against a full clone of the current schema (see "How this was tested"
below).

## Deployment procedure

### 1. Back up the database first

**Do not skip this.** Even though this migration is additive and was
tested to be safe, a backup is the actual safety net for production, not
a substitute for one.

- **Render managed Postgres**: Dashboard → your Postgres instance →
  **Backups** tab → trigger a manual backup (or confirm a recent automatic
  one exists) before proceeding. Note the backup's timestamp/ID.
- **Any Postgres**, as a portable alternative:
  ```bash
  pg_dump "$DATABASE_URL" -F c -f lacra_pre_identity_verification_$(date +%Y%m%d_%H%M%S).dump
  ```

### 2. Run the migration against production

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2026_identity_verification/up.sql
```

`ON_ERROR_STOP=1` ensures the script stops immediately on any error
instead of continuing past it. The script is wrapped in `BEGIN`/`COMMIT`,
so a failure partway through the column additions rolls back cleanly; the
enum-value additions afterward use `IF NOT EXISTS` guards so they are safe
to re-run independently if needed.

Expected output: a sequence of `ALTER TABLE` / `DO` statements followed by
`COMMIT`, no errors.

### 3. Verify the migration

Run the existing schema-verification script (this checks structure, not
data correctness — see the caveat in "What this does NOT prove" below):

```bash
npx ts-node src/verifyIdentityVerificationSchema.ts
```

Expected: `=== VERIFICATION PASSED ===`. This script is a **post-deployment
structural check**, not a migration — it only confirms the columns/enum
values exist with the right shape; it does not apply any schema changes
itself.

### 4. Deploy the application code

Only after steps 1–3 succeed, deploy the backend (`ec80141`, `e688e05`)
and frontend (`200dad6`) builds that depend on this schema.

### 5. (Optional, if NOT already applied by a prior `synchronize: true` deploy)

If this migration is being run against an environment where the backend
was already deployed with `synchronize: true` and has therefore already
auto-applied these same additive changes, `up.sql` is still safe to run —
every statement is idempotent (`IF NOT EXISTS` / existence-check guards)
and will simply report "already exists, skipping" / no-ops for anything
already present.

## Recovery / rollback

See `down.sql` for the reviewed rollback script and its header comment —
in short:

- Dropping the 4 new columns is simple and safe, but **destroys** any
  verification decisions already recorded (who/when/why a farmer was
  verified) — only do this to revert a bad deploy before real verification
  work has happened.
- Removing the 3 new enum values is **not** automated, because
  `FarmerAuditLog` is an intentionally immutable audit trail (see its
  entity header comment) and removing an enum value that any existing row
  already uses would break those rows. `down.sql` includes a pre-check
  query and the manual (reviewed, not scripted) steps for the rare case
  where it's actually safe to do so.
- In the common case ("we need to turn this feature off"), the simplest
  and safest rollback is to **stop deploying the application code** that
  writes to these columns/enum values, and leave the additive schema in
  place — it is inert if the feature's endpoints are not called.

## How this was tested

Before being committed, `up.sql` and `down.sql` were validated against a
**full clone of the actual database schema** (`CREATE DATABASE
eudr_migration_test WITH TEMPLATE eudr_db`, Postgres 15.18, same engine
version as this environment uses), not just a description of what they
should do:

1. The clone's schema was rolled back to a simulated pre-feature state
   (the 4 columns dropped, the enum recreated without the 3 new values,
   with pre-existing rows using those values removed first so the enum
   type-swap itself could be tested safely in isolation).
2. `up.sql` was run against that pre-feature clone — succeeded, and the
   resulting schema matched the current `farmer` / `farmer_audit_log`
   schema exactly (4 nullable columns with correct types, enum with
   9 values including all 6 original + 3 new), with the farmer row count
   unchanged (18 rows, same as before).
3. `up.sql` was re-run a second time against the now-migrated clone to
   confirm idempotency — succeeded with `NOTICE: ... already exists,
   skipping` for each statement, no errors, no duplicate columns/values.
4. `down.sql` was run against the migrated clone — succeeded, the 4
   columns were removed, row count remained 18.
5. `down.sql` was re-run a second time to confirm its own idempotency —
   succeeded with `NOTICE: ... does not exist, skipping`.
6. The test database was dropped after validation; no production or
   shared dev data was used for this test.

## What this does NOT prove

Per the explicit correction on this feature: a successful schema check
(either this migration test, or `verifyIdentityVerificationSchema.ts`)
confirms the **database structure** is correct. It does **not** by itself
confirm:
- That the application's permission checks, audit-trail writes, or
  verification workflow behave correctly against production data volumes
  or production-like usage patterns.
- That the frontend queue/profile/badges/dialogs work correctly together
  in a real browser.

Those are covered separately by the functional API tests (already run
locally) and the required browser smoke test in staging (see the
project's task list — this must be completed and reported before the
feature is described as production-verified).
