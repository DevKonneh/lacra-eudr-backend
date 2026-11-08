-- Rollback for 2030_agency_logo_photo/up.sql. Reviewed but NOT applied to
-- any environment. Drops only the two columns up.sql added; does not
-- touch any other table/column.
--
-- *** SAFETY GUARD: refuses to run if any row actually has a logo/photo
-- uploaded. *** Unlike 2029's down.sql (which guards on row EXISTENCE),
-- this guard only fires once someone has actually uploaded at least one
-- logo or photo — dropping these columns before any upload has happened
-- is harmless (both are NULL-only at that point), but once a real
-- Cloudinary URL has been saved, dropping the column would permanently
-- lose that reference (the file itself would still exist on Cloudinary,
-- but the record of which Agency/Agent it belongs to would be gone).

BEGIN;

DO $$
DECLARE
    logo_count integer;
    photo_count integer;
BEGIN
    IF to_regclass('public.certificate') IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'certificate' AND column_name = 'logoUrl') THEN
        SELECT COUNT(*) INTO logo_count FROM certificate WHERE "logoUrl" IS NOT NULL;
        IF logo_count > 0 THEN
            RAISE EXCEPTION
                'Refusing to run down.sql: % certificate row(s) already have a logoUrl set. Dropping this column now would permanently lose those references. See migrations/2030_agency_logo_photo/README.md before proceeding.',
                logo_count;
        END IF;
    END IF;

    IF to_regclass('public.agent_personnel') IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_personnel' AND column_name = 'photoUrl') THEN
        SELECT COUNT(*) INTO photo_count FROM agent_personnel WHERE "photoUrl" IS NOT NULL;
        IF photo_count > 0 THEN
            RAISE EXCEPTION
                'Refusing to run down.sql: % agent_personnel row(s) already have a photoUrl set. Dropping this column now would permanently lose those references. See migrations/2030_agency_logo_photo/README.md before proceeding.',
                photo_count;
        END IF;
    END IF;
END $$;

ALTER TABLE certificate DROP COLUMN IF EXISTS "logoUrl";
ALTER TABLE agent_personnel DROP COLUMN IF EXISTS "photoUrl";

COMMIT;
