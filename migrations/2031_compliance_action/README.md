# 2031 — Compliance Action (Warning / Fine / Suspend / Revoke / Reinstate)

**Status: REVIEWED AND TESTED. Ready for production — must be run BEFORE
deploying the application code that uses it (see "Deployment order"
below).**

## What this migration does
Adds ONE new, fully additive table: `compliance_action` — an immutable,
append-only audit log of every enforcement action taken against a
Certificate (Agency or Local Produce Buyer permit) or an individual
`AgentPersonnel` record (Agent/Clerk):

- `"subjectType"` (varchar) — `CERTIFICATE` or `AGENT_PERSONNEL`.
- `"subjectId"` (varchar) — the Certificate's or AgentPersonnel's `id`.
  Deliberately NOT a foreign key (mirrors `ApplicationStatusHistory`'s own
  plain `applicationId` column), so one table serves both subject kinds.
- `"subjectName"` / `"subjectPermitNumber"` — denormalised snapshot at the
  time of the action, so the audit trail still reads correctly even if
  the subject's own name/number is corrected later.
- `"actionType"` (varchar) — `WARNING` / `FINE` / `SUSPEND` / `REVOKE` /
  `REINSTATE`.
- `reason` (text, NOT NULL) — mandatory staff-entered justification for
  every action, enforced at the API layer
  (`ComplianceActionService.applyComplianceAction()`) before anything is
  written.
- `"fineAmount"` / `"fineCurrency"` — only populated for `actionType =
  FINE`; `fineCurrency` defaults to `'LRD'`.
- `"finePaid"` / `"finePaidAt"` — tracks whether a fine has since been
  paid (separate action from issuing the fine).
- `"performedByUserId"` / `"performedByName"` — which staff member
  recorded the action.
- `"previousStatus"` / `"newStatus"` — for SUSPEND/REVOKE/REINSTATE, a
  snapshot of the `Application.status` transition this action caused.
- `"createdAt"` — when the action was recorded.
- A plain index on `"subjectId"` (every history read filters by subject
  alone, then sorts by `createdAt DESC` in the application layer).

No existing table or column is altered, dropped, or renamed. This
migration is pure addition.

## Why a raw SQL migration (not `synchronize: true`)
Production currently runs TypeORM with `synchronize: true` (the default —
see `src/data-source.ts`, only `.env.staging` overrides this to `false`),
so in principle just pushing the code with `ComplianceAction` registered
in `entities: [...]` would auto-create this table on next boot. This
migration is provided anyway, run manually and explicitly **before** the
code deploy, because:

- `synchronize: true` schema diffing on every boot is the exact mechanism
  that produced the undocumented drift this project's migration docs
  already warn about elsewhere (see `migrations/2027_monitoring/README.md`)
  — for a brand-new table addition specifically, running the exact
  reviewed DDL ourselves removes any uncertainty about what TypeORM's
  synchronizer will decide to do at deploy time, and means the table
  exists (and is confirmed via `\d compliance_action`) independent of,
  and before, the application code that depends on it goes live.
- It matches the same "run the SQL first" sequencing already used by
  `2027_monitoring` and the `2028`/`2029` Local Produce Buyer / Agency
  Register migrations.

## Depends on
No hard schema dependency — `"subjectId"` is a plain varchar, not a
foreign key, so this table has no `ALTER`/`REFERENCES` relationship to
`certificate` or `agent_personnel`. It is still logically paired with
`migrations/2029_agency_register/up.sql` (the `agent_personnel` table)
and the pre-existing `certificate` table, since those are the only two
kinds of row `"subjectId"` ever actually points at — this migration can
technically run independently, but the application code that writes to
it requires both to already exist, which they do in production (the
Agency Register and Local Produce Buyer Register features are already
live).

Relies on the `uuid-ossp` extension already being enabled for
`uuid_generate_v4()` — already used by `migrations/2027_monitoring`,
`2028_local_produce_buyers`, and `2029_agency_register`, all of which are
confirmed live in production, so this extension is already present.

## Where this is surfaced
- **Backend**: `src/entities/ComplianceAction.ts`,
  `src/services/ComplianceActionService.ts`,
  `src/controllers/ComplianceActionController.ts`. Routes mounted inside
  the existing `agency.routes.ts` (`GET/POST /api/agencies/:id/compliance-actions`,
  `GET/POST /api/agencies/:agencyId/personnel/:personnelId/compliance-actions`)
  and `localProduceBuyer.routes.ts` (`GET/POST
  /api/local-produce-buyers/:id/compliance-actions`).
