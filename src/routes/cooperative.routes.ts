import { Router } from "express";
import { CooperativeController } from "../controllers/CooperativeController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const controller = new CooperativeController();

// -----------------------------------------------------------------
// Staff-facing Cooperative Registry directory. Order matters: these
// more-specific paths must be registered BEFORE the public "/" and
// "/:id" routes below so Express doesn't greedily match "/directory" or
// "/import/preview" as an :id param on the public getOne route.
// -----------------------------------------------------------------
router.get("/directory", authMiddleware(), (req, res) => controller.getDirectory(req, res));
router.get("/:id/detail", authMiddleware(), (req, res) => controller.getDetail(req, res));
router.patch("/:id/correct", authMiddleware([UserRole.ADMIN]), (req, res) => controller.correct(req, res));

// Data-quality flags.
router.post("/scan", authMiddleware([UserRole.ADMIN]), (req, res) => controller.scan(req, res));
router.post("/:id/flags", authMiddleware([UserRole.ADMIN]), (req, res) => controller.createFlag(req, res));
router.patch("/flags/:flagId/review", authMiddleware([UserRole.ADMIN]), (req, res) => controller.reviewFlag(req, res));

// Reviewed-import maintenance workflow (replaces the old one-click
// "seed" action with a preview-then-apply flow — see
// CooperativeController's doc comments for the full rationale).
router.get("/import/preview", authMiddleware([UserRole.ADMIN]), (req, res) => controller.previewImport(req, res));
router.post("/import/apply", authMiddleware([UserRole.ADMIN]), (req, res) => controller.applyImport(req, res));
router.get("/import/runs", authMiddleware([UserRole.ADMIN]), (req, res) => controller.getImportRuns(req, res));

// No authMiddleware on purpose — see CooperativeController's class doc
// comment. This is published, non-sensitive reference data that must be
// reachable from the admin panel's unauthenticated public self-service
// farmer registration page, in addition to every logged-in flow (mobile
// app, admin RegisterFarmer.tsx). UNCHANGED shape/behavior from before.
router.get("/", (req, res) => controller.getAll(req, res));

// ADMIN-only: (re-)seeds the registry over HTTP — kept for backward
// compatibility; now an alias for the reviewed import/apply path above.
// @deprecated prefer POST /api/cooperatives/import/apply
router.post("/seed", authMiddleware([UserRole.ADMIN]), (req, res) => controller.seed(req, res));

router.get("/:id", (req, res) => controller.getOne(req, res));

export default router;
