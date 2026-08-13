import { Router } from "express";
import { SatelliteController } from "../controllers/SatelliteController";
import { authMiddleware } from "../middleware/auth.middleware";

const router = Router();
const satelliteController = new SatelliteController();

router.get("/temporal", authMiddleware(), (req, res) => satelliteController.getTemporalAnalysis(req, res));
router.get("/alerts", authMiddleware(), (req, res) => satelliteController.getAlerts(req, res));
router.get("/tile-config", (req, res) => satelliteController.getTileConfig(req, res));

export default router;
