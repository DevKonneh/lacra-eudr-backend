# Migration 2036 — Resumable WHISP polling

**Status: PROPOSED FOR REVIEW. NOT applied to production.**

## The problem

Migration 2035's worker submitted a polygon to WHISP and then **waited inside the
queue tick** for the analysis to finish. Verified against the live service on
2026-11-21, that design had two defects:

1. **The polling window was guessed, not asked for.** The client gave up after
   30 × 3s = **90 seconds**, while `GET /api/config` reports
   `analysisTimeoutAsyncSeconds: 1800` (**30 minutes**). A legitimately slow or
   complex parcel could be declared failed by *our* client while WHISP was still
   working correctly.

2. **A "failed" parcel was re-submitted.** Nothing recorded the analysis token,
   so the retry path had no way to resume — it submitted the polygon again. Each
   retry therefore paid for a **second Earth Engine analysis of the same parcel**,
   and held a worker for the whole window.

## The fix

Split submission from polling into two resumable steps:

| Step | When | What is persisted |
|---|---|---|
| Submit | first tick | `whispToken`, `pollDeadlineAt`, `analysisInFlight = true` |
| Poll | later ticks | `pollCount`, `lastPolledAt`, then the result |

Consequences:

- **No worker is held** for the analysis. A tick submits (or re-checks) and
  returns; the job is picked up again on a later tick.
- **No resubmission** on restart, deploy, or retry — the stored token is polled.
- **No early failure** — the deadline comes from the server's own configured
  window, with a 30s margin, and falls back to 1800s if `/api/config` is
  unreachable (never shorter than the server allows).
- **Polling never consumes the retry budget.** `pollCount` is deliberately
  separate from `attempts`, because "still running" is not a failure.

## Schema changes

All **additive**. New columns on `assessment_job`:

| Column | Type | Null | Default | Purpose |
|---|---|---|---|---|
| `whispToken` | varchar(255) | yes | — | WHISP analysis token, for resuming |
| `pollDeadlineAt` | bigint | yes | — | Absolute epoch-ms deadline (server-derived) |
| `lastPolledAt` | timestamp | yes | — | Last status probe, for operations |
| `analysisInFlight` | boolean | no | `false` | Token issued, analysis not yet terminal |
| `pollCount` | integer | no | `0` | Status probes for the current token |

Plus a **partial** index, `idx_assessment_job_polling`, on `nextAttemptAt`
`WHERE analysisInFlight = true` — the resume query only ever touches rows that
are actually being polled, so the index stays small.

## Backfill

**None required.** Existing rows get `whispToken IS NULL` and
`analysisInFlight = false`, which the worker reads as *"not yet submitted"* —
precisely the previous behaviour. No existing row changes meaning.

## Rollback

`down.sql` is destructive **by nature**: dropping these columns discards the
tokens in-flight jobs are holding, so those analyses could not be resumed and
would need re-submission.

It therefore **refuses to run** while any job has `analysisInFlight = true`,
naming the count and explaining the consequence. To proceed deliberately,
either wait for those analyses to finish or clear the flag on the rows whose
results are being abandoned:

```sql
UPDATE assessment_job SET "analysisInFlight" = false WHERE ...;
```

## Non-destructive guarantees

- No row deleted; no existing column altered or dropped.
- `farm.riskLevel` / `lastRiskAssessmentDate` untouched — historical verdicts
  keep exactly the meaning they had.
- No geometry reshaped or simplified.
