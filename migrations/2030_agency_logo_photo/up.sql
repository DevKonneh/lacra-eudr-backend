-- Phase 3b: Agency logo + Agent/Clerk photo — staging migration (UP).
--
-- Status: PROPOSED FOR REVIEW. NOT applied to production.
--
-- Adds two new, nullable, additive columns:
--   - certificate.logoUrl           (Agency's own logo image)
--   - agent_personnel.photoUrl      (each Agent/Clerk's own photo)
--
-- Both store a Cloudinary secure_url string, set via the new
-- POST /api/agencies/:id/logo and
-- POST /api/agencies/:id/personnel/:personnelId/photo endpoints
-- (AgencyController.uploadAgencyLogo / uploadPersonnelPhoto), using the
-- exact same uploadFileToCloudinary() pipeline already used for Farmer/
-- Farm/Application document uploads. Neither column is populated by this
-- migration itself — both start NULL for every existing row (Agency or
-- otherwise) and are only ever set going forward via those endpoints.
--
-- Depends on migrations/2029_agency_register/up.sql having already been
-- applied (agent_personnel must exist for the second ALTER below).
--
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2030_agency_logo_photo/up.sql

BEGIN;

ALTER TABLE certificate
    ADD COLUMN IF NOT EXISTS "logoUrl" character varying;

ALTER TABLE agent_personnel
    ADD COLUMN IF NOT EXISTS "photoUrl" character varying;

COMMIT;
