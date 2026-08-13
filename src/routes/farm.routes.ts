import { Router } from "express";
import { FarmController } from "../controllers/FarmController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const controller = new FarmController();


router.get("/", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.FARMER, UserRole.BUYER]), (req, res) => controller.getAll(req, res));
router.get("/:id", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.FARMER, UserRole.BUYER]), (req, res) => controller.getOne(req, res));
router.post("/", authMiddleware([UserRole.FARMER, UserRole.ADMIN, UserRole.INSPECTOR]), (req, res) => controller.create(req, res));
router.post("/offline-sync", authMiddleware([UserRole.FARMER, UserRole.ADMIN, UserRole.INSPECTOR]), (req, res) => controller.offlineSync(req, res));

export default router;
