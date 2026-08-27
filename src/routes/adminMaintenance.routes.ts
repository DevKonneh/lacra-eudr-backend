import { Router } from "express";
import { AdminMaintenanceController } from "../controllers/AdminMaintenanceController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const controller = new AdminMaintenanceController();

// Destructive, ADMIN-only. Requires a literal confirmation phrase in the
// body (see controller) as a guard against accidental invocation.
router.post(
    "/reset-farmer-farm-data",
    authMiddleware([UserRole.ADMIN]),
    (req, res) => controller.resetFarmerFarmData(req, res)
);

export default router;
