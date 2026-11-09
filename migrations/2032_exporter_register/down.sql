-- Rollback for 2032_exporter_register/up.sql. Reviewed but NOT applied to
-- any environment. Drops only what up.sql added: the `disputedCounty`
-- column on `certificate` and the `exporter_import_run` table; does not
-- touch any other table/column.
--
-- *** SAFETY GUARD: refuses to run if any Exporter data already exists. ***
-- Mirrors 2028/2029's down.sql guard (row EXISTENCE, not just non-NULL
-- values) — once even one Exporter certificate or import run row exists,
-- dropping this schema would permanently lose that data, so down.sql
-- refuses outright rather than silently discarding it.

BEGIN;

DO $$
DECLARE
    exporter_cert_count integer;
    import_run_count integer;
BEGIN
    IF to_regclass('public.certificate') IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'certificate' AND column_name = 'permitOrLicenceType') THEN
        SELECT COUNT(*) INTO exporter_cert_count FROM certificate WHERE "permitOrLicenceType" = 'EXPORTER';
        IF exporter_cert_count > 0 THEN
            RAISE EXCEPTION
                'Refusing to run down.sql: % Exporter certificate row(s) already exist. Dropping this schema now would permanently lose that data. See migrations/2032_exporter_register/README.md before proceeding.',
                exporter_cert_count;
        END IF;
    END IF;

    IF to_regclass('public.exporter_import_run') IS NOT NULL THEN
        SELECT COUNT(*) INTO import_run_count FROM exporter_import_run;
        IF import_run_count > 0 THEN
            RAISE EXCEPTION
                'Refusing to run down.sql: % exporter_import_run row(s) already exist. Dropping this table now would permanently lose that audit history. See migrations/2032_exporter_register/README.md before proceeding.',
                import_run_count;
        END IF;
    END IF;
END $$;

DROP TABLE IF EXISTS exporter_import_run;
ALTER TABLE certificate DROP COLUMN IF EXISTS "disputedCounty";

COMMIT;
