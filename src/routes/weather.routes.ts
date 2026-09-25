import { Router } from "express";
import { WeatherController } from "../controllers/WeatherController";
import { authMiddleware } from "../middleware/auth.middleware";

const router = Router();
const weatherController = new WeatherController();

// Current conditions + 7-day forecast for an arbitrary point (e.g. during
// registration, before a farm record exists yet).
router.get("/", authMiddleware(), (req, res) => weatherController.getByCoordinates(req, res));

// Current conditions + 7-day forecast for an existing farm's saved location.
router.get("/farm/:farmId", authMiddleware(), (req, res) => weatherController.getByFarm(req, res));

export default router;
