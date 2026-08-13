import { Router } from "express";
import { EnforcementController } from "../controllers/EnforcementController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const controller = new EnforcementController();

router.get("/", authMiddleware(), (req, res) => controller.getAll(req, res));
router.post("/", authMiddleware([UserRole.ADMIN]), (req, res) => controller.create(req, res));

export default router;
