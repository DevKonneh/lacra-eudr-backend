# Migration 2037 — Plot-level EUDR review decisions

## What this adds

A single new table, `plot_eudr_review`, that stores a human review decision
against a **specific plot** and a **specific plot assessment**:

| column | purpose |
|---|---|
| `plotId` / `farmId` | what the decision is about (CASCADE) |
| `riskAssessmentId` | the exact WhISP result considered (SET NULL — the decision survives) |
| `geometryHash` / `geometryVersion` | the exact boundary reviewed |
| `decision` | `cleared` \| `non_compliant` \| `needs_review` (varchar, not a native enum) |
| `isFinal` | `true` only for holders of the EUDR review permission |
| `reason` | plain-language justification |
| `evidence` | JSONB supporting evidence |
| `reviewedByUserId` / `reviewedByName` / `reviewedByRole` | attribution |
| `createdAt` | when |

## Why a new table (existing workflows were examined)

- `FarmDocument.status` — whether a *document* is valid, not whether a *finding*
  was reviewed. No reviewer, decision, or reason.
- `RiskAssessment` — the satellite verdict itself. Writing a human decision here
  would entangle it with the upstream evidence the audit must preserve.
- `ComplianceAction` — enforcement against a business/agency, not a plot-level
  deforestation finding.
- `AssessmentJob` — lifecycle of the WhISP call attempt, not a judgement.

None stores `{reviewer, decision, reason, evidence, timestamp}` against a specific
plot assessment.

## Currency rule

A review only counts while it still describes the parcel on the map: it must be
`isFinal = true` **and** its `geometryHash` must match the plot's current
boundary hash. A boundary change therefore requires a fresh assessment and a new
decision. Old rows are kept as history, never deleted.

## Safety

- Additive only: one table, three indexes, one CHECK constraint. No existing
  table, column or row is altered or dropped.
- `chk_plot_eudr_review_final_attribution` requires `reviewedByUserId` AND
  `reviewedByName` when `isFinal = true`, so a final clearance can never be
  unattributable — not even via a manual INSERT.
- `down.sql` **refuses** to run while any `isFinal = true` row exists.

## Rehearsal results (PostgreSQL 17.12, local, 2026-11-24)

| step | result |
|---|---|
| `up.sql` on prerequisite schema | PASS — 14 columns, 4 indexes, 1 CHECK |
| unattributed final decision INSERT | correctly REJECTED by CHECK |
| attributed final decision INSERT | accepted |
| `down.sql` with a final decision present | correctly REFUSED, table retained |
| `down.sql` after clearing final rows | PASS, table dropped |
| `up.sql` re-applied | PASS, and idempotent on a second run |

## Status

**NOT applied to production.** Run manually:

```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2037_plot_eudr_review/up.sql
```