- **Admin — Agency Register / Local Produce Buyer Register list views**:
  a ⋮ compliance-actions menu per row (Warning/Fine/Suspend/Revoke, plus
  Reinstate when applicable) and a History icon opening a compliance
  history modal (Buyer) or inline panel (Agency profile page).
- **Admin — Agency Profile page**: a header-level compliance-actions menu
  for the Agency's own Certificate, a per-Agent/Clerk compliance-actions
  menu, and a full Compliance History panel listing every action ever
  recorded against the Agency or its personnel.
- **Public verification pages**: SUSPEND/REVOKE automatically flip the
  underlying `Application.status` to SUSPENDED/REVOKED, which
  `PermitVerificationService.computePublicStatus()` already checks FIRST
  — so a suspended/revoked permit immediately shows that status on every
  public QR scan with zero additional wiring needed from this migration.

## What this migration deliberately does NOT do
- It does not backfill any history — the table starts completely empty;
  every row going forward is a genuine, individually-performed staff
  action.
- It does not touch `certificate.status`, `application.status`, or any
  `agent_personnel` column directly — those transitions happen in
  application code (`ComplianceActionService`), not in this migration.
- It does not add a Postgres native enum type for `subjectType`/
  `actionType` — the `ComplianceAction` entity declares these as
  TypeORM `"simple-enum"` columns, which TypeORM itself stores as plain
  `character varying` (not a native Postgres enum), so this migration
  creates them as varchar to exactly match what the entity/ORM expects at
  runtime.

## Deployment order (production)
1. **Backup production database first** (standard pre-migration
   practice for this project).
2. Run this migration against the live `DATABASE_URL`:
   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2031_compliance_action/up.sql
   ```
3. Verify: `psql "$DATABASE_URL" -c '\d compliance_action'` shows the
   table with all 16 columns and the `idx_compliance_action_subject_id`
   index, and that pre-existing `certificate`/`agent_personnel` row
   counts are unchanged.
4. Deploy the application code (this commit) — Render auto-deploys from
   `main` on push.
5. Smoke-test one request end-to-end, e.g.
   `GET /api/agencies/:id/compliance-actions` with an admin JWT against
   a real Agency id, confirming `200 {"data": []}` for an Agency with no
   actions yet (not a 500 from a missing table).

## Rollback
See `down.sql` — refuses to run once any row exists (this table is an
immutable audit log; see the doc comment at the top of
`src/entities/ComplianceAction.ts`). Safe to run only immediately after
`up.sql`, before any compliance action has actually been recorded.

## Migration test results (disposable clone, NOT staging/production)

Tested against a disposable clone of the `eudr_db` local Postgres
database (`createdb -T eudr_db eudr_migration_test_2031`, dropped
immediately after testing) — deliberately a clone of `eudr_db`, not
`eudr_db_agency_staging`, because staging's `compliance_action` table was
already manually created during this feature's earlier development and
would have masked a fresh-apply test.

1. `up.sql` applied cleanly against the clean clone — `CREATE TABLE` and
   `CREATE INDEX` both succeeded, `\d compliance_action` confirmed all 16
   columns and the index match the `ComplianceAction` entity exactly.
   **CONFIRMED.**
2. `up.sql` re-applied a second time immediately after — both
   `IF NOT EXISTS` guards produced only informational NOTICEs ("relation
   already exists, skipping"), zero errors. **CONFIRMED IDEMPOTENT.**
3. `down.sql` run against the table with zero rows — succeeded, table and
   index both dropped cleanly. **CONFIRMED.**
4. `up.sql` re-applied, one test row inserted
   (`subjectType='CERTIFICATE', subjectId='test-id-123',
   actionType='WARNING', reason='test guard'`), then `down.sql` run again
   — **correctly refused** with `ERROR: Refusing to run down.sql: 1
   compliance_action row(s) already exist...`, exit code 3 (non-zero).
   Table and the test row were confirmed still present afterward.
   **CONFIRMED SAFETY GUARD WORKS.**
5. Disposable test database dropped after all four checks passed; no
   trace left on disk.
