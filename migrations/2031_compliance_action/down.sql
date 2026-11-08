-- Rollback for 2031_compliance_action/up.sql. Drops only the table
-- up.sql created; does not touch any other table/column.
--
-- *** SAFETY GUARD: refuses to run if any row already exists. *** Unlike
-- 2030's down.sql (which guards on a column's values being non-NULL),
-- this guard fires on ROW EXISTENCE — compliance_action is an immutable,
-- append-only AUDIT LOG by design (see entity-level doc comment in
-- src/entities/ComplianceAction.ts): once a single Warning/Fine/Suspend/
-- Revoke/Reinstate has ever been recorded, dropping this table would
-- permanently destroy that regulatory audit trail, which is exactly the
-- kind of record this feature exists to make impossible to lose.

BEGIN;

DO $$
DECLARE
    row_count integer;
BEGIN
    IF to_regclass('public.compliance_action') IS NOT NULL THEN
        SELECT COUNT(*) INTO row_count FROM compliance_action;
        IF row_count > 0 THEN
            RAISE EXCEPTION
                'Refusing to run down.sql: % compliance_action row(s) already exist. This table is an immutable audit log — dropping it now would permanently destroy that history. See migrations/2031_compliance_action/README.md before proceeding.',
                row_count;
        END IF;
    END IF;
END $$;

DROP INDEX IF EXISTS idx_compliance_action_subject_id;
DROP TABLE IF EXISTS compliance_action;

COMMIT;
