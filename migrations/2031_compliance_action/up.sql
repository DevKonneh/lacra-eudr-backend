-- 2031 — Compliance Action (Warning / Fine / Suspend / Revoke / Reinstate)
--
-- Status: REVIEWED AND TESTED against a disposable staging copy. See
-- README.md for full test results before running against production.
--
-- Adds ONE new, fully additive table: compliance_action — an immutable,
-- append-only audit log of every enforcement action taken against a
-- Certificate (Agency or Local Produce Buyer permit) or an individual
-- AgentPersonnel record (Agent/Clerk). No existing table or column is
-- altered, dropped, or renamed by this migration.
--
-- Mirrors ComplianceAction entity (src/entities/ComplianceAction.ts)
-- exactly. subjectType/actionType are TypeORM "simple-enum" columns,
-- which TypeORM stores as plain `character varying` (NOT a Postgres
-- native enum type) — so this migration creates them as varchar, with no
-- new Postgres enum type required, matching TypeORM's own runtime
-- expectation for this entity.
--
-- Depends on: migrations/2029_agency_register/up.sql (for Certificate/
-- AgentPersonnel subject rows to exist) and the "uuid-ossp" extension
-- already being enabled (uuid_generate_v4() is already used by
-- migrations/2027_monitoring, 2028_local_produce_buyers, and
-- 2029_agency_register — all already live in production).
--
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2031_compliance_action/up.sql

BEGIN;

CREATE TABLE IF NOT EXISTS compliance_action (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    "subjectType" character varying NOT NULL,
    "subjectId" character varying NOT NULL,
    "subjectName" character varying,
    "subjectPermitNumber" character varying,
    "actionType" character varying NOT NULL,
    reason text NOT NULL,
    "fineAmount" numeric(12,2),
    "fineCurrency" character varying DEFAULT 'LRD',
    "finePaid" boolean NOT NULL DEFAULT false,
    "finePaidAt" timestamp without time zone,
    "performedByUserId" character varying,
    "performedByName" character varying,
    "previousStatus" character varying,
    "newStatus" character varying,
    "createdAt" timestamp without time zone NOT NULL DEFAULT now()
);

-- Every list/history read (GET /api/agencies/:id/compliance-actions,
-- GET /api/local-produce-buyers/:id/compliance-actions, and the
-- personnel-level equivalent) filters by subjectId alone, then sorts by
-- createdAt DESC in the application layer (ComplianceActionService).
-- A plain index on subjectId keeps that filter fast as the table grows;
-- no composite index is needed since sorting happens in-memory on an
-- already-small per-subject result set.
CREATE INDEX IF NOT EXISTS idx_compliance_action_subject_id
    ON compliance_action ("subjectId");

COMMIT;
