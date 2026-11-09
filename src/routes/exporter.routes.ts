import { Router } from "express";
import { ExporterController } from "../controllers/ExporterController";
import { ComplianceActionController } from "../controllers/ComplianceActionController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const controller = new ExporterController();
const complianceController = new ComplianceActionController();

// Register listing/filters/profile — any authenticated staff member with
// access to Licensing & Permits can view, consistent with the Agency and
// Local Produce Buyer registers' authMiddleware() with no role
// restriction. Static sub-paths (counties, import/*) must be declared
// BEFORE the /:id-shaped routes so Express doesn't treat them as an :id
// value.
router.get("/", authMiddleware(), (req, res) => controller.getAll(req, res));
router.get("/counties", authMiddleware(), (req, res) => controller.getCounties(req, res));

// Import workflow — ADMIN only, same gating as the Agency/Local Produce
// Buyer import endpoints.
router.get("/import/preview", authMiddleware([UserRole.ADMIN]), (req, res) => controller.previewImport(req, res));
router.post("/import/apply", authMiddleware([UserRole.ADMIN]), (req, res) => controller.applyImport(req, res));
router.get("/import/runs", authMiddleware([UserRole.ADMIN]), (req, res) => controller.getImportRuns(req, res));

router.get("/:id", authMiddleware(), (req, res) => controller.getOne(req, res));
router.get("/:id/qr-code", authMiddleware(), (req, res) => controller.downloadQrCode(req, res));

router.patch("/:id/resolve-conflict", authMiddleware([UserRole.ADMIN]), (req, res) => controller.resolveConflict(req, res));

// Compliance actions (Warning / Fine / Suspend / Revoke / Reinstate) —
// create is ADMIN-only; history is viewable by any authenticated staff
// member, same as the register itself.
router.get("/:id/compliance-actions", authMiddleware(), (req, res) => complianceController.listForCertificate(req, res));
router.post("/:id/compliance-actions", authMiddleware([UserRole.ADMIN]), (req, res) => complianceController.createForCertificate(req, res));

export default router;
