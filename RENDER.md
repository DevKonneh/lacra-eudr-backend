# LACRA EUDR Backend — Render Deployment Guide

Production hardening runbook for deploying and operating the LACRA platform on Render.

---

## 1. Environment Variables (Render Dashboard)

Go to **Render Dashboard → lacra-eudr-backend → Environment** and set every variable below.

### Required (server won't work without these)

| Variable | Example / Notes |
|---|---|
| `DATABASE_URL` | `postgres://user:pass@host:5432/lacra_eudr?sslmode=require` |
| `JWT_SECRET` | 64-character random string — never share or commit |
| `PORT` | `8100` (Render sets this automatically) |

### Core

| Variable | Value | Notes |
|---|---|---|
| `FRONTEND_URL` | `https://lacra-admin.onrender.com` | Used for CORS + QR profile links. **Must point at the current admin panel** — if this is unset or stale, newly-created/updated farmers get a QR code baked with the wrong (or `localhost`) URL at save time (QR codes are generated once and are NOT regenerated later just because this env var changes — see "Known issue" note below). |
| `API_BASE_URL` | `https://lacra-eudr-backend.onrender.com` | Used to build farm-scan QR code URLs — **must be the public backend URL** |
| `CORS_EXTRA_ORIGINS` | `https://lacra-admin.onrender.com` | Comma-separated extra CORS origins beyond defaults. Not strictly required for this origin specifically, since `src/index.ts`'s CORS allowlist already wildcard-matches any `*.onrender.com` origin — but setting it explicitly here keeps this table self-describing and covers any future custom domain. |

> **Retired domain — do not use**: `eudr.netdivs.us` was the previous developer's frontend URL and is **no longer part of this system** (confirmed by the project owner, Nov 2026). It currently returns a 502 and should not be investigated, repaired, or deployed to. The current, correct production frontend is `https://lacra-admin.onrender.com`. This table previously listed `eudr.netdivs.us` as the example `FRONTEND_URL`/`CORS_EXTRA_ORIGINS` value — that has been corrected above; see git history on this file if the old reference is needed for context.
>
> **Resolved (Nov 2026): stale QR codes backfilled.** All 15 production farmer records previously had a QR code embedding `http://localhost:5173/public/farmers/<id>` (dev URL baked in at creation time, before `FRONTEND_URL` was correctly set in production). Since `qrCode` is only generated once (`FarmerController.ts`, farmer-creation / `!farmer.qrCode` backfill paths) and is never refreshed just because `FRONTEND_URL` changes afterward, a one-off backfill was required and has been run: a disposable script (`src/_tmp_backfill_qr_codes.ts`, deleted after use per repo convention) recomputed and re-saved the `qrCode` column for all 15 existing farmers so each now encodes `https://lacra-admin.onrender.com/public/farmers/<id>`. Verified via: (1) a pre-backfill full `pg_dump` backup, (2) the script's own idempotent dry-run/live-run/dry-run-again cycle (0 updates on the second dry-run), and (3) an independent decode of all 15 stored QR images with `pyzbar`, confirming each decodes to the exact expected URL (15/15 pass). **This fix only covers the database-stored `qrCode` field** — it does not and cannot retroactively update any QR codes that were already printed onto physical ID cards before this fix (see `RegisterFarmer.tsx`'s "Print Identity Card" button, which prints whatever QR was shown at registration time); any such pre-fix printed cards would still scan to a `localhost` URL and should be reissued/reprinted.
>
> **Resolved (Nov 2026): `FRONTEND_URL` confirmed set on Render; a second, smaller backfill was needed.** `FRONTEND_URL` was not present at all in the Render dashboard's Environment list before this (confirmed by direct screenshot review) — it has since been added (`https://lacra-admin.onrender.com`). Between the first QR backfill (Nov 3) and this env var actually being saved (Nov 5), **two new farmers were registered** (Matter Brown, John Brown) and got the same `http://localhost:5173` QR bug as the original 15. A second, identical idempotent backfill (`src/_tmp_backfill_qr_codes2.ts`, deleted after use) was run: dry-run showed exactly these 2 as stale and all other 15 already correct; live run updated exactly those 2 with 0 errors; a follow-up dry-run confirmed 0 remaining updates (17/17 already correct); an independent `pyzbar` decode of all 17 farmers' stored QR images confirms 17/17 now resolve to the correct `https://lacra-admin.onrender.com/public/farmers/<id>` URL. Backed up beforehand (`lacra_pre_qr_backfill2_20261105_073909.dump`). A freshly created, disposable test farmer (created and deleted in the same session, never left in production) was also used to directly confirm newly-generated QR codes are now correct at creation time, independent of any backfill. **No further action needed for `FRONTEND_URL` — confirmed correct and live.**
| `NODE_ENV` | `production` | Enables production optimisations |

