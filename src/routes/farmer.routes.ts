import { Router } from "express";
import { FarmerController } from "../controllers/FarmerController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";
import { upload } from "../middleware/upload.middleware";

const router = Router();
const controller = new FarmerController();

router.get("/", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.BUYER, UserRole.EXPORTER]), (req, res) => controller.getAll(req, res));
router.get("/profile", authMiddleware([UserRole.FARMER, UserRole.ADMIN]), (req, res) => controller.getMe(req, res));
router.get("/search", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]), (req, res) => controller.search(req, res));
// Identity Verification feature. IMPORTANT: these two routes must stay
// ABOVE the generic "/:id" GET route below, otherwise Express would match
// "/verification/queue" as getOne({ id: "verification" }) instead.
// Read access: ADMIN + INSPECTOR (so inspectors can see what still needs
// fixing on records they registered). Write access (verify/flag) is
// ADMIN-only and enforced a second time inside the controller itself
// (FarmerController.canManageVerification) — never rely on route
// middleware alone for an action this sensitive.
router.get("/verification/queue", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]), (req, res) => controller.getVerificationQueue(req, res));
router.post("/verification/bulk", authMiddleware([UserRole.ADMIN]), (req, res) => controller.bulkSetVerificationStatus(req, res));
router.get("/:id/audit-log", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]), (req, res) => controller.getAuditLog(req, res));
router.get("/:id", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.BUYER, UserRole.EXPORTER, UserRole.FARMER]), (req, res) => controller.getOne(req, res));

router.post("/", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]), upload.any(), (req, res) => controller.create(req, res));
router.post("/offline-sync", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]), (req, res) => controller.offlineSync(req, res));
router.put("/:id", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.FARMER]), upload.any(), (req, res) => controller.update(req, res));
router.patch("/:id/status", authMiddleware([UserRole.ADMIN]), (req, res) => controller.setActiveStatus(req, res));
// Identity Verification, single-farmer action. ADMIN-only on the route AND
// re-checked inside the controller (see note above) — a farmer must never
// be able to verify their own identity, and this must not be reachable by
// the generic update() endpoint above (which IS reachable by FARMER).
router.patch("/:id/verification", authMiddleware([UserRole.ADMIN]), (req, res) => controller.setVerificationStatus(req, res));
router.delete("/:id", authMiddleware([UserRole.ADMIN]), (req, res) => controller.delete(req, res));
router.post("/maintenance/backfill-farmer-ids", authMiddleware([UserRole.ADMIN]), (req, res) => controller.backfillFarmerIds(req, res));
// One-time maintenance: unconditionally regenerates every farmer's and
// farm's QR code as GeoJSON (see FarmerController.regenerateQrCodes doc
// comment). Run AFTER POST /farms/backfill-geoids so geoIds are populated
// first. ADMIN-only, safe to re-run.
router.post("/maintenance/regenerate-qr-codes", authMiddleware([UserRole.ADMIN]), (req, res) => controller.regenerateQrCodes(req, res));

export default router;
