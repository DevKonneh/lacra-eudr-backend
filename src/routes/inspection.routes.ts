import { Router } from "express";
import { InspectionController } from "../controllers/InspectionController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const controller = new InspectionController();

router.get("/", authMiddleware(), (req, res) => controller.getAll(req, res));
router.post("/", authMiddleware([UserRole.INSPECTOR, UserRole.ADMIN]), (req, res) => controller.create(req, res));

export default router;
