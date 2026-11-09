import { Router } from "express";
import { CooperativePermitController } from "../controllers/CooperativePermitController";
import { ComplianceActionController } from "../controllers/ComplianceActionController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const controller = new CooperativePermitController();
const complianceController = new ComplianceActionController();

// Mounted at /api/cooperative-permits — deliberately NOT /api/cooperatives,
// which is already taken by the unrelated CDA Cooperative directory
// (CooperativeController.ts, membership/location reference data with no
// Certificate linkage). See CooperativePermitController's doc comment.
//
// Register listing/filters/profile — any authenticated staff member with
// access to Licensing & Permits can view, consistent with the Agency/
// Exporter/Local Produce Buyer registers' authMiddleware() with no role
// restriction. Static sub-paths must be declared BEFORE the /:id-shaped
// routes so Express doesn't treat "counties" as an :id value.
router.get("/", authMiddleware(), (req, res) => controller.getAll(req, res));
router.get("/counties", authMiddleware(), (req, res) => controller.getCounties(req, res));

router.get("/:id", authMiddleware(), (req, res) => controller.getOne(req, res));
router.get("/:id/qr-code", authMiddleware(), (req, res) => controller.downloadQrCode(req, res));

// Compliance actions (Warning / Fine / Suspend / Revoke / Reinstate) —
// create is ADMIN-only; history is viewable by any authenticated staff
// member, same as every other register.
router.get("/:id/compliance-actions", authMiddleware(), (req, res) => complianceController.listForCertificate(req, res));
router.post("/:id/compliance-actions", authMiddleware([UserRole.ADMIN]), (req, res) => complianceController.createForCertificate(req, res));

export default router;
