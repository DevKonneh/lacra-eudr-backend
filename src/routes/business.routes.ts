import { Router } from "express";
import { BusinessController } from "../controllers/BusinessController";
import { authMiddleware } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { UserRole } from "../entities/User";
import { PERMISSIONS } from "../config/permissions";

const router = Router();
const businessController = new BusinessController();

// IMPORTANT: /register and /me are the APPLICANT'S OWN self-service
// endpoints (same class of route as license/permit /apply — see those
// routes' doc comments for the full reasoning). Any authenticated role can
// register their own business and view it; no fine-grained permission
// check is added here, since FARMER/BUYER/EXPORTER/etc. accounts have no
// BUSINESS_* permission in DEFAULT_ROLE_PERMISSIONS by design, and adding
// one would incorrectly block a legitimate self-service applicant.
router.post("/register", authMiddleware(), (req, res) => businessController.register(req, res));
router.get("/me", authMiddleware(), (req, res) => businessController.getMyBusiness(req, res));

// Lists every business's registration number, KYC documents, and owner —
// this was previously reachable by ANY authenticated user (bare
// authMiddleware() with no role check), despite the "Admin only typically"
// comment that used to sit here. Restricted to the roles that actually
// need the full registry: ADMIN, and COMMERCIAL/DG who look up a
// business's eligibility during Application-workflow review. Fine-grained
// requirePermission(BUSINESS_VIEW) is layered ON TOP of that existing
// coarse-role gate (task #3) — ADMIN/COMMERCIAL/DG with no custom
// assignedRole all have BUSINESS_VIEW in DEFAULT_ROLE_PERMISSIONS (or the
// 'all' wildcard for ADMIN), so this introduces no access regression.
router.get(
    "/",
    authMiddleware([UserRole.ADMIN, UserRole.COMMERCIAL, UserRole.DG]),
    requirePermission(PERMISSIONS.BUSINESS_VIEW),
    (req, res) => businessController.getAll(req, res)
);

export default router;
