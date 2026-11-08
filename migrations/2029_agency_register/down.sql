-- Rollback for 2029_agency_register/up.sql. Reviewed but NOT applied to
-- any environment. Drops only what up.sql added; does not touch any
-- pre-existing certificate column/constraint or any other table.
--
-- *** SAFETY GUARD: this script refuses to run if any Agency records
-- have been imported or issued. *** The DO block below raises an
-- exception if any `certificate` row has
-- `"permitOrLicenceType" = 'AGENCY'` OR if any `agent_personnel` row
-- exists at all — whether created by the historical import
-- (isHistoricalImport = true) or by a live issuance through the normal
-- CMIS workflow. The guard runs INSIDE the same transaction as the
-- DROP/ALTER statements below, exactly mirroring 2028's down.sql safety
-- pattern, so if it raises, the whole transaction aborts and nothing is
-- dropped.
--
-- As long as ANY such record exists, staffingFlagged/staffingFlagReason
-- on `certificate` and the entire agent_personnel table are the ONLY
-- place their values live — dropping them is destructive.
--
-- To intentionally roll back the schema in an environment where Agency
-- records already exist, export every AGENCY-category certificate row's
-- staffingFlagged/staffingFlagReason and every agent_personnel row FIRST,
-- then either temporarily comment out the guard block below or delete
-- the qualifying rows as an explicit, separately reviewed step — never
-- bypass this guard blind.

BEGIN;

DO $$
DECLARE
    agency_count integer;
    personnel_count integer;
BEGIN
    IF to_regclass('public.certificate') IS NOT NULL THEN
        SELECT COUNT(*) INTO agency_count
        FROM certificate
        WHERE "permitOrLicenceType" = 'AGENCY';

        IF agency_count > 0 THEN
            RAISE EXCEPTION
                'Refusing to run down.sql: % certificate row(s) with permitOrLicenceType = ''AGENCY'' already exist (imported and/or issued). Dropping staffingFlagged/staffingFlagReason now would permanently destroy their staffing-review state. See migrations/2029_agency_register/README.md before proceeding.',
                agency_count;
        END IF;
    END IF;

    IF to_regclass('public.agent_personnel') IS NOT NULL THEN
        SELECT COUNT(*) INTO personnel_count FROM agent_personnel;

        IF personnel_count > 0 THEN
            RAISE EXCEPTION
                'Refusing to run down.sql: % agent_personnel row(s) already exist. Dropping this table now would permanently destroy every Agent/Clerk record, their verification tokens, and their appointment/replacement/deactivation history. See migrations/2029_agency_register/README.md before proceeding.',
                personnel_count;
        END IF;
    END IF;
END $$;

DROP TABLE IF EXISTS agency_import_run;
DROP TABLE IF EXISTS agent_personnel;

DROP TYPE IF EXISTS "agent_personnel_status_enum";
DROP TYPE IF EXISTS "agent_personnel_role_enum";

ALTER TABLE certificate
    DROP COLUMN IF EXISTS "staffingFlagReason",
    DROP COLUMN IF EXISTS "staffingFlagged";

COMMIT;

-- NOTE: This rollback does NOT remove any Application/Certificate rows
-- created by the historical import (category = 'AGENCY',
-- isHistoricalImport = true) — those are regular rows in tables this
-- migration doesn't own (and the guard above refuses to run at all while
-- any exist). If a full rollback of the import's DATA (not just schema)
-- is ever needed, that must be a separate, explicitly reviewed
-- data-deletion script, not folded into this schema rollback.
