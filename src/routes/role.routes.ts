import { Router } from "express";
import { RoleController } from "../controllers/RoleController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const roleController = new RoleController();

// Role/permission definitions (create/list/update/delete) are an
// admin-only capability — the admin panel's own nav config gates "Roles &
// Permissions" to ADMIN (and a frontend-only SUPER_ADMIN that has no
// backend equivalent). Previously this only required authMiddleware()
// with no role check, so ANY authenticated user (e.g. INSPECTOR, FARMER)
// could call these endpoints directly, bypassing the UI restriction
// entirely.
router.use(authMiddleware([UserRole.ADMIN]));

router.post("/", (req, res) => roleController.create(req, res));
router.get("/", (req, res) => roleController.getAll(req, res));
router.get("/:id", (req, res) => roleController.getOne(req, res));
router.put("/:id", (req, res) => roleController.update(req, res));
router.delete("/:id", (req, res) => roleController.delete(req, res));

export default router;