### Cloudinary (photo uploads)

| Variable | Where to get |
|---|---|
| `CLOUDINARY_CLOUD_NAME` | Cloudinary dashboard → Account details |
| `CLOUDINARY_API_KEY` | Cloudinary dashboard → API Keys |
| `CLOUDINARY_API_SECRET` | Cloudinary dashboard → API Keys |

### FAO GeoID API

| Variable | Staging | Production | Notes |
|---|---|---|---|
| `GEOID_BASE_URL` | `https://data.review.fao.org/geoid` | `https://data.fao.org/geoid` | Switch to production after registering collection |
| `GEOID_COLLECTION_ID` | `lacra-farms` | `lacra-farms` | See **Section 3** — register first |
| `GEOID_API_TOKEN` | *(from FAO portal)* | *(from FAO portal)* | Required when using a named collection |

### WHIMO API (EU EUDR due-diligence platform)

| Variable | Value | Notes |
|---|---|---|
| `WHIMO_API_BASE_URL` | `https://api.whimo.net/v1` | WHIMO REST API base |
| `WHIMO_API_KEY` | *(from WHIMO org portal)* | Required to submit transactions programmatically |
| `WHIMO_ORG_ID` | *(your LACRA org ID in WHIMO)* | Injected as `operator_id` on transaction payloads |

### Rate limiting (tune for your traffic)

| Variable | Default | Notes |
|---|---|---|
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rolling window in milliseconds (1 minute) |
| `RATE_LIMIT_FARM_SCAN_MAX` | `120` | Max scan requests per IP per window |
| `RATE_LIMIT_WHIMO_PAYLOAD_MAX` | `30` | Max WHIMO-payload requests per IP per window |
| `RATE_LIMIT_PUBLIC_MAX` | `60` | Max general public requests per IP per window |

### Email / SMTP (optional)

| Variable | Example |
|---|---|
| `SMTP_HOST` | `smtp.sendgrid.net` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `apikey` |
| `SMTP_PASS` | *(SendGrid API key)* |

---

## 1a. Feature-Specific Migrations

Some features ship an explicit, reviewed SQL migration instead of relying
on `synchronize: true` alone. **Run these before deploying the
corresponding application code.**

| Feature | Migration | Notes |
|---|---|---|
| Identity Verification | `migrations/2026_identity_verification/up.sql` | See `migrations/2026_identity_verification/README.md` for the migration rationale/rollback, and `migrations/2026_identity_verification/DEPLOYMENT_PLAN.md` for the full ordered live deployment runbook (backup → migrate → verify → deploy code → post-deploy checks). Adds 4 nullable `farmer` columns + 3 `farmer_audit_log_action_enum` values. Tested idempotent against a full schema clone. |
| CMIS Monitoring (supervisor model, field check-in/out, presence, sync status) | `migrations/2027_monitoring/up.sql` | See `migrations/2027_monitoring/README.md` for the full deployment procedure (backup → `psql "$DATABASE_URL" -f migrations/2027_monitoring/up.sql` → verify schema with `DB_SYNCHRONIZE=false` → confirm pre-existing `user`/`farmer`/`farm` row counts unchanged → deploy app code). Adds `FIELD_SUPERVISOR` to `user_role_enum`, `SUPERVISOR_CHANGED`/`TERRITORY_CHANGED` to `user_audit_log_action_enum`, 3 nullable `"user"` columns (`supervisorId`, `assignedCounty`, `assignedDistrict`), and 4 new tables (`field_event`, `mobile_sync_status`, `sign_in_attempt`, `user_session`). Purely additive. Tested idempotent against a disposable clone (`eudr_monitoring_test`) with pre-existing data confirmed unaffected — **has NOT yet been run against the real production database as of this writing; do not deploy the Monitoring application code (commit `0eebcb3` and later) until this migration has been applied to the live `DATABASE_URL`.** |

