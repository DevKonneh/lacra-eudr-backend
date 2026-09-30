import "reflect-metadata";
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';

dotenv.config();

// ── Production startup validation ─────────────────────────────────────────────
// Warn loudly (but don't crash) when critical env vars are missing.
// This surfaces misconfigurations in Render's deploy log at startup time
// rather than silently falling back to defaults and breaking at request time.
(function validateEnv() {
    interface EnvCheck {
        key: string;
        required: boolean;
        description: string;
        defaultValue?: string;
    }

    const checks: EnvCheck[] = [
        // Core
        { key: "JWT_SECRET",           required: true,  description: "JWT signing secret — auth will be broken without this" },
        { key: "DATABASE_URL",         required: false, description: "Postgres connection string (alternative to DB_HOST/PORT/etc.)" },
        { key: "DB_HOST",              required: false, description: "Postgres host — required if DATABASE_URL not set" },
        // GeoID
        { key: "GEOID_BASE_URL",       required: false, description: "FAO GeoID API base — defaults to staging (data.review.fao.org)", defaultValue: "https://data.review.fao.org/geoid" },
        { key: "GEOID_COLLECTION_ID",  required: false, description: "FAO named collection — leave blank for public anonymous collection" },
        { key: "GEOID_API_TOKEN",      required: false, description: "FAO collection auth token — required when GEOID_COLLECTION_ID is set" },
        { key: "API_BASE_URL",         required: false, description: "Backend public URL — used to build farm-scan QR code URLs", defaultValue: "http://localhost:8100" },
        // WHIMO
        { key: "WHIMO_API_BASE_URL",   required: false, description: "WHIMO API base", defaultValue: "https://api.whimo.net/v1" },
        { key: "WHIMO_API_KEY",        required: false, description: "WHIMO API key — required to submit transactions on behalf of operators" },
        { key: "WHIMO_ORG_ID",         required: false, description: "LACRA WHIMO organisation ID" },
        // Cloudinary
        { key: "CLOUDINARY_CLOUD_NAME",required: false, description: "Cloudinary — photo uploads will fail without this" },
        { key: "CLOUDINARY_API_KEY",   required: false, description: "Cloudinary API key" },
        { key: "CLOUDINARY_API_SECRET",required: false, description: "Cloudinary API secret" },
    ];

    const missing: string[] = [];
    const warnings: string[] = [];

    for (const check of checks) {
        const value = process.env[check.key];
        if (!value) {
            if (check.required) {
                missing.push(`  ❌  REQUIRED  ${check.key.padEnd(25)} — ${check.description}`);
            } else if (!check.defaultValue) {
                warnings.push(`  ⚠️   OPTIONAL  ${check.key.padEnd(25)} — ${check.description}`);
            }
            // If there's a hardcoded default, no noise needed — it's documented in .env.example
        }
    }

    // Special cross-field check: named collection requires a token
    if (process.env.GEOID_COLLECTION_ID && !process.env.GEOID_API_TOKEN) {
        warnings.push("  ⚠️   GEOID_COLLECTION_ID is set but GEOID_API_TOKEN is missing — writes to the named collection will be rejected by FAO");
    }

    if (missing.length > 0) {
        console.error("\n🚨  LACRA startup — REQUIRED env vars are missing:");
        missing.forEach(m => console.error(m));
        console.error("  The server will start but these features will be broken.\n");
    }

    if (warnings.length > 0) {
        console.warn("\n⚠️   LACRA startup — optional env vars not set (features may be limited):");
        warnings.forEach(w => console.warn(w));
        console.warn("");
    }

    if (missing.length === 0 && warnings.length === 0) {
        console.log("✅  LACRA startup — all env vars accounted for.");
    }
})();

import { AppDataSource } from "./data-source";
import farmerRoutes from "./routes/farmer.routes";

const app = express();
const PORT = process.env.PORT || 8100;

// ── Trust proxy ───────────────────────────────────────────────────────────────
// Render (and most cloud PaaS) sit behind a reverse proxy / load-balancer.
// Without this setting, req.ip always equals the proxy's internal IP address,
// which makes rate-limiting useless — every single client would share the same
// "IP" from Express's perspective and collectively hit the cap in seconds.
//
// Setting trust proxy to 1 tells Express to read the real client IP from the
// X-Forwarded-For header injected by Render's proxy layer.
//
// Do NOT set to `true` (which trusts all hops) — that would allow a client to
// forge their own IP by sending a spoofed X-Forwarded-For header directly.
// "1" means "trust exactly one proxy hop" which is correct for Render's setup.
//
// References:
//   https://expressjs.com/en/guide/behind-proxies.html
//   https://render.com/docs/web-services#http-headers
app.set("trust proxy", 1);

