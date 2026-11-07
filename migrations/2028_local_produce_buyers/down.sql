-- Rollback for 2028_local_produce_buyers/up.sql. Reviewed but NOT applied
-- to any environment. Drops only what up.sql added; does not touch the
-- pre-existing certificate columns/constraints or any other table.
--
-- *** SAFETY GUARD: this script refuses to run if any Local Produce Buyer
-- records have been imported or issued. *** The DO block below raises an
-- exception if any `certificate` row has
-- `"permitOrLicenceType" = 'LOCAL_BUYER'` — whether created by the
-- historical import (isHistoricalImport = true) or by a live issuance
-- through the normal CMIS workflow (isHistoricalImport = false). The
-- guard runs INSIDE the same transaction as the DROP/ALTER statements
-- below (not before it, and not as its own separate psql statement), so
-- if it raises, the whole transaction aborts and the final COMMIT becomes
-- a no-op rollback — nothing is dropped, regardless of whether this
-- script is invoked with psql's default error-tolerant script mode or
-- with ON_ERROR_STOP=1.
--
-- As long as ANY such record exists, the 12 columns this script drops are
-- the ONLY place several of their values live (verificationToken,
-- sourceRecordId, isPubliclyBlocked, publicBlockReason, buyerDisplayName,
-- county, locality, stagedPermitNumber, isHistoricalImport,
-- importRawData), so dropping them is destructive.
--
-- Tested directly (see README.md "Migration test results" section):
-- bypassing this guard and running the drop after the import has been
-- applied, then re-running up.sql + the import again, does NOT resume
-- cleanly — it creates a full duplicate set of 83 rows (166 total)
-- because the only idempotency key (sourceRecordId) is destroyed, and the
-- original rows silently keep their certificateNumber, forcing every
-- newly re-imported row into stagedPermitNumber with a live (non-held)
-- verification token that would have resolved to a NULL public permit
-- number before the hasIssuedPermitNumber() guard (see
-- PermitVerificationService.ts) was added to both public verification
-- routes to block exactly that case.
--
-- To intentionally roll back the schema in an environment where Local
-- Produce Buyer records already exist, follow the "How to restore the
-- lost values" procedure in README.md — export the 12 columns' values
-- for every LOCAL_BUYER certificate row FIRST, then either temporarily
-- comment out the guard block below or delete the qualifying rows as an
-- explicit, separately reviewed step — never bypass this guard blind.

BEGIN;

DO $$
DECLARE
    buyer_count integer;
BEGIN
    -- Guarded with to_regclass so this script still runs cleanly (no
    -- records possible yet) in an environment where up.sql itself has
    -- never been applied.
    IF to_regclass('public.certificate') IS NOT NULL THEN
        SELECT COUNT(*) INTO buyer_count
        FROM certificate
        WHERE "permitOrLicenceType" = 'LOCAL_BUYER';

        IF buyer_count > 0 THEN
            RAISE EXCEPTION
                'Refusing to run down.sql: % certificate row(s) with permitOrLicenceType = ''LOCAL_BUYER'' already exist (imported and/or issued). Dropping these columns now would permanently destroy their verificationToken, sourceRecordId, isPubliclyBlocked/publicBlockReason, buyerDisplayName/county/locality, stagedPermitNumber, isHistoricalImport, and importRawData values, and a later re-import would create duplicate records rather than resuming cleanly. See migrations/2028_local_produce_buyers/README.md, "How to restore the lost values", before proceeding.',
                buyer_count;
        END IF;
    END IF;
END $$;

DROP TABLE IF EXISTS local_produce_buyer_import_run;
DROP TABLE IF EXISTS local_produce_buyer_sequence;

ALTER TABLE certificate DROP CONSTRAINT IF EXISTS "FK_certificate_agencyCertificateId";
ALTER TABLE certificate DROP CONSTRAINT IF EXISTS "FK_certificate_predecessorCertificateId";
ALTER TABLE certificate DROP CONSTRAINT IF EXISTS "UQ_certificate_sourceRecordId";
ALTER TABLE certificate DROP CONSTRAINT IF EXISTS "UQ_certificate_verificationToken";

ALTER TABLE certificate
    DROP COLUMN IF EXISTS "importRawData",
    DROP COLUMN IF EXISTS "isHistoricalImport",
    DROP COLUMN IF EXISTS "sourceRecordId",
    DROP COLUMN IF EXISTS "stagedPermitNumber",
    DROP COLUMN IF EXISTS "publicBlockReason",
    DROP COLUMN IF EXISTS "isPubliclyBlocked",
    DROP COLUMN IF EXISTS "agencyCertificateId",
    DROP COLUMN IF EXISTS "predecessorCertificateId",
    DROP COLUMN IF EXISTS "locality",
    DROP COLUMN IF EXISTS "county",
    DROP COLUMN IF EXISTS "buyerDisplayName",
    DROP COLUMN IF EXISTS "verificationToken";

COMMIT;

-- NOTE: This rollback does NOT remove any Application/Certificate rows
-- created by the historical import (category = 'LOCAL_BUYER',
-- isHistoricalImport = true) — those are regular rows in tables this
-- migration doesn't own. If a full rollback of the import's DATA (not
-- just schema) is ever needed, that must be a separate, explicitly
-- reviewed data-deletion script, not folded into this schema rollback.
