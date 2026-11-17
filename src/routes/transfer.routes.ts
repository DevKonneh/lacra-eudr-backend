import { Router } from "express";
import { TransferController } from "../controllers/TransferController";
import { authMiddleware } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { PERMISSIONS } from "../config/permissions";

const router = Router();
const transferController = new TransferController();

// Unlike license/permit /apply, recording a transfer (handover/purchase
// between businesses) is a staff-operational action on chain-of-custody
// data the caller does NOT necessarily own themselves — not an applicant
// self-service action — so it is genuinely gated by requirePermission,
// consistent with every current internal role that legitimately performs
// this today (INSPECTOR, BUYER) already holding TRANSFER_CREATE in
// DEFAULT_ROLE_PERMISSIONS.
router.post("/", authMiddleware(), requirePermission(PERMISSIONS.TRANSFER_CREATE), (req, res) => transferController.create(req, res));

// Registry browsing (by-batch list, audit dashboard, reconciliation) —
// previously reachable by ANY authenticated user with zero role or
// permission check (task #3 fix). Every current internal staff role has
// TRANSFER_VIEW in DEFAULT_ROLE_PERMISSIONS, so legitimate workflows are
// unaffected.
router.get("/", authMiddleware(), requirePermission(PERMISSIONS.TRANSFER_VIEW), (req, res) => transferController.getByBatch(req, res));
router.get("/audit", authMiddleware(), requirePermission(PERMISSIONS.TRANSFER_VIEW), (req, res) => transferController.getAuditDashboard(req, res));
router.get("/reconciliation", authMiddleware(), requirePermission(PERMISSIONS.TRANSFER_VIEW), (req, res) => transferController.getReconciliation(req, res));

export default router;