---

## 2. First Deploy Checklist

After setting all env vars and deploying:

### Step 1 — Verify startup
Check Render logs for the startup validation summary:
```
✅  LACRA startup — all env vars accounted for.
Database connected successfully.
Server is running on port 8100
```

Any `❌ REQUIRED` line means a critical var is missing — fix it and redeploy.

### Step 2 — Run integration health check
```bash
curl -H "Authorization: Bearer <admin-jwt-token>" \
  https://lacra-eudr-backend.onrender.com/api/admin-maintenance/integration-health
```

Expected response when everything is working:
```json
{
  "success": true,
  "data": {
    "status": "ok",
    "integrations": {
      "database":  { "ok": true },
      "geoid_api": { "ok": true },
      "whimo_api": { "ok": true }
    },
    "geoidCoverage": {
      "totalFarms": 450,
      "farmsWithGeoId": 0,
      "farmsMissingGeoId": 450,
      "coveragePct": 0
    },
    "backfillRequired": true
  }
}
```

### Step 3 — Run GeoID backfill (one-time)
Mints GeoIDs for all existing farms that were registered before the GeoID feature launched.

**Option A — Frontend admin page** (recommended):
1. Log in as ADMIN
2. Navigate to **System Admin → GeoID Administration**
3. Click **"Run Backfill"** — live progress stream shows each farm

**Option B — curl with streaming** (for large datasets):
```bash
curl -N \
  -X POST \
  -H "Authorization: Bearer <admin-jwt-token>" \
  "https://lacra-eudr-backend.onrender.com/api/farms/backfill-geoids?stream=1"
```

Each SSE line is a JSON event:
```
data: {"event":"start","total":450}
data: {"event":"progress","processed":1,"total":450,"minted":1,"farmId":"...","geoid":"..."}
data: {"event":"skip","processed":2,"total":450,"skipped":1,"reason":"no valid geometry"}
data: {"event":"done","total":450,"minted":380,"skipped":70}
```

**Option C — curl without streaming** (small datasets only):
```bash
curl -X POST \
  -H "Authorization: Bearer <admin-jwt-token>" \
  "https://lacra-eudr-backend.onrender.com/api/farms/backfill-geoids"
```

> ⚠️  Without `?stream=1`, the request holds open until all farms are processed.
> Render's 30-second request timeout will kill it on datasets > ~200 farms.
> **Always use `?stream=1` in production.**

### Step 4 — Verify backfill
Re-run the health check and confirm `coveragePct` = 100 and `farmsMissingGeoId` = 0.

---

## 3. FAO GeoID Collection Registration

> **Do this before switching `GEOID_BASE_URL` from staging to production.**

### Why this matters
Without a named collection:
- GeoIDs are minted to the **public anonymous collection** — anyone can read them but LACRA has no organisational ownership
- The FAO cannot associate the farms with Liberia / LACRA
- EUDR auditors cannot query "all LACRA-registered farms" from the FAO side

### Registration steps

1. **Go to** https://geoid.openforis.org
2. **Create an organisation account** — use LACRA's official email address
3. **Register a collection** — name it `lacra-farms`
4. **Note the collection token** (Keycloak bearer token from the FAO portal)
5. **Set in Render**:
   ```
   GEOID_COLLECTION_ID = lacra-farms
   GEOID_API_TOKEN     = <token from FAO portal>
   GEOID_BASE_URL      = https://data.fao.org/geoid   ← production URL
   ```
6. **Redeploy** the backend
7. **Re-run backfill** (`POST /api/farms/backfill-geoids?stream=1`) — farms that already have a GeoID are skipped (idempotent), new farms get registered to the named collection

---

## 4. WHIMO Organisation Registration

