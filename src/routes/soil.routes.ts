import { Router } from "express";
import { SoilController } from "../controllers/SoilController";
import { authMiddleware } from "../middleware/auth.middleware";

const router = Router();
const soilController = new SoilController();

// Estimated soil profile for an arbitrary point (e.g. during registration,
// before a farm record exists yet).
router.get("/", authMiddleware(), (req, res) => soilController.getByCoordinates(req, res));

// Estimated soil profile for an existing farm's saved location.
router.get("/farm/:farmId", authMiddleware(), (req, res) => soilController.getByFarm(req, res));

export default router;