// Allow the known local/dev origins plus any extra origins supplied via the
// CORS_EXTRA_ORIGINS env var (comma-separated), so the deployed frontend
// domain can be added without another code change/redeploy of this file.
const defaultOrigins = [
    "https://eudr.netdivs.us",
    "http://localhost:8100",
    "http://localhost:8180",
    "http://localhost:5173",
    "http://localhost:5060",
];
const extraOrigins = (process.env.CORS_EXTRA_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
const allowedOrigins = [...defaultOrigins, ...extraOrigins];

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, server-to-server)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        // Allow any *.onrender.com subdomain (frontend/backend both hosted on Render)
        if (/\.onrender\.com$/.test(new URL(origin).hostname)) {
            return callback(null, true);
        }
        return callback(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: true
}));
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(express.json());

// Serve uploaded files (farmer/farm photos, IDs, signatures) as static assets
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.get('/', (req, res) => {
    res.send('LACRA Platform API is running');
});

import riskRoutes from "./routes/risk.routes";
import reportsRoutes from "./routes/reports.routes";
import authRoutes from "./routes/auth.routes";
import licenseRoutes from "./routes/license.routes";
import batchRoutes from "./routes/batch.routes";
import shipmentRoutes from "./routes/shipment.routes";
import satelliteRoutes from "./routes/satellite.routes";
import farmRoutes from "./routes/farm.routes";
import documentRoutes from "./routes/document.routes";
import roleRoutes from "./routes/role.routes";
import userRoutes from "./routes/user.routes";
import publicRoutes from "./routes/public.routes";
import businessRoutes from "./routes/business.routes";
import transferRoutes from "./routes/transfer.routes";
import notificationRoutes from "./routes/notification.routes";

import permitRoutes from "./routes/permit.routes";
import inspectionRoutes from "./routes/inspection.routes";
import qualityRoutes from "./routes/quality.routes";
import enforcementRoutes from "./routes/enforcement.routes";
import offlineSubmissionRoutes from "./routes/offlineSubmission.routes";
import exportRoutes from "./routes/export.routes";
import adminMaintenanceRoutes from "./routes/adminMaintenance.routes";
import weatherRoutes from "./routes/weather.routes";
import soilRoutes from "./routes/soil.routes";

app.use("/api/public", publicRoutes);
app.use("/api/business", businessRoutes);
app.use("/api/transfers", transferRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/permits", permitRoutes);
app.use("/api/inspections", inspectionRoutes);
app.use("/api/quality", qualityRoutes);
app.use("/api/enforcement", enforcementRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/licenses", licenseRoutes);
app.use("/api/batches", batchRoutes);
app.use("/api/shipments", shipmentRoutes);
app.use("/api/farmers", farmerRoutes);
app.use("/api/farms", farmRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api/risk", riskRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/satellite", satelliteRoutes);
app.use("/api/roles", roleRoutes);
app.use("/api/users", userRoutes);
app.use("/api/offline-submissions", offlineSubmissionRoutes);
app.use("/api/export", exportRoutes);
app.use("/api/admin-maintenance", adminMaintenanceRoutes);
app.use("/api/weather", weatherRoutes);
app.use("/api/soil", soilRoutes);

import { errorHandler } from "./middleware/error.middleware";
app.use(errorHandler);

// IMPORTANT: Only start accepting HTTP requests AFTER the database connection
// (and TypeORM entity metadata) is fully initialized. Previously the server
// called app.listen() unconditionally, regardless of whether the DB connection
// succeeded, which meant that if the DB connection failed for any reason
// (wrong host/credentials/SSL settings), the server would keep running forever
// in a broken state, silently returning "No metadata for ... was found" errors
// on every single request instead of failing loudly.
AppDataSource.initialize()
    .then(() => {
        console.log("Database connected successfully.");
        app.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}`);
        });
    })
    .catch((error) => {
        console.error("FATAL: Database connection failed. Server will not start.");
        // Print the exact DB_HOST value with visible markers, in case it
        // contains hidden whitespace/newlines from a copy-paste mistake in
        // a dashboard UI (e.g. "host.com\n" fails DNS lookup but looks fine
        // visually). This is logged with JSON.stringify so any hidden
        // characters show up as escape sequences (like \n) instead of being
        // invisible in the log output.
        console.error("DB_HOST env value was:", JSON.stringify(process.env.DB_HOST));
        console.error(error);
        process.exit(1);
    });
