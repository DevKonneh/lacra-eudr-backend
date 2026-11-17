import { Router } from "express";
import { UserController } from "../controllers/UserController";
import { authMiddleware } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { UserRole } from "../entities/User";
import { PERMISSIONS } from "../config/permissions";

const router = Router();
const userController = new UserController();

// User management (create/list/update/delete) is an admin-only capability
// at the coarse-role level — kept as a blanket ADMIN gate for backward
// compatibility (every existing admin account can still do everything it
// could before). On TOP of that, each route below now also enforces a
// specific fine-grained permission via requirePermission(...), so that if
// an admin is ever downgraded or a narrower custom Role is layered onto an
// account in the future, the fine-grained check is already wired in and
// genuinely enforced — not just reflected in the admin panel's nav/button
// visibility (see config/permissions.ts's and permission.middleware.ts's
// doc comments for the full "activation" rationale behind this change).
router.use(authMiddleware([UserRole.ADMIN]));

router.post("/", requirePermission(PERMISSIONS.USER_CREATE), (req, res) => userController.create(req, res));
router.get("/", requirePermission(PERMISSIONS.USER_VIEW), (req, res) => userController.getAll(req, res));
// IMPORTANT: specific sub-routes must be registered before the generic
// "/:id" route below, otherwise Express would match "/:id/audit-log" as
// ":id" = "someId/audit-log" and never reach this handler.
router.get("/supervisors/options", requirePermission(PERMISSIONS.USER_VIEW), (req, res) => userController.getSupervisorOptions(req, res));
router.get("/:id/audit-log", requirePermission(PERMISSIONS.USER_VIEW), (req, res) => userController.getAuditLog(req, res));
router.patch("/:id/status", requirePermission(PERMISSIONS.USER_SUSPEND), (req, res) => userController.setStatus(req, res));
// Explicit session-revocation endpoint (task #5). Separate permission from
// USER_SUSPEND since revoking sessions does not change the account's
// status at all.
router.post("/:id/revoke-sessions", requirePermission(PERMISSIONS.USER_REVOKE_SESSIONS), (req, res) => userController.revokeSessions(req, res));
router.get("/:id", requirePermission(PERMISSIONS.USER_VIEW), (req, res) => userController.getOne(req, res));
router.put("/:id", requirePermission(PERMISSIONS.USER_EDIT), (req, res) => userController.update(req, res));
router.delete("/:id", requirePermission(PERMISSIONS.USER_DELETE), (req, res) => userController.delete(req, res));

export default router;
