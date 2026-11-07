import { Router } from "express";
import { LocalProduceBuyerController } from "../controllers/LocalProduceBuyerController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const controller = new LocalProduceBuyerController();

// Register listing/filters — any authenticated staff member with access to
// Licensing & Permits can view (consistent with the existing Permit
// Management page's authMiddleware() with no role restriction).
router.get("/", authMiddleware(), (req, res) => controller.getAll(req, res));
router.get("/counties", authMiddleware(), (req, res) => controller.getCounties(req, res));
router.get("/:id/qr-code", authMiddleware(), (req, res) => controller.downloadQrCode(req, res));

// Import workflow and conflict/agency-link resolution — ADMIN only, same
// gating as CooperativeController's import/flag-review endpoints.
router.get("/import/preview", authMiddleware([UserRole.ADMIN]), (req, res) => controller.previewImport(req, res));
router.post("/import/apply", authMiddleware([UserRole.ADMIN]), (req, res) => controller.applyImport(req, res));
router.get("/import/runs", authMiddleware([UserRole.ADMIN]), (req, res) => controller.getImportRuns(req, res));
router.patch("/:id/resolve-conflict", authMiddleware([UserRole.ADMIN]), (req, res) => controller.resolveConflict(req, res));
router.post("/:id/link-agency", authMiddleware([UserRole.ADMIN]), (req, res) => controller.linkAgency(req, res));

export default router;
