import { Router } from "express";
import { ShipmentController } from "../controllers/ShipmentController";
import { authMiddleware } from "../middleware/auth.middleware";

const router = Router();
const shipmentController = new ShipmentController();

router.post("/", authMiddleware(), (req, res) => shipmentController.create(req, res));
router.post("/:id/validate", authMiddleware(), (req, res) => shipmentController.validate(req, res));
router.get("/", authMiddleware(), (req, res) => shipmentController.getAll(req, res));
router.get("/:id/dds-data", authMiddleware(), (req, res) => shipmentController.getDdsData(req, res));

export default router;
