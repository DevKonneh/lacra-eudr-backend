# Migration 2035 — Automatic per-plot assessment queue

**Status: PROPOSED FOR REVIEW. NOT applied to any environment.**

## Why

Risk assessments were only created when a staff member clicked "Assess". A farm
synced from the Farm Mapping app could therefore sit with no satellite evidence
indefinitely. Automatic assessment now runs **per plot**: when CMIS commits a
plot with an eligible surveyed polygon, a job row is inserted and a background
worker performs the WhISP call.

## What it adds

| Table | Column | Purpose |
|---|---|---|
| `plot` | `geometryHash` | sha256 of the canonicalised boundary — lets the system tell "same polygon synced again" from "corrected polygon" |
| `plot` | `geometryVersion` | Human-facing counter, bumped **only** on a real edit |
| `risk_assessment` | `plotId` | Which plot a verdict describes |
| `risk_assessment` | `geometryHash` / `geometryVersion` | Which polygon the verdict was produced from |
| `risk_assessment` | `supersededByGeometryChange` | Verdict kept as history but excluded from "current rating" |
| `assessment_job` | *(new table)* | The durable queue: status, attempts, backoff, dedupe key |

## The dedupe guarantee

`assessment_job.dedupeKey` = `plotId + ':' + sha256(polygon)`, with a **UNIQUE**
index. A retried sync of an unchanged boundary collides with the existing row
instead of creating a duplicate. This is enforced by Postgres, not by a
check-then-insert that two concurrent syncs could race past.

## Why the backfill leaves `plot.geometryHash` NULL

The application's canonicalisation (ring rotation, winding, coordinate rounding)
is not reproducible in plain SQL without duplicating that logic. A hash that
disagreed with the application's would look like a boundary change on **every**
plot, queueing a flood of spurious assessments.

NULL is the safe default: the application treats "no hash" as "cannot prove this
verdict describes the current polygon", so no legacy verdict is ever presented as
a current per-plot finding. The hash is filled the first time each plot is
enqueued or saved.

## Non-destructive

* No row deleted; no existing column altered or dropped.
* No `farm.location` / `plot.boundary` reshaped or replaced.
* No `farm.riskLevel` / `farm.lastRiskAssessmentDate` touched — historical
  verdicts keep exactly the meaning they had.
* Existing `risk_assessment` rows keep `plotId = NULL`, which is **accurate**:
  they describe a whole farm boundary, not a specific plot. They are deliberately
  not guessed onto a plot, which would fabricate per-plot results no assessment
  ever produced.

## Rollback

`down.sql` drops only what this migration added, and **refuses while any job is
`queued` or `assessing`** — such a row is the only record that an assessment was
requested but never delivered.

## Run

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2035_assessment_queue/up.sql
```

## Verification status

Applied and rolled back successfully against a **local** PostgreSQL 17 +
PostGIS database only. **Never run against staging or production.** The live
WhISP integration has never been exercised end-to-end because no
`WHISP_API_KEY` has ever been configured in an environment reachable from this
work.
