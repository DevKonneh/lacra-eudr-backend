import { Router } from "express";
import { BatchController } from "../controllers/BatchController";
import { TransferController } from "../controllers/TransferController";
import { authMiddleware } from "../middleware/auth.middleware";

const router = Router();
const batchController = new BatchController();
const transferController = new TransferController();

router.post("/", authMiddleware(), (req, res) => batchController.create(req, res));
router.get("/", authMiddleware(), (req, res) => batchController.getAll(req, res));
router.get("/:id/custody-history", authMiddleware(), (req, res) => transferController.getCustodyHistory(req, res));
router.get("/:id", authMiddleware(), (req, res) => batchController.getTrace(req, res));
router.put("/:id/status", authMiddleware(), (req, res) => batchController.updateStatus(req, res));

export default router;
