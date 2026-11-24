-- Migration 2037: Plot-level EUDR review decisions (DOWN).
--
-- Status: PROPOSED FOR REVIEW. NOT applied to production.
--
-- DESTRUCTIVE-BY-NATURE: dropping this table discards every recorded human
-- judgement about every plot - who cleared it, who condemned it, and why. That is
-- exactly the evidence a due-diligence file depends on, and it cannot be
-- reconstructed from WhISP (satellite data cannot say what a reviewer decided).
--
-- The guard below refuses while any FINAL decision exists. A recommendation
-- (isFinal = false) is disposable, but a final decision is not: deleting it
-- would silently turn a cleared plot back into an unresolved one, and a
-- non-compliant finding would vanish entirely.

DO $$
DECLARE
    final_decisions integer;
BEGIN
    SELECT count(*) INTO final_decisions
    FROM plot_eudr_review
    WHERE "isFinal" = true;

    IF final_decisions > 0 THEN
        RAISE EXCEPTION
            'Refusing to drop plot_eudr_review: % FINAL EUDR decision(s) are recorded. '
            'Dropping this table would destroy the reviewer, decision and reason for those plots, '
            'silently reopening cleared parcels and erasing confirmed non-compliance. '
            'Export the table first (or delete the rows deliberately) if the decision history is '
            'being abandoned on purpose.', final_decisions;
    END IF;
END $$;

DROP INDEX IF EXISTS idx_plot_eudr_review_final;
DROP INDEX IF EXISTS idx_plot_eudr_review_farm;
DROP INDEX IF EXISTS idx_plot_eudr_review_plot;

DROP TABLE IF EXISTS plot_eudr_review;
