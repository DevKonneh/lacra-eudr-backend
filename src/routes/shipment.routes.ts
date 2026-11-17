import { Router } from "express";
import { ShipmentController } from "../controllers/ShipmentController";
import { authMiddleware } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { PERMISSIONS } from "../config/permissions";

const router = Router();
const shipmentController = new ShipmentController();

// create() is the exporter's own self-service action (bundling their own
// WAREHOUSE-status batches into a shipment destined for export) — same
// class of route as license/permit /apply. EXPORTER already holds
// SHIPMENT_CREATE in DEFAULT_ROLE_PERMISSIONS, matching what this route
// already allowed before this change.
router.post("/", authMiddleware(), requirePermission(PERMISSIONS.SHIPMENT_CREATE), (req, res) => shipmentController.create(req, res));

// SECURITY FIX: validate() performs the EUDR compliance check and, if it
// passes, issues the official Due Diligence Statement (DDS) number for the
// shipment — a government sign-off, not a self-service action (same
// category as license/permit recommend/approve/issue). Previously this
// had NO role or permission restriction at all: any authenticated user,
// including the exporter who owns the shipment being validated, could
// trigger their own compliance check and issue their own DDS. Restricted
// to SHIPMENT_APPROVE, which only ADMIN (via the 'all' wildcard) and DG
// hold in DEFAULT_ROLE_PERMISSIONS — DG is the designated approving
// authority for export compliance, mirroring its existing
// LICENSE_APPROVE/PERMIT_APPROVE role.
router.post("/:id/validate", authMiddleware(), requirePermission(PERMISSIONS.SHIPMENT_APPROVE), (req, res) => shipmentController.validate(req, res));

// Registry browsing — previously reachable by ANY authenticated user with
// zero role or permission check (task #3 fix). Every current internal
// staff role (plus EXPORTER, who legitimately views their own shipments
// in this unfiltered list today) has SHIPMENT_VIEW in
// DEFAULT_ROLE_PERMISSIONS, so no legitimate workflow is broken.
router.get("/", authMiddleware(), requirePermission(PERMISSIONS.SHIPMENT_VIEW), (req, res) => shipmentController.getAll(req, res));
router.get("/:id/dds-data", authMiddleware(), requirePermission(PERMISSIONS.SHIPMENT_VIEW), (req, res) => shipmentController.getDdsData(req, res));

export default router;
