import { Router } from "express";
import { LicenseController } from "../controllers/LicenseController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const licenseController = new LicenseController();

router.post("/apply", authMiddleware(), (req, res) => licenseController.apply(req, res));
router.post("/:id/submit", authMiddleware(), (req, res) => licenseController.submit(req, res));

// Same class of gap just fixed on permit.routes.ts: these are
// workflow-transition endpoints (Commercial/DG/Finance stages) that had
// NO role restriction, so any authenticated user - including the
// applicant who owns the license being reviewed - could self-recommend,
// self-approve, self-suspend or self-issue their own official license.
router.post("/:id/recommend", authMiddleware([UserRole.COMMERCIAL, UserRole.ADMIN]), (req, res) => licenseController.recommend(req, res)); // Commercial review
router.post("/:id/approve", authMiddleware([UserRole.DG, UserRole.ADMIN]), (req, res) => licenseController.approve(req, res)); // DG decision (body: { decision: 'DG_APPROVED' | 'DG_REJECTED' })
router.post("/:id/suspend", authMiddleware([UserRole.DG, UserRole.ADMIN]), (req, res) => licenseController.suspend(req, res)); // Suspend an issued license
router.post("/:id/issue", authMiddleware([UserRole.FINANCE, UserRole.ADMIN]), (req, res) => licenseController.issue(req, res)); // Finance issuance

router.get("/", authMiddleware(), (req, res) => licenseController.getAll(req, res));
router.get("/my-licenses", authMiddleware(), (req, res) => licenseController.getMyLicenses(req, res));

export default router;
