import { Router } from "express";
import { FarmerController } from "../controllers/FarmerController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const controller = new FarmerController();

router.get("/", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.BUYER, UserRole.EXPORTER]), (req, res) => controller.getAll(req, res));
router.get("/profile", authMiddleware([UserRole.FARMER, UserRole.ADMIN]), (req, res) => controller.getMe(req, res));
router.get("/:id", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.BUYER, UserRole.EXPORTER, UserRole.FARMER]), (req, res) => controller.getOne(req, res));
import { upload } from "../middleware/upload.middleware";

router.post("/", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]), upload.any(), (req, res) => controller.create(req, res));
router.post("/offline-sync", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]), (req, res) => controller.offlineSync(req, res));
router.put("/:id", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.FARMER]), upload.any(), (req, res) => controller.update(req, res));
router.patch("/:id/status", authMiddleware([UserRole.ADMIN]), (req, res) => controller.setActiveStatus(req, res));
router.post("/maintenance/backfill-farmer-ids", authMiddleware([UserRole.ADMIN]), (req, res) => controller.backfillFarmerIds(req, res));

export default router;
