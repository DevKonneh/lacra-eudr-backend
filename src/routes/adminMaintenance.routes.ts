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

// ── Integration health-check ──────────────────────────────────────────────────
// GET /api/admin-maintenance/integration-health
// Returns DB + GeoID + WHIMO connectivity status, GeoID coverage stats,
// and environment variable configuration report.
// ADMIN only — safe to call repeatedly (read-only).
router.get(
    "/integration-health",
    authMiddleware([UserRole.ADMIN]),
    (req, res) => controller.integrationHealth(req, res)
);

export default router;
