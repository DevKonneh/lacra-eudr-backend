import { Router } from "express";
import { FarmDocumentController } from "../controllers/FarmDocumentController";

const router = Router();
const controller = new FarmDocumentController();

router.post("/", (req, res) => controller.uploadDocument(req, res));
router.get("/:farmId", (req, res) => controller.getDocuments(req, res));
router.patch("/:id/status", (req, res) => controller.updateStatus(req, res));

export default router;
