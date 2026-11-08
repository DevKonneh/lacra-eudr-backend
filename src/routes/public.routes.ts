import { Router } from "express";
import { FarmerController } from "../controllers/FarmerController";
import { BatchController } from "../controllers/BatchController";
import { FarmScanController } from "../controllers/FarmScanController";
import { PermitVerificationController } from "../controllers/PermitVerificationController";
import { optionalAuthMiddleware } from "../middleware/auth.middleware";
import {
    farmScanLimiter,
    whimoPayloadLimiter,
    generalPublicLimiter,
} from "../middleware/rateLimit.middleware";

const router = Router();
const farmerController = new FarmerController();
const batchController = new BatchController();
const farmScanController = new FarmScanController();
const permitVerificationController = new PermitVerificationController();

// ── Farmer profile (QR-code / card verification target) ─────────────────────
// This is what every farmer's QR code and printed card resolve to, and it
// must stay reachable with NO login (that's the whole point of a scannable
// card). optionalAuthMiddleware decodes a Bearer token WHEN ONE IS SENT but
// never rejects the request for lacking one — getPublicFarmer() then uses
// req.user (if populated) to decide which of two response shapes to return:
// a redacted "basic verification" view for anonymous scanners, or the full
// profile for an authenticated ADMIN/INSPECTOR/BUYER/EXPORTER session (see
// getPublicFarmer() for the exact field-level split).
router.get("/farmers/:id", generalPublicLimiter, optionalAuthMiddleware(), (req, res) => farmerController.getPublicFarmer(req, res));

// ── Batch (public supply-chain view) ────────────────────────────────────────
router.get("/batches/:id", generalPublicLimiter, (req, res) => batchController.getPublicBatch(req, res));

// ── Local Produce Buyer permit verification (QR code resolver) ──────────────
// This is what every Local Produce Buyer permit's printed/downloadable QR
// code resolves to. No login required, returns only the approved field
// whitelist (buyer name, county, permit number, issue/expiry date, live
// status) — see PermitVerificationController + PermitVerificationService.
router.get("/permits/verify/:token", generalPublicLimiter, (req, res) => permitVerificationController.verifyByToken(req, res));

// ── Agency / Agent permit verification (QR code resolvers) ──────────────────
// Agencies get their own token (resolved the same way as a Local Produce
// Buyer permit); each authorized Agent additionally gets their OWN,
// separate token so a scanner can verify the specific individual even
// when several Agents under one Agency share that Agency's printed permit
// number. See PermitVerificationController.verifyAgencyToken /
// verifyAgentToken + PermitVerificationService's Agent-specific helpers.
router.get("/agencies/verify/:token", generalPublicLimiter, (req, res) => permitVerificationController.verifyAgencyToken(req, res));
router.get("/agents/verify/:token", generalPublicLimiter, (req, res) => permitVerificationController.verifyAgentToken(req, res));

// ── Farm Scan (QR code resolver) ─────────────────────────────────────────────
// These are the endpoints the farm QR code resolves to.
//
//  GET /public/farm-scan/:farmId
//    Default (view=geo):  geo-only payload for WHIMO / traders (no PII)  [120 req/min]
//    ?view=full:          full farmer + farm data for LACRA internal app
//
//  GET /public/farm-scan/geoid/:geoid
//    Resolve by GeoID instead of farmId — useful when trader has a GeoID
//    from a previous WHIMO transaction and wants to look up the farm.    [120 req/min]
//
//  GET /public/farm-scan/:farmId/whimo-payload
//    Convenience: returns EXACTLY WHIMO's TransactionProducerCreateRequest
//    field names, ready to pre-fill the WHIMO transaction form.          [30 req/min]
//
// Order matters: static sub-paths must be declared BEFORE /:farmId so Express
// doesn't treat "geoid", "whimo-payload" or "whimo" as farmId values.
//
//  GET /farm-scan/whimo/commodities  — LACRA→WHIMO commodity map + live validation [30/min]
//  GET /farm-scan/geoid/:geoid       — resolve by GeoID                             [120/min]
//  GET /farm-scan/:farmId/whimo-payload — full WHIMO transaction pre-fill           [30/min]
//  GET /farm-scan/:farmId            — geo-only scan (default) or full (?view=full) [120/min]
router.get("/farm-scan/whimo/commodities",     whimoPayloadLimiter, (req, res) => farmScanController.whimoCommodities(req, res));
router.get("/farm-scan/geoid/:geoid",          farmScanLimiter,     (req, res) => farmScanController.scanByGeoId(req, res));
router.get("/farm-scan/:farmId/whimo-payload", whimoPayloadLimiter, (req, res) => farmScanController.whimoPayload(req, res));
router.get("/farm-scan/:farmId",               farmScanLimiter,     (req, res) => farmScanController.scan(req, res));

export default router;
