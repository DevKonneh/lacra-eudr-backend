/**
 * rateLimit.middleware.ts — Rate-limiting for public/unauthenticated endpoints
 *
 * The /api/public/farm-scan routes are intentionally open (no auth token
 * required) so that WHIMO traders and EU auditors can scan any farm QR code
 * without a LACRA account. This openness makes them a DDoS / scraping target,
 * so we apply sensible rate-limits.
 *
 * Two limiters are exported:
 *
 *  farmScanLimiter  — applied to every /api/public/farm-scan/* request.
 *                     Allows a generous burst for legitimate QR scanning
 *                     (a trader at a warehouse might scan dozens of bags in
 *                     quick succession) while blocking automated scrapers.
 *
 *  whimoPayloadLimiter — applied only to the /whimo-payload sub-route, which
 *                        performs a heavier DB + geometry computation. Tighter
 *                        limit than the plain scan endpoint.
 *
 *  generalPublicLimiter — catch-all for all other /api/public/* routes
 *                         (farmer profile, batch, etc.).
 *
 * All limits are tunable via env vars so Render / production admins can adjust
 * without a code change:
 *
 *   RATE_LIMIT_FARM_SCAN_MAX        (default: 120)
 *   RATE_LIMIT_WHIMO_PAYLOAD_MAX    (default: 30)
 *   RATE_LIMIT_PUBLIC_MAX           (default: 60)
 *   RATE_LIMIT_WINDOW_MS            (default: 60000 = 1 minute)
 *
 * Behaviour when the limit is exceeded:
 *   HTTP 429 Too Many Requests  +  JSON body { success: false, message: "..." }
 *   Retry-After header included automatically by express-rate-limit.
 */

import { rateLimit, Options } from "express-rate-limit";
import { Request, Response } from "express";

// ── Shared window duration ────────────────────────────────────────────────────
const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000); // 1 minute

// ── Standard handler — returns JSON instead of plain text ────────────────────
const jsonHandler = (
    _req: Request,
    res: Response,
    _next: unknown,
    options: Options,
) => {
    res.status(options.statusCode).json({
        success: false,
        message: `Too many requests. You have exceeded ${options.max} requests per ${Math.round(windowMs / 1000)} seconds. Please slow down and try again later.`,
        retryAfterSeconds: Math.ceil(windowMs / 1000),
    });
};

// ── Farm-scan limiter (main QR endpoint) ─────────────────────────────────────
/**
 * 120 req / min per IP by default.
 * Covers legitimate WHIMO trader bursts (scanning many bags) while blocking
 * automated scraping of all farm geometries.
 */
export const farmScanLimiter = rateLimit({
    windowMs,
    max: Number(process.env.RATE_LIMIT_FARM_SCAN_MAX ?? 120),
    standardHeaders: "draft-7", // RateLimit-* headers (RFC-compatible)
    legacyHeaders: false,
    handler: jsonHandler,
    keyGenerator: (req) => req.ip ?? "unknown",
    skip: (req) => {
        // Skip for requests coming from within the same Render private network
        // (e.g. backend health checks, internal LACRA services on the same LAN).
        const forwarded = req.headers["x-forwarded-for"];
        const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
        // ::1 = IPv6 localhost, 127.0.0.1 = IPv4 localhost
        return ip === "127.0.0.1" || ip === "::1" || req.ip === "127.0.0.1" || req.ip === "::1";
    },
});

// ── WHIMO payload limiter (heavier computation endpoint) ─────────────────────
/**
 * 30 req / min per IP by default.
 * /whimo-payload runs geometry computation (turf.centroid) on top of the DB
 * query, so it deserves a tighter cap than the plain scan endpoint.
 */
export const whimoPayloadLimiter = rateLimit({
    windowMs,
    max: Number(process.env.RATE_LIMIT_WHIMO_PAYLOAD_MAX ?? 30),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: jsonHandler,
    keyGenerator: (req) => req.ip ?? "unknown",
    skip: (req) => req.ip === "127.0.0.1" || req.ip === "::1",
});

// ── General public limiter (farmers/:id, batches/:id, etc.) ─────────────────
/**
 * 60 req / min per IP by default.
 */
export const generalPublicLimiter = rateLimit({
    windowMs,
    max: Number(process.env.RATE_LIMIT_PUBLIC_MAX ?? 60),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: jsonHandler,
    keyGenerator: (req) => req.ip ?? "unknown",
    skip: (req) => req.ip === "127.0.0.1" || req.ip === "::1",
});
