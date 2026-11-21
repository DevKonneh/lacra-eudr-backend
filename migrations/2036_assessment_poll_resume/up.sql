-- Migration 2036: Resumable WHISP polling (UP).
--
-- Status: PROPOSED FOR REVIEW. NOT applied to production.
--
-- WHY THIS EXISTS
-- ---------------
-- Migration 2035 created the assessment queue, whose worker performed the WhISP
-- call and waited inside the request for it to finish. Two problems surfaced
-- when the integration was verified against the live service on 2026-11-21:
--
--   1. THE WINDOW WAS GUESSED, NOT ASKED FOR. The client gave up after
--      30 attempts x 3s = 90s, while GET /api/config reports
--      analysisTimeoutAsyncSeconds: 1800 (30 minutes). A legitimately slow or
--      complex parcel could therefore be failed by OUR client while WhISP was
--      still working.
--
--   2. A "FAILED" PARCEL WAS RE-SUBMITTED. Because nothing recorded the
--      analysis token, the retry path had no way to resume; it submitted the
--      polygon again. That pays for a SECOND Earth Engine analysis of the same
--      parcel, and it also holds a worker for the whole window.
--
-- The fix is to treat submission and polling as separate, resumable steps:
-- submit once, persist the token, and let later worker ticks ask "is it done?".
-- These columns are what make that possible.
--
-- ADDITIVE AND NON-DESTRUCTIVE THROUGHOUT
--   * Only new NULLABLE columns (plus two with safe non-null defaults).
--   * No row is deleted; no existing column is altered or dropped.
--   * Existing 'queued' rows have whispToken IS NULL and analysisInFlight =
--     false, which the worker reads as "not yet submitted" \u2014 exactly the old
--     behaviour, so no backfill is required and nothing changes meaning.

ALTER TABLE assessment_job
    -- WHISP's analysis token. Persisted so polling can RESUME after a retry,
    -- a worker restart, or a deploy \u2014 instead of re-submitting the polygon.
    ADD COLUMN IF NOT EXISTS "whispToken" varchar(255),

    -- Absolute epoch-ms deadline for the current analysis, derived from the
    -- server's own analysisTimeoutAsyncSeconds rather than a hard-coded guess.
    -- Null = no analysis outstanding.
    ADD COLUMN IF NOT EXISTS "pollDeadlineAt" bigint,

    -- Last time we asked WHISP about this token (operational visibility).
    ADD COLUMN IF NOT EXISTS "lastPolledAt" timestamp,

    -- TRUE when a token was issued but the analysis had not yet terminated.
    -- Distinguishes "waiting on WHISP" (resume by polling) from "never
    -- submitted" (a fresh submit is required) across a process restart.
    ADD COLUMN IF NOT EXISTS "analysisInFlight" boolean NOT NULL DEFAULT false,

    -- Count of status PROBES for the current token. Deliberately separate from
    -- "attempts": polling a still-running analysis is not a failed attempt and
    -- must never consume the retry budget.
    ADD COLUMN IF NOT EXISTS "pollCount" integer NOT NULL DEFAULT 0;

-- The worker's resume query is "which jobs have an analysis in flight?".
-- Partial index keeps it small: only rows that are actually being polled.
CREATE INDEX IF NOT EXISTS idx_assessment_job_polling
    ON assessment_job ("nextAttemptAt")
    WHERE "analysisInFlight" = true;
