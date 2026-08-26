import { Router } from "express";
import { FarmDocumentController } from "../controllers/FarmDocumentController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";
import { upload } from "../middleware/upload.middleware";

const router = Router();
const controller = new FarmDocumentController();

// Single document (JSON documentUrl, or a "document" multipart file field).
router.post(
    "/",
    authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.FARMER]),
    upload.any(),
    (req, res) => controller.uploadDocument(req, res)
);

// Multiple documents in one request ("documents" file field(s) + a
// parallel "types" JSON array) - used by the mobile app's Compliance
// Documents upload step when attaching documents to an existing farm
// (e.g. added after initial registration).
router.post(
    "/batch",
    authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.FARMER]),
    upload.any(),
    (req, res) => controller.uploadDocumentsBatch(req, res)
);

router.get(
    "/:farmId",
    authMiddleware([
        UserRole.ADMIN,
        UserRole.INSPECTOR,
        UserRole.BUYER,
        UserRole.EXPORTER,
        UserRole.FARMER,
    ]),
    (req, res) => controller.getDocuments(req, res)
);

router.patch(
    "/:id/status",
    authMiddleware([UserRole.ADMIN]),
    (req, res) => controller.updateStatus(req, res)
);

export default router;
