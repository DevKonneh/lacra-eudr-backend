import { Router } from "express";
import { LocalProduceBuyerController } from "../controllers/LocalProduceBuyerController";
import { ComplianceActionController } from "../controllers/ComplianceActionController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";
import { upload } from "../middleware/upload.middleware";

const router = Router();
const controller = new LocalProduceBuyerController();
const complianceController = new ComplianceActionController();

// Register listing/filters — any authenticated staff member with access to
// Licensing & Permits can view (consistent with the existing Permit
// Management page's authMiddleware() with no role restriction).
router.get("/", authMiddleware(), (req, res) => controller.getAll(req, res));
router.get("/counties", authMiddleware(), (req, res) => controller.getCounties(req, res));
router.get("/:id/qr-code", authMiddleware(), (req, res) => controller.downloadQrCode(req, res));

// Profile photo upload — any authenticated staff member, same convention
// as the Agency logo/personnel photo uploads (multipart field name "file").
router.post("/:id/photo", authMiddleware(), upload.single("file"), (req, res) => controller.uploadBuyerPhoto(req, res));

// Import workflow and conflict/agency-link resolution — ADMIN only, same
// gating as CooperativeController's import/flag-review endpoints.
router.get("/import/preview", authMiddleware([UserRole.ADMIN]), (req, res) => controller.previewImport(req, res));
router.post("/import/apply", authMiddleware([UserRole.ADMIN]), (req, res) => controller.applyImport(req, res));
router.get("/import/runs", authMiddleware([UserRole.ADMIN]), (req, res) => controller.getImportRuns(req, res));
router.patch("/:id/resolve-conflict", authMiddleware([UserRole.ADMIN]), (req, res) => controller.resolveConflict(req, res));
router.post("/:id/link-agency", authMiddleware([UserRole.ADMIN]), (req, res) => controller.linkAgency(req, res));

// Compliance actions (Warning / Fine / Suspend / Revoke / Reinstate) —
// create is ADMIN-only; history is viewable by any authenticated staff
// member, same as the register itself.
router.get("/:id/compliance-actions", authMiddleware(), (req, res) => complianceController.listForCertificate(req, res));
router.post("/:id/compliance-actions", authMiddleware([UserRole.ADMIN]), (req, res) => complianceController.createForCertificate(req, res));

export default router;
