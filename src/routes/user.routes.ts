import { Router } from "express";
import { UserController } from "../controllers/UserController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const userController = new UserController();

// User management (create/list/update/delete) is an admin-only capability.
// Previously this had no role restriction, meaning ANY authenticated role
// (e.g. INSPECTOR, FARMER) could create/list/update/delete other users.
router.use(authMiddleware([UserRole.ADMIN]));

router.post("/", (req, res) => userController.create(req, res));
router.get("/", (req, res) => userController.getAll(req, res));
router.get("/:id", (req, res) => userController.getOne(req, res));
router.put("/:id", (req, res) => userController.update(req, res));
router.delete("/:id", (req, res) => userController.delete(req, res));

export default router;