1. **Go to** https://whimo.net and register LACRA as an operator organisation
2. **Request API access** — you'll receive `WHIMO_API_KEY` and `WHIMO_ORG_ID`
3. **Set in Render** (see Section 1 table above)
4. **Validate the commodity map** by calling:
   ```bash
   curl https://lacra-eudr-backend.onrender.com/api/public/farm-scan/whimo/commodities
   ```
   The response shows which LACRA crop types auto-resolve to WHIMO commodity IDs and whether the IDs match the live WHIMO API. Adjust `WhimoService.ts` if any IDs have changed.

---

## 5. Rate Limit Tuning

The defaults (120/30/60 req/min) are conservative and safe for launch. After 2–4 weeks of production traffic:

1. Check Render logs for `429 Too Many Requests` responses
2. If legitimate users are being rate-limited:
   - Increase `RATE_LIMIT_FARM_SCAN_MAX` (e.g. to 300 for warehouse scanner bursts)
   - Increase `RATE_LIMIT_WHIMO_PAYLOAD_MAX` (e.g. to 60 for WHIMO integration partner)
3. If the server is under DDoS:
   - Decrease limits or add Cloudflare in front of Render

---

## 6. Monitoring

### Recommended uptime checks
Set up external HTTP monitoring (e.g. UptimeRobot, Better Uptime) on:

| Endpoint | Expected | Interval |
|---|---|---|
| `GET /` | `200 LACRA Platform API is running` | 1 min |
| `GET /api/admin-maintenance/integration-health` | `200 { status: "ok" }` | 5 min |

### Render alerts
Enable **"Notify on service crash"** and **"Notify on deploy failure"** in the Render service settings.

---

## 7. Backfill Re-run Policy

The backfill is **idempotent** — farms that already have a `geoId` are skipped. Run it again whenever:

- New farms were imported in bulk (e.g. from a CSV or offline sync batch)
- The GeoID API was temporarily unreachable during registration (farms land with `geoId = NULL`)
- `GEOID_BASE_URL` was changed from staging to production (the same geometry → same GeoID, so existing IDs remain valid; the new collection just indexes them)

---

## 8. Quick Reference — All New Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/admin-maintenance/integration-health` | ADMIN | DB + GeoID + WHIMO health + coverage stats |
| `POST` | `/api/farms/backfill-geoids` | ADMIN | Mint GeoIDs for farms missing them |
| `POST` | `/api/farms/backfill-geoids?stream=1` | ADMIN | Same, with SSE live progress stream |
| `GET` | `/api/public/farm-scan/:farmId` | None | Geo-only scan (WHIMO/traders) |
| `GET` | `/api/public/farm-scan/:farmId?view=full` | None | Full scan (LACRA internal) |
| `GET` | `/api/public/farm-scan/:farmId/whimo-payload` | None | Ready-to-POST WHIMO transaction body |
| `GET` | `/api/public/farm-scan/geoid/:geoid` | None | Resolve by GeoID |
| `GET` | `/api/public/farm-scan/whimo/commodities` | None | Commodity map + live validation |
| `POST` | `/api/farms/backfill-geoids` | ADMIN | One-time backfill |
| `POST` | `/api/monitoring/heartbeat` | Any authenticated | Per-tab presence heartbeat; requires migration `2027_monitoring` |
| `GET` | `/api/monitoring/user-activity` | ADMIN | Staff-wide Online/Idle/Offline presence; requires migration `2027_monitoring` |
| `GET` | `/api/monitoring/users/:id/sign-in-history` | ADMIN | Sign-in attempt history for one user; requires migration `2027_monitoring` |
| `GET` | `/api/monitoring/enumerators` | ADMIN, FIELD_SUPERVISOR | Enumerators visible to the caller (all for admin, direct reports only for a supervisor), including a `reviewProgress` farmer-identity/farm-geometry status breakdown scoped to that enumerator's own records; requires migration `2027_monitoring` (no schema change for `reviewProgress` itself — reuses existing `Farmer.identityStatus`/`Farm.geometryStatus` columns) |
| `GET` | `/api/monitoring/enumerators/:id` | ADMIN, FIELD_SUPERVISOR | Single enumerator summary + field activity timeline + `reviewProgress` breakdown; 403 if not visible to the caller; requires migration `2027_monitoring` |
| `POST` | `/api/offline-submissions/sync-status` | ADMIN, INSPECTOR | Mobile app reports its offline-sync cycle result (pending count / success / error); requires migration `2027_monitoring` |
