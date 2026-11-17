import { Router } from "express";
import { PermitController } from "../controllers/PermitController";
import { authMiddleware } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { UserRole } from "../entities/User";
import { PERMISSIONS } from "../config/permissions";

const router = Router();
const permitController = new PermitController();

// NOTE: POST "/", GET "/:id", PUT "/:id", POST "/:id/submit" are the
// APPLICANT'S OWN self-service endpoints (same reasoning as license.routes.
// ts's /apply and /:id/submit) — reachable by any authenticated role that
// owns a Business, not just COMMERCIAL/DG/FINANCE staff. No
// requirePermission(...) is added to these for the same reason: a
// permit.create/permit.review requirement here would incorrectly block a
// self-service applicant (e.g. EXPORTER) whose coarse role has no such
// permission by default. Flagged as a design decision, not an oversight.
router.post("/", authMiddleware(), (req, res) => permitController.create(req, res));
router.get("/:id", authMiddleware(), (req, res) => permitController.getOne(req, res));
router.put("/:id", authMiddleware(), (req, res) => permitController.update(req, res));
router.post("/:id/submit", authMiddleware(), (req, res) => permitController.submit(req, res));

// These three are workflow-transition endpoints equivalent to the
// Application workflow's Commercial/DG/Finance stages (see the matching
// role-gates on application.routes.ts), but previously had NO role
// restriction at all - just a comment naming the intended role. That meant
// ANY authenticated user, including the applicant who owns the permit
// being reviewed, could call these directly to self-recommend, self-
// approve and self-issue their own official government permit.
//
// requirePermission(...) is layered ON TOP of the existing coarse-role
// authMiddleware([...]) gates (task #3: real backend enforcement, not just
// hiding a button) — see license.routes.ts's matching comment for the full
// rationale.
router.post("/:id/recommend", authMiddleware([UserRole.COMMERCIAL, UserRole.ADMIN]), requirePermission(PERMISSIONS.PERMIT_EDIT), (req, res) => permitController.recommend(req, res)); // Commercial
router.post("/:id/approve", authMiddleware([UserRole.DG, UserRole.ADMIN]), requirePermission(PERMISSIONS.PERMIT_APPROVE), (req, res) => permitController.approve(req, res)); // DG
router.post("/:id/issue", authMiddleware([UserRole.FINANCE, UserRole.ADMIN]), requirePermission(PERMISSIONS.PERMIT_ISSUE), (req, res) => permitController.issue(req, res)); // Finance

router.get("/", authMiddleware(), (req, res) => permitController.getAll(req, res));

export default router;
