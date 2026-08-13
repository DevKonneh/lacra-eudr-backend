import { Router } from "express";
import { NotificationController } from "../controllers/NotificationController";
import { authMiddleware } from "../middleware/auth.middleware";

const router = Router();
const controller = new NotificationController();

router.get("/", authMiddleware(), (req, res) => controller.getMine(req, res));
router.patch("/:id/read", authMiddleware(), (req, res) => controller.markRead(req, res));
router.post("/mark-all-read", authMiddleware(), (req, res) => controller.markAllRead(req, res));

export default router;
