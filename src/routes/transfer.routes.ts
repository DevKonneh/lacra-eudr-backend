import { Router } from "express";
import { TransferController } from "../controllers/TransferController";
import { authMiddleware } from "../middleware/auth.middleware";

const router = Router();
const transferController = new TransferController();

router.post("/", authMiddleware(), (req, res) => transferController.create(req, res));
router.get("/", authMiddleware(), (req, res) => transferController.getByBatch(req, res));
router.get("/audit", authMiddleware(), (req, res) => transferController.getAuditDashboard(req, res));
router.get("/reconciliation", authMiddleware(), (req, res) => transferController.getReconciliation(req, res));

export default router;
