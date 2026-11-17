import { Router } from "express";
import { FarmerController } from "../controllers/FarmerController";
import { authMiddleware } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { UserRole } from "../entities/User";
import { upload } from "../middleware/upload.middleware";
import { PERMISSIONS } from "../config/permissions";

const router = Router();
const controller = new FarmerController();

// Fine-grained requirePermission(...) is layered ON TOP of the existing
// coarse-role authMiddleware([...]) gates below (task #3). ADMIN/INSPECTOR
// (and BUYER/EXPORTER where relevant) with no custom assignedRole fall
// back to DEFAULT_ROLE_PERMISSIONS, which mirrors exactly what these
// routes already allowed before this change — zero access regression —
// but an admin can now assign a narrower custom Role and have it
// genuinely restrict what an account can do here.
//
// NOTE: "/profile" (GET, FARMER's own record) and "/:id" PUT (reachable by
// FARMER to edit their OWN profile — see FarmerController.update()'s doc
// comment on why identityStatus is deliberately excluded from that path)
// are intentionally left WITHOUT a requirePermission(...) check: these are
// self-service endpoints with no corresponding "farmer.*" permission
// concept (a farmer isn't granted "farmer.edit" over the whole registry,
// they can only ever touch their own row, which authMiddleware's role
// check alone already scopes to the FARMER role).
router.get("/", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.BUYER, UserRole.EXPORTER]), requirePermission(PERMISSIONS.FARMER_VIEW), (req, res) => controller.getAll(req, res));
router.get("/profile", authMiddleware([UserRole.FARMER, UserRole.ADMIN]), (req, res) => controller.getMe(req, res));
router.get("/search", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]), requirePermission(PERMISSIONS.FARMER_VIEW), (req, res) => controller.search(req, res));
// Identity Verification feature. IMPORTANT: these two routes must stay
// ABOVE the generic "/:id" GET route below, otherwise Express would match
// "/verification/queue" as getOne({ id: "verification" }) instead.
// Read access: ADMIN + INSPECTOR (so inspectors can see what still needs
// fixing on records they registered). Write access (verify/flag) is
// ADMIN-only and enforced a second time inside the controller itself
// (FarmerController.canManageVerification) — never rely on route
// middleware alone for an action this sensitive.
router.get("/verification/queue", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]), requirePermission(PERMISSIONS.FARMER_VIEW), (req, res) => controller.getVerificationQueue(req, res));
router.post("/verification/bulk", authMiddleware([UserRole.ADMIN]), requirePermission(PERMISSIONS.FARMER_VERIFY), (req, res) => controller.bulkSetVerificationStatus(req, res));
router.get("/:id/audit-log", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]), requirePermission(PERMISSIONS.FARMER_VIEW), (req, res) => controller.getAuditLog(req, res));
router.get("/:id", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.BUYER, UserRole.EXPORTER, UserRole.FARMER]), (req, res) => controller.getOne(req, res));

router.post("/", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]), requirePermission(PERMISSIONS.FARMER_CREATE), upload.any(), (req, res) => controller.create(req, res));
router.post("/offline-sync", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]), requirePermission(PERMISSIONS.FARMER_CREATE), (req, res) => controller.offlineSync(req, res));
router.put("/:id", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.FARMER]), upload.any(), (req, res) => controller.update(req, res));
router.patch("/:id/status", authMiddleware([UserRole.ADMIN]), requirePermission(PERMISSIONS.FARMER_EDIT), (req, res) => controller.setActiveStatus(req, res));
// Identity Verification, single-farmer action. ADMIN-only on the route AND
// re-checked inside the controller (see note above) — a farmer must never
// be able to verify their own identity, and this must not be reachable by
// the generic update() endpoint above (which IS reachable by FARMER).
router.patch("/:id/verification", authMiddleware([UserRole.ADMIN]), requirePermission(PERMISSIONS.FARMER_VERIFY), (req, res) => controller.setVerificationStatus(req, res));
router.delete("/:id", authMiddleware([UserRole.ADMIN]), requirePermission(PERMISSIONS.FARMER_DELETE), (req, res) => controller.delete(req, res));
router.post("/maintenance/backfill-farmer-ids", authMiddleware([UserRole.ADMIN]), (req, res) => controller.backfillFarmerIds(req, res));
// One-time maintenance: unconditionally regenerates every farmer's and
// farm's QR code as GeoJSON (see FarmerController.regenerateQrCodes doc
// comment). Run AFTER POST /farms/backfill-geoids so geoIds are populated
// first. ADMIN-only, safe to re-run.
router.post("/maintenance/regenerate-qr-codes", authMiddleware([UserRole.ADMIN]), (req, res) => controller.regenerateQrCodes(req, res));

export default router;
