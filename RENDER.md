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
| `FRONTEND_URL` | `https://eudr.netdivs.us` | Used for CORS + QR profile links |
| `API_BASE_URL` | `https://lacra-eudr-backend.onrender.com` | Used to build farm-scan QR code URLs — **must be the public backend URL** |
| `CORS_EXTRA_ORIGINS` | `https://eudr.netdivs.us` | Comma-separated extra CORS origins beyond defaults |
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
