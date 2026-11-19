# 2033 — Assessment Provenance & Failure Visibility

**Status: PROPOSED FOR REVIEW. NOT applied to production.**

## Why this migration exists

The risk-assessment pipeline could persist a "successful" `RiskAssessment`
row that was not derived from any real satellite analysis:

1. **Mock on missing key.** `WhispService.analyzeFarm()` returned a
   **randomised** mock (`Math.random() > 0.8` → high or low) whenever
   `WHISP_API_KEY` was unset.
2. **Name heuristic on failure.** When the live Whisp call failed,
   `RiskService` fell back to `checkDeforestation()`, which returned `true`
   if the farm's **name contained the word "risk"**.

In both cases `RiskService.analyzeFarm()` then wrote a normal
`RiskAssessment` row **and** stamped `farm.riskLevel` plus
`farm.lastRiskAssessmentDate`. A failure therefore became indistinguishable
from a verified verdict in the UI, in reports and in exports — and because
the frontend's "is this assessed?" gate keys on `lastRiskAssessmentDate`,
the fabricated result actively defeated that gate.

The **code** fix (same release) makes a Whisp failure throw a typed
`WhispUnavailableError`, records the failure in `assessment_attempt`, and
never reaches the save block. This migration adds the **schema** that lets
staff see and triage the resulting state, and lets historical rows be marked
as unverifiable without destroying evidence.

## What this migration does

Additive only. Nothing is dropped, renamed or rewritten in place; every
existing row remains valid.

- **4 nullable/defaulted columns on `risk_assessment`:**
  - `source` — `'whisp_live'` | `'mock'` | `NULL` (legacy).
  - `whispVerified` — `boolean NOT NULL DEFAULT false`.
  - `flaggedForReassessment` — `boolean NOT NULL DEFAULT false`.
  - `flagReason` — free text.
- **1 conservative backfill:** every row existing *before* this migration is
  marked `whispVerified = false` and `flaggedForReassessment = true` with an
  explanatory `flagReason`. We cannot prove which historical rows came from
  the mock path, so none of them is silently trusted. `riskLevel`,
  `overallRisk`, `createdAt` and every evidentiary field are left untouched.
- **1 new table `assessment_attempt`** — records failed attempts
  (`farmId`, `farmNameSnapshot`, `attemptedAt`, `failureCode`, `message`,
  `httpStatus`, `retryable`, `detail`). It deliberately contains **no**
  risk-level, overlap or verdict columns, so no query or report can read a
  failed attempt as a compliance result.
- **2 indexes** — per-farm attempt lookups, and flagged-assessment triage.

## Audit rule this enables

A stored assessment is trustworthy **only** when:

```sql
source = 'whisp_live' AND "whispVerified" = true
```

Everything else — including every legacy row — is unverified and must be
reassessed before it can support a compliance statement.

## Identifying legacy mock rows

Rows produced by the old mock path are usually still identifiable in
`whispData`, which was stored verbatim:

```sql
-- Mock results: resultId starts MOCK-WHISP-, or raw.mock = true
SELECT id, "farmId", "whispAnalysisId", "createdAt"
FROM risk_assessment
WHERE "whispAnalysisId" LIKE 'MOCK-WHISP-%'
   OR "whispData" -> 'raw' ->> 'mock' = 'true';
```

These are flagged by the backfill above like every other pre-existing row.
**No row is deleted** — they are retained for audit and flagged for
reassessment.

## Deliberately NOT done here

- **No reassessment is run.** Reassessment is an explicit, staff-triggered,
  auditable action (`POST /api/risk/assess/:farmId`). Bulk-overwriting every
  verdict would destroy the record of what was previously reported.
- **No `farm` columns are changed.** Fixing the assessment path must not
  retroactively rewrite `farm.riskLevel` / `farm.lastRiskAssessmentDate`.

## Rollback

`down.sql` drops only what `up.sql` added. It **refuses to run** if any
`assessment_attempt` row exists, because those rows are the only evidence
that a given farm's assessment failed — dropping them would make those farms
look merely "never assessed".

## Run with

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2033_assessment_provenance/up.sql
```

## Testing note

Follows the same review gate as every prior migration in this series: run on
**staging only** first, with `DB_SYNCHRONIZE=false`, and review the resulting
schema and backfill counts before anything is applied to production.
