import { Router } from "express";
import { LicenseController } from "../controllers/LicenseController";
import { authMiddleware } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { UserRole } from "../entities/User";
import { PERMISSIONS } from "../config/permissions";

const router = Router();
const licenseController = new LicenseController();

// Fine-grained requirePermission(...) is layered ON TOP of the existing
// coarse-role authMiddleware([...]) gates below (task #3: "enforce
// permissions in the backend... hiding a button alone is insufficient").
// ADMIN always holds the 'all' wildcard (see config/permissions.ts), so
// every ADMIN-gated route below is unaffected; COMMERCIAL/DG/FINANCE
// accounts with no custom assignedRole fall back to
// DEFAULT_ROLE_PERMISSIONS, which mirrors exactly what these routes
// already allowed before this change (zero access regression) — but an
// admin can now also assign a narrower custom Role to any of these
// accounts and have it genuinely restrict what they can do here.
// NOTE: /apply and /:id/submit are intentionally NOT given a
// requirePermission(...) check — unlike the staff workflow-transition
// routes below, these are the APPLICANT'S OWN self-service endpoints,
// reachable by any authenticated role that owns a Business (not just
// COMMERCIAL/DG/FINANCE staff). Adding a LICENSE_CREATE/LICENSE_EDIT
// requirement here would incorrectly block a self-service applicant
// (e.g. an EXPORTER) whose coarse role has no such permission by default.
// This was deliberately left unchanged pending a closer design decision —
// see the final report's "remaining gaps" section.
router.post("/apply", authMiddleware(), (req, res) => licenseController.apply(req, res));
router.post("/:id/submit", authMiddleware(), (req, res) => licenseController.submit(req, res));

// Same class of gap just fixed on permit.routes.ts: these are
// workflow-transition endpoints (Commercial/DG/Finance stages) that had
// NO role restriction, so any authenticated user - including the
// applicant who owns the license being reviewed - could self-recommend,
// self-approve, self-suspend or self-issue their own official license.
router.post("/:id/recommend", authMiddleware([UserRole.COMMERCIAL, UserRole.ADMIN]), requirePermission(PERMISSIONS.LICENSE_EDIT), (req, res) => licenseController.recommend(req, res)); // Commercial review
router.post("/:id/approve", authMiddleware([UserRole.DG, UserRole.ADMIN]), requirePermission(PERMISSIONS.LICENSE_APPROVE), (req, res) => licenseController.approve(req, res)); // DG decision (body: { decision: 'DG_APPROVED' | 'DG_REJECTED' })
router.post("/:id/suspend", authMiddleware([UserRole.DG, UserRole.ADMIN]), requirePermission(PERMISSIONS.LICENSE_SUSPEND), (req, res) => licenseController.suspend(req, res)); // Suspend an issued license
router.post("/:id/issue", authMiddleware([UserRole.FINANCE, UserRole.ADMIN]), requirePermission(PERMISSIONS.LICENSE_ISSUE), (req, res) => licenseController.issue(req, res)); // Finance issuance

router.get("/", authMiddleware(), requirePermission(PERMISSIONS.LICENSE_VIEW), (req, res) => licenseController.getAll(req, res));
router.get("/my-licenses", authMiddleware(), (req, res) => licenseController.getMyLicenses(req, res));

export default router;
