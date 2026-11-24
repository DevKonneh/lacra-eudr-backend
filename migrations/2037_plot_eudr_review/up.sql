-- Migration 2037: Plot-level EUDR review decisions (UP).
--
-- Status: PROPOSED FOR REVIEW. NOT applied to production.
--
-- WHY THIS EXISTS
-- ---------------
-- WhISP is a satellite service. It can report "post-2020 disturbance detected"
-- or "more_info_needed", but it cannot know whether a parcel was LEGALLY
-- converted, whether title exists, or whether an inspector visited and found the
-- land was already cleared before the cutoff. Those are human judgements, and the
-- six EUDR statuses in the CMIS spec require them:
--
--   'Needs Review'  -> a reviewer must record evidence and RESOLVE the finding.
--   'Non-Compliant' -> an AUTHORISED review confirmed conversion or a violation.
--
-- Before this table CMIS had nowhere to store that judgement. The only persisted
-- truth was WhISP's verdict plus boolean legality/traceability flags derived from
-- documents, so "resolved by a human" could not be represented at all. Deriving
-- it at read time would have meant the report asserting a decision nobody made.
--
-- WHY A NEW TABLE RATHER THAN AN EXISTING WORKFLOW
-- -----------------------------------------------
-- The candidates were examined and each stores something different:
--   * FarmDocument.status   - whether a DOCUMENT is valid, not whether a finding
--                             was reviewed. No reviewer, decision, or reason.
--   * RiskAssessment        - the satellite verdict itself. Adding a reviewer
--                             decision here would overwrite/entangle the very
--                             upstream evidence the audit must preserve.
--   * ComplianceAction      - enforcement workflow against a business/agency, not
--                             a plot-level deforestation finding.
--   * AssessmentJob         - attempt lifecycle of the WhISP call, not a human
--                             judgement.
-- None records { reviewer, decision, reason, evidence, timestamp } against a
-- SPECIFIC plot assessment, so this proceeds as a new table per instruction.
--
-- NON-DESTRUCTIVE
--   * Creates one new table and its indexes. No existing table is altered,
--     no column is dropped, no row is touched.
--   * Rollback (down.sql) is safe while no FINAL decision exists, and refuses
--     otherwise rather than silently discarding recorded judgements.

CREATE TABLE IF NOT EXISTS plot_eudr_review (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The plot this decision is about. CASCADE: deleting a plot removes its
    -- reviews, because a review of a non-existent parcel is meaningless.
    "plotId" uuid NOT NULL REFERENCES plot(id) ON DELETE CASCADE,

    -- Denormalised farm id so the report can query per farm without a join.
    "farmId" uuid NOT NULL REFERENCES farm(id) ON DELETE CASCADE,

    -- ── The specific assessment reviewed ─────────────────────────────────────
    -- SET NULL (not CASCADE): if a RiskAssessment row is ever removed, the
    -- human decision must SURVIVE as an audit record. The decision is about the
    -- parcel, not about the row's continued existence.
    "riskAssessmentId" uuid REFERENCES risk_assessment(id) ON DELETE SET NULL,

    -- ── The specific boundary reviewed ───────────────────────────────────────
    -- sha256 of the polygon. If the plot's boundary later changes, this review no
    -- longer describes the parcel on the map and must not restore clearance.
    "geometryHash" varchar(64),
    "geometryVersion" integer,

    -- 'cleared' | 'non_compliant' | 'needs_review'
    -- varchar rather than a native enum so a future outcome needs no ALTER TYPE
    -- on a live table (the same reasoning applied to assessment_job.status).
    decision varchar(32) NOT NULL,

    -- TRUE only for a decision by a holder of the EUDR review permission.
    -- A recommendation (inspector evidence + suggested outcome) is stored with
    -- isFinal = false and can never change a plot's status on its own.
    "isFinal" boolean NOT NULL DEFAULT false,

    -- Plain-language justification. Required for 'non_compliant' by the API.
    reason text NOT NULL,

    -- Supporting evidence: document refs, photo URLs, inspection ids, notes.
    evidence jsonb,

    -- Who decided. SET NULL on account deletion so the audit row survives.
    "reviewedByUserId" uuid REFERENCES "user"(id) ON DELETE SET NULL,
    "reviewedByName" varchar(255),
    "reviewedByRole" varchar(64),

    "createdAt" timestamp NOT NULL DEFAULT now()
);

-- The report reads "latest review for this plot"; the resolver reads "the most
-- recent FINAL review that still matches the current boundary".
CREATE INDEX IF NOT EXISTS idx_plot_eudr_review_plot
    ON plot_eudr_review ("plotId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_plot_eudr_review_farm
    ON plot_eudr_review ("farmId", "createdAt" DESC);

-- Partial index for the decision lookup, which only ever wants final rows.
CREATE INDEX IF NOT EXISTS idx_plot_eudr_review_final
    ON plot_eudr_review ("plotId", "createdAt" DESC)
    WHERE "isFinal" = true;

-- Guard rail: a final decision must say who made it. Enforced in the database as
-- well as the API so a bug (or a manual INSERT) cannot create an unattributable
-- clearance.
ALTER TABLE plot_eudr_review
    DROP CONSTRAINT IF EXISTS chk_plot_eudr_review_final_attribution;
ALTER TABLE plot_eudr_review
    ADD CONSTRAINT chk_plot_eudr_review_final_attribution
    CHECK (
        "isFinal" = false
        OR ("reviewedByUserId" IS NOT NULL AND "reviewedByName" IS NOT NULL)
    );
