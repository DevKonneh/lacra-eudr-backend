import { Router } from "express";
import { BatchController } from "../controllers/BatchController";
import { TransferController } from "../controllers/TransferController";
import { authMiddleware } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { PERMISSIONS } from "../config/permissions";

const router = Router();
const batchController = new BatchController();
const transferController = new TransferController();

// IMPORTANT: create() is the self-service action for an operator with an
// ACTIVE license to record a new batch they personally collected (same
// class of route as license/permit /apply, business /register — see
// those routes' doc comments for the full reasoning). BatchController
// .create() already enforces its own authorization internally (an active
// License tied to req.user.id is required, returns 403 otherwise), so no
// requirePermission(...) is added here — doing so would incorrectly
// block a legitimate BUYER/EXPORTER/INSPECTOR applicant whose coarse role
// has no BATCH_CREATE in DEFAULT_ROLE_PERMISSIONS.
router.post("/", authMiddleware(), (req, res) => batchController.create(req, res));

// Registry browsing / status transitions — previously reachable by ANY
// authenticated user with zero role or permission check at all.
// requirePermission(BATCH_VIEW)/(BATCH_EDIT) is now layered on top of the
// existing bare authMiddleware() (task #3). Every current internal staff
// role (ADMIN, INSPECTOR, BUYER, EXPORTER, FINANCE, TECHNICAL, IT) has
// BATCH_VIEW in DEFAULT_ROLE_PERMISSIONS (ADMIN via the 'all' wildcard),
// so legitimate staff workflows are unaffected — only a FARMER or
// FIELD_SUPERVISOR account (which never had a reason to browse the
// batch registry) would now be correctly blocked.
router.get("/", authMiddleware(), requirePermission(PERMISSIONS.BATCH_VIEW), (req, res) => batchController.getAll(req, res));
router.get("/:id/custody-history", authMiddleware(), requirePermission(PERMISSIONS.TRANSFER_VIEW), (req, res) => transferController.getCustodyHistory(req, res));
router.get("/:id", authMiddleware(), requirePermission(PERMISSIONS.BATCH_VIEW), (req, res) => batchController.getTrace(req, res));
router.put("/:id/status", authMiddleware(), requirePermission(PERMISSIONS.BATCH_EDIT), (req, res) => batchController.updateStatus(req, res));

export default router;
