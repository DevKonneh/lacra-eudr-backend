import { Router } from "express";
import { FarmController } from "../controllers/FarmController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";
import { upload } from "../middleware/upload.middleware";

const router = Router();
const controller = new FarmController();

// ── Standard CRUD ────────────────────────────────────────────────────────────
router.get("/", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.FARMER, UserRole.BUYER]), (req, res) => controller.getAll(req, res));
router.post("/", authMiddleware([UserRole.FARMER, UserRole.ADMIN, UserRole.INSPECTOR]), (req, res) => controller.create(req, res));
router.post("/offline-sync", authMiddleware([UserRole.FARMER, UserRole.ADMIN, UserRole.INSPECTOR]), (req, res) => controller.offlineSync(req, res));

// ── GeoID admin operations ───────────────────────────────────────────────────
// POST /farms/backfill-geoids
//   One-time maintenance: mint GeoIDs for all existing farms that don't have
//   one yet. Safe to call repeatedly — already-minted farms are skipped.
//   ADMIN only.
router.post("/backfill-geoids", authMiddleware([UserRole.ADMIN]), (req, res) => controller.backfillGeoIds(req, res));

// ── Per-farm operations (must come after named sub-routes) ───────────────────
router.get("/:id", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.FARMER, UserRole.BUYER]), (req, res) => controller.getOne(req, res));
router.put("/:id/photos", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.FARMER]), upload.any(), (req, res) => controller.addPhotos(req, res));
router.put("/:id/boundary-evidence", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.FARMER]), upload.any(), (req, res) => controller.addBoundaryEvidence(req, res));

export default router;
