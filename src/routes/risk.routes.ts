import { Router } from "express";
import { RiskController } from "../controllers/RiskController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const riskController = new RiskController();

// Assess risk for a specific farm (writes a new assessment + can trigger paid Whisp API calls)
router.post("/assess/:farmId", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]), (req, res) => riskController.assessRisk(req, res));

// Get risk assessment history for a farm
router.get("/history/:farmId", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.FARMER, UserRole.BUYER, UserRole.EXPORTER]), (req, res) => riskController.getHistory(req, res));

// Seed/refresh the forest & protected-area reference dataset used for overlap checks (admin only)
router.post("/seed", authMiddleware([UserRole.ADMIN]), (req, res) => riskController.seedForests(req, res));

export default router;
