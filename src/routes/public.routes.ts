import { Router } from "express";
import { FarmerController } from "../controllers/FarmerController";
import { BatchController } from "../controllers/BatchController";
import { FarmScanController } from "../controllers/FarmScanController";
import {
    farmScanLimiter,
    whimoPayloadLimiter,
    generalPublicLimiter,
} from "../middleware/rateLimit.middleware";

const router = Router();
const farmerController = new FarmerController();
const batchController = new BatchController();
const farmScanController = new FarmScanController();

// ── Farmer profile (LACRA internal app — full PII) ───────────────────────────
router.get("/farmers/:id", generalPublicLimiter, (req, res) => farmerController.getPublicFarmer(req, res));

// ── Batch (public supply-chain view) ────────────────────────────────────────
router.get("/batches/:id", generalPublicLimiter, (req, res) => batchController.getPublicBatch(req, res));

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
