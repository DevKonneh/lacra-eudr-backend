import { Router } from "express";
import { QualityController } from "../controllers/QualityController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const controller = new QualityController();

router.get("/", authMiddleware(), (req, res) => controller.getAll(req, res));
router.post("/", authMiddleware([UserRole.INSPECTOR, UserRole.ADMIN]), (req, res) => controller.create(req, res));

export default router;
