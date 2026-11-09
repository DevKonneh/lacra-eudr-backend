import { Router } from "express";
import { ManualLicenseEntryController } from "../controllers/ManualLicenseEntryController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const controller = new ManualLicenseEntryController();

// Staff-only: recording an already-issued paper license/permit is a
// Commercial/Marketing-staff action, not a public/applicant-facing one
// (self-registration is not yet live) — gated the same way the rest of
// the Commercial-stage workflow is (UserRole.COMMERCIAL, plus ADMIN as
// the universal override used throughout this codebase).
router.post("/", authMiddleware([UserRole.COMMERCIAL, UserRole.ADMIN]), (req, res) => controller.create(req, res));

export default router;
