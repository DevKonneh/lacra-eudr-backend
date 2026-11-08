# 2030 — Agency logo + Agent/Clerk photo

**Status: PROPOSED FOR REVIEW. NOT applied to production.**

## What this migration does
Adds two new, nullable, additive columns so an Agency can have its own
logo image and each Agent/Clerk can have their own photo, on top of the
Agency Register feature added in `2029_agency_register`:

- `certificate."logoUrl"` (varchar, nullable) — the Agency's own logo
  image. Only ever populated for `permitOrLicenceType = 'AGENCY'`
  certificates; every other category leaves it null and is entirely
  unaffected.
- `agent_personnel."photoUrl"` (varchar, nullable) — each Agent's or
  Clerk's own photo.

Both columns store a Cloudinary `secure_url` string (never a local file
path — Render's filesystem is ephemeral), set via two new endpoints:

- `POST /api/agencies/:id/logo` (multipart field `file`) —
  `AgencyController.uploadAgencyLogo()`
- `POST /api/agencies/:id/personnel/:personnelId/photo` (multipart field
  `file`) — `AgencyController.uploadPersonnelPhoto()`

Both reuse the exact same `upload.middleware` (Multer memoryStorage) +
`uploadFileToCloudinary()` pipeline already used for Farmer/Farm/
Application document uploads — no new upload infrastructure was
introduced.

Neither column is populated by this migration itself. Every existing row
(Agency or otherwise, Agent or Clerk) starts with the new column at
`NULL` and stays that way until someone uploads an image through one of
the two endpoints above.

## Where these are surfaced
- **Admin — Agency profile** (`AgencyProfile.tsx`): a logo uploader in
  the page header next to the Agency name, and a small photo
  uploader/thumbnail next to each Agent/Clerk row.
- **Admin — Agency Register list** (`AgencyRegister.tsx`): a small logo
  thumbnail (or placeholder) in the Agency column.
- **Public — Agency verification page** (`AgencyVerify.tsx`, reached via
  `GET /api/public/agencies/verify/:token`): the Agency's logo is shown
  in the result card header if one has been uploaded.
  `PermitVerificationService.toPublicPermitView()` is the single source
  of truth for this field in the public response (`logoUrl`).
- **Public — Agent verification page** (`AgentVerify.tsx`, reached via
  `GET /api/public/agents/verify/:token`): the Agent's own photo AND
  their parent Agency's logo are both shown (`photoUrl` and
  `agencyLogoUrl` respectively), via
  `PermitVerificationService.toPublicAgentView()`. A Clerk's photo is
  never exposed publicly — Clerks have no public verification page at
  all, exactly as before this migration.

## What this migration deliberately does NOT do
- It does not backfill any existing Agency/Agent record with a logo or
  photo — every upload is a genuine, individually-performed staff action
  going forward.
- It does not change file-size limits or accepted file types beyond what
  the pre-existing `upload.middleware` already enforces (15MB per file,
  any type Cloudinary's `resource_type: "auto"` accepts — in practice,
  staff are expected to upload standard image formats: JPG, PNG, WEBP).
- It does not touch any other table/column outside this additive scope.

## Depends on
`migrations/2029_agency_register/up.sql` must already be applied — the
`agent_personnel` table must exist before this migration's second
`ALTER TABLE` can run.

## Migration test results (staging, disposable copy)

Tested against `eudr_db_agency_staging` with `2029_agency_register/up.sql`
already applied. `DB_SYNCHRONIZE=false` was set for every command below;
schema changes came ONLY from running this `up.sql` file.

1. `up.sql` applied cleanly against the staging copy — both `ALTER TABLE`
   statements succeeded, `\d certificate` and `\d agent_personnel`
   confirmed the new nullable `logoUrl`/`photoUrl` varchar columns.
   **CONFIRMED.**
2. `up.sql` re-applied a second time immediately after — both
   `ADD COLUMN IF NOT EXISTS` guards produced only informational NOTICEs
   ("column already exists, skipping"), zero errors. **CONFIRMED
   IDEMPOTENT.**
3. Verified every pre-existing `certificate` and `agent_personnel` row
   has `logoUrl`/`photoUrl` at `NULL` after the migration (no accidental
   default value, no data loss on existing rows). **CONFIRMED.**
