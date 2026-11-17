import { Router } from "express";
import { RoleController } from "../controllers/RoleController";
import { authMiddleware } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { UserRole } from "../entities/User";
import { PERMISSIONS } from "../config/permissions";

const router = Router();
const roleController = new RoleController();

// Role/permission definitions (create/list/update/delete) are an
// admin-only capability — the admin panel's own nav config gates "Roles &
// Permissions" to ADMIN (and a frontend-only SUPER_ADMIN that has no
// backend equivalent). Kept as a blanket ADMIN gate (see user.routes.ts's
// matching comment for the rationale), layered with fine-grained
// requirePermission(...) checks per route so a future narrower custom Role
// is already genuinely enforced here too.
router.use(authMiddleware([UserRole.ADMIN]));

router.post("/", requirePermission(PERMISSIONS.ROLE_CREATE), (req, res) => roleController.create(req, res));
router.get("/", requirePermission(PERMISSIONS.ROLE_VIEW), (req, res) => roleController.getAll(req, res));
router.get("/:id", requirePermission(PERMISSIONS.ROLE_VIEW), (req, res) => roleController.getOne(req, res));
router.put("/:id", requirePermission(PERMISSIONS.ROLE_EDIT), (req, res) => roleController.update(req, res));
router.delete("/:id", requirePermission(PERMISSIONS.ROLE_DELETE), (req, res) => roleController.delete(req, res));

export default router;
