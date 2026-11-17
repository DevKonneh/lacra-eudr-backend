import { Router } from "express";
import { ExportController } from "../controllers/ExportController";
import { authMiddleware } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { UserRole } from "../entities/User";
import { PERMISSIONS } from "../config/permissions";

const router = Router();
const controller = new ExportController();

// CSV export of the full Farmer & Farm Registry — ADMIN only, since this is
// a bulk data dump (no passwords/tokens included, but still sensitive PII).
// requirePermission(...) layered on top so a future narrower custom Role
// assigned to an ADMIN-adjacent account is genuinely enforced here too
// (task #3 — bulk export was explicitly called out as needing its own
// distinct permission, separate from "view").
router.get(
    "/farmers-farms.csv",
    authMiddleware([UserRole.ADMIN]),
    requirePermission(PERMISSIONS.EXPORT_FARMERS_FARMS),
    (req, res) => controller.exportFarmersFarmsCsv(req, res)
);

export default router;
