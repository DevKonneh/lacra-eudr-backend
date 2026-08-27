import { Router } from "express";
import { ExportController } from "../controllers/ExportController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const controller = new ExportController();

// CSV export of the full Farmer & Farm Registry — ADMIN only, since this is
// a bulk data dump (no passwords/tokens included, but still sensitive PII).
router.get(
    "/farmers-farms.csv",
    authMiddleware([UserRole.ADMIN]),
    (req, res) => controller.exportFarmersFarmsCsv(req, res)
);

export default router;
