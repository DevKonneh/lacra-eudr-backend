import { Router } from "express";
import { AgencyController } from "../controllers/AgencyController";
import { ComplianceActionController } from "../controllers/ComplianceActionController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";
import { upload } from "../middleware/upload.middleware";

const router = Router();
const controller = new AgencyController();
const complianceController = new ComplianceActionController();

// Register listing/filters/profile — any authenticated staff member with
// access to Licensing & Permits can view, consistent with the Local
// Produce Buyer register's authMiddleware() with no role restriction.
// Static sub-paths (counties, import/*, personnel/unassigned) must be
// declared BEFORE the /:id-shaped routes so Express doesn't treat them
// as an :id value.
router.get("/", authMiddleware(), (req, res) => controller.getAll(req, res));
router.get("/counties", authMiddleware(), (req, res) => controller.getCounties(req, res));
router.get("/personnel/unassigned", authMiddleware(), (req, res) => controller.getUnassignedPersonnel(req, res));

// Import workflow — ADMIN only, same gating as the Local Produce Buyer
// import endpoints.
router.get("/import/preview", authMiddleware([UserRole.ADMIN]), (req, res) => controller.previewImport(req, res));
router.post("/import/apply", authMiddleware([UserRole.ADMIN]), (req, res) => controller.applyImport(req, res));
router.get("/import/runs", authMiddleware([UserRole.ADMIN]), (req, res) => controller.getImportRuns(req, res));

router.get("/:id", authMiddleware(), (req, res) => controller.getOne(req, res));
router.get("/:id/qr-code", authMiddleware(), (req, res) => controller.downloadQrCode(req, res));
router.get("/:id/personnel/:personnelId/qr-code", authMiddleware(), (req, res) => controller.downloadPersonnelQrCode(req, res));

// Logo/photo uploads — any authenticated staff member (consistent with
// the roster-management routes below), multipart field name "file",
// stored on Cloudinary via the same upload.middleware/cloudUpload
// pipeline already used for Farmer/Farm/Application document uploads.
router.post("/:id/logo", authMiddleware(), upload.single("file"), (req, res) => controller.uploadAgencyLogo(req, res));
router.post("/:id/personnel/:personnelId/photo", authMiddleware(), upload.single("file"), (req, res) => controller.uploadPersonnelPhoto(req, res));

// Staffing roster management — any authenticated staff member (consistent
// with the register's own read access); conflict resolution and
// agency-linking remain ADMIN-only, mirroring the Local Produce Buyer
// pattern's link-agency/resolve-conflict gating.
router.post("/:id/personnel", authMiddleware(), (req, res) => controller.appointPersonnel(req, res));
router.post("/:id/personnel/:personnelId/replace", authMiddleware(), (req, res) => controller.replacePersonnel(req, res));
router.patch("/:id/personnel/:personnelId/deactivate", authMiddleware(), (req, res) => controller.deactivatePersonnel(req, res));
router.post("/:id/personnel/:personnelId/link", authMiddleware([UserRole.ADMIN]), (req, res) => controller.linkPersonnelToAgency(req, res));

router.patch("/:id/resolve-conflict", authMiddleware([UserRole.ADMIN]), (req, res) => controller.resolveConflict(req, res));

// Compliance actions (Warning / Fine / Suspend / Revoke / Reinstate) —
// create is ADMIN-only (matches resolve-conflict/link-personnel gating);
// history is viewable by any authenticated staff member, same as the
// register/profile itself.
router.get("/:id/compliance-actions", authMiddleware(), (req, res) => complianceController.listForCertificate(req, res));
router.post("/:id/compliance-actions", authMiddleware([UserRole.ADMIN]), (req, res) => complianceController.createForCertificate(req, res));
router.get("/:agencyId/personnel/:personnelId/compliance-actions", authMiddleware(), (req, res) => complianceController.listForPersonnel(req, res));
router.post("/:agencyId/personnel/:personnelId/compliance-actions", authMiddleware([UserRole.ADMIN]), (req, res) => complianceController.createForPersonnel(req, res));

export default router;
