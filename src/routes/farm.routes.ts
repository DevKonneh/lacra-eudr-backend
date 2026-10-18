import { Router } from "express";
import { FarmController } from "../controllers/FarmController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";
import { upload } from "../middleware/upload.middleware";

const router = Router();
const controller = new FarmController();

// GPS polygon / farm-area geometry validation — Data Correction Queue.
// Admin/Inspector only: read-only listing + re-validate-only actions that
// NEVER delete or modify a farm's actual boundary coordinates (see
// FarmController's Data Correction Queue methods for full rationale).
// MUST be registered BEFORE "GET /:id" below — otherwise Express would
// match "/geometry/data-correction-queue" as GET "/:id" with id="geometry".
router.get("/geometry/data-correction-queue", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]), (req, res) => controller.getDataCorrectionQueue(req, res));
router.post("/geometry/revalidate-all", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]), (req, res) => controller.revalidateAllGeometry(req, res));

// ── GeoID admin operations ───────────────────────────────────────────────────
// POST /farms/backfill-geoids
//   One-time maintenance: mint GeoIDs for all existing farms that don't have
//   one yet. Safe to call repeatedly — already-minted farms are skipped.
//   ADMIN only. MUST be registered BEFORE "GET /:id" for the same reason as
//   the geometry routes above.
router.post("/backfill-geoids", authMiddleware([UserRole.ADMIN]), (req, res) => controller.backfillGeoIds(req, res));

// ── Standard CRUD ────────────────────────────────────────────────────────────
router.get("/", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.FARMER, UserRole.BUYER]), (req, res) => controller.getAll(req, res));
router.get("/:id", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.FARMER, UserRole.BUYER]), (req, res) => controller.getOne(req, res));
router.post("/", authMiddleware([UserRole.FARMER, UserRole.ADMIN, UserRole.INSPECTOR]), upload.any(), (req, res) => controller.create(req, res));
router.post("/offline-sync", authMiddleware([UserRole.FARMER, UserRole.ADMIN, UserRole.INSPECTOR]), (req, res) => controller.offlineSync(req, res));
router.put("/:id/photos", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.FARMER]), upload.any(), (req, res) => controller.addPhotos(req, res));
router.put("/:id/boundary-evidence", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.FARMER]), upload.any(), (req, res) => controller.addBoundaryEvidence(req, res));
router.post("/:id/geometry/revalidate", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]), (req, res) => controller.revalidateGeometry(req, res));

// Multi-commodity management: add/update/deactivate a commodity on a farm
// WITHOUT deleting the farm record itself (see FarmController for details).
router.post("/:id/commodities", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.FARMER]), (req, res) => controller.addCommodity(req, res));
router.put("/:id/commodities/:commodityId", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.FARMER]), (req, res) => controller.updateCommodity(req, res));
router.put("/:id/commodities/:commodityId/deactivate", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.FARMER]), (req, res) => controller.deactivateCommodity(req, res));

export default router;
