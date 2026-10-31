import { Router } from "express";
import { ApplicationController } from "../controllers/ApplicationController";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth.middleware";
import { upload } from "../middleware/upload.middleware";

const router = Router();
const controller = new ApplicationController();

// POST /api/applications/upload — used by the /apply wizard's
// DocumentUpload component to persist a file to Cloudinary as soon as the
// applicant selects it. optionalAuthMiddleware() so this stays reachable
// by fully anonymous online applicants (the normal case), while still
// attributing the upload to a logged-in user when it's an office-assisted
// submission by Commercial/Marketing staff.
router.post(
    "/upload",
    optionalAuthMiddleware(),
    upload.single("file"),
    (req, res) => controller.uploadDocument(req, res)
);

// POST /api/applications — final submission of the /apply wizard (online
// self-service, anonymous) or the office-assisted equivalent (Commercial/
// Marketing staff, authenticated). Both channels share this one endpoint.
router.post("/", optionalAuthMiddleware(), (req, res) => controller.create(req, res));

// Internal-facing read endpoints — require authentication since only
// LACRA staff (not applicants) browse the application list/detail views.
// Role-specific restrictions (Commercial-only, DG-only, etc.) are layered
// on in later phases once the review/approval endpoints exist; for now any
// authenticated staff account can view, matching the existing Permit/
// License routes' current (not-yet-role-restricted) behavior.
router.get("/", authMiddleware(), (req, res) => controller.getAll(req, res));
router.get("/:id", authMiddleware(), (req, res) => controller.getOne(req, res));

// -----------------------------------------------------------------
// Stage 2: Commercial and Marketing verification + First DG Approval.
// Role-gated: only Commercial/DG staff (or Admin, for support/testing)
// can act on these transitions.
// -----------------------------------------------------------------
router.post(
    "/:id/commercial/start-review",
    authMiddleware(["COMMERCIAL", "ADMIN"]),
    (req, res) => controller.startCommercialReview(req, res)
);
router.post(
    "/:id/commercial/request-correction",
    authMiddleware(["COMMERCIAL", "ADMIN"]),
    (req, res) => controller.requestCorrection(req, res)
);
router.post(
    "/:id/commercial/verify",
    authMiddleware(["COMMERCIAL", "ADMIN"]),
    (req, res) => controller.verifyCommercial(req, res)
);
router.post(
    "/:id/dg/approve",
    authMiddleware(["DG", "ADMIN"]),
    (req, res) => controller.dgApprove(req, res)
);
router.post(
    "/:id/dg/return",
    authMiddleware(["DG", "ADMIN"]),
    (req, res) => controller.dgReturn(req, res)
);
// Additive: lets a Commercial officer resolve APPLICANT_CORRECTION_REQUIRED
// (previously a dead end — no endpoint existed to move out of it) and save
// in-progress review notes/checklist without changing status. Does not add
// a new approval stage; resubmission re-enters the exact same Commercial
// queue the application started in.
router.post(
    "/:id/commercial/resubmit",
    authMiddleware(["COMMERCIAL", "ADMIN"]),
    (req, res) => controller.resubmitAfterCorrection(req, res)
);
router.post(
    "/:id/commercial/save-review-progress",
    authMiddleware(["COMMERCIAL", "ADMIN"]),
    (req, res) => controller.saveCommercialReviewProgress(req, res)
);
router.post(
    "/:id/commercial/replace-document",
    authMiddleware(["COMMERCIAL", "ADMIN"]),
    (req, res) => controller.replaceDocument(req, res)
);

// -----------------------------------------------------------------
// Stage 3: Technical Review + Inspector Assignment + Warehouse
// Assessment + Second DG Approval.
// -----------------------------------------------------------------
router.get(
    "/meta/inspectors",
    authMiddleware(["TECHNICAL", "ADMIN"]),
    (req, res) => controller.listInspectors(req, res)
);
router.post(
    "/:id/technical/start-assignment",
    authMiddleware(["TECHNICAL", "ADMIN"]),
    (req, res) => controller.startTechnicalAssignment(req, res)
);
router.post(
    "/:id/technical/assign-inspector",
    authMiddleware(["TECHNICAL", "ADMIN"]),
    (req, res) => controller.assignInspector(req, res)
);
router.post(
    "/:id/inspector/schedule",
    authMiddleware(["INSPECTOR", "ADMIN"]),
    (req, res) => controller.scheduleInspection(req, res)
);
router.post(
    "/:id/inspector/start-assessment",
    authMiddleware(["INSPECTOR", "ADMIN"]),
    (req, res) => controller.startAssessment(req, res)
);
router.post(
    "/:id/inspector/submit-assessment",
    authMiddleware(["INSPECTOR", "ADMIN"]),
    (req, res) => controller.submitAssessment(req, res)
);
router.post(
    "/:id/technical/verify",
    authMiddleware(["TECHNICAL", "ADMIN"]),
    (req, res) => controller.verifyTechnical(req, res)
);
router.post(
    "/:id/technical/require-reinspection",
    authMiddleware(["TECHNICAL", "ADMIN"]),
    (req, res) => controller.requireReinspection(req, res)
);
router.post(
    "/:id/dg/approve-second",
    authMiddleware(["DG", "ADMIN"]),
    (req, res) => controller.dgApproveSecond(req, res)
);
router.post(
    "/:id/dg/return-to-technical",
    authMiddleware(["DG", "ADMIN"]),
    (req, res) => controller.dgReturnToTechnical(req, res)
);

// -----------------------------------------------------------------
// Stage 4: Billing Review + Payment Verification + Final DG Approval +
// IT Certificate Printing/Issuance.
// -----------------------------------------------------------------
router.post(
    "/:id/billing/start-review",
    authMiddleware(["FINANCE", "ADMIN"]),
    (req, res) => controller.startBillingReview(req, res)
);
router.post(
    "/:id/billing/create-invoice",
    authMiddleware(["FINANCE", "ADMIN"]),
    (req, res) => controller.createInvoice(req, res)
);
router.post(
    "/:id/payment/submit",
    authMiddleware(["FINANCE", "ADMIN"]),
    (req, res) => controller.submitPayment(req, res)
);
router.post(
    "/:id/payment/verify",
    authMiddleware(["FINANCE", "ADMIN"]),
    (req, res) => controller.verifyPayment(req, res)
);
router.post(
    "/:id/payment/clear-cheque",
    authMiddleware(["FINANCE", "ADMIN"]),
    (req, res) => controller.clearCheque(req, res)
);
router.post(
    "/:id/payment/require-correction",
    authMiddleware(["FINANCE", "ADMIN"]),
    (req, res) => controller.requirePaymentCorrection(req, res)
);
router.post(
    "/:id/dg/approve-final",
    authMiddleware(["DG", "ADMIN"]),
    (req, res) => controller.dgApproveFinal(req, res)
);
router.post(
    "/:id/dg/return-to-finance",
    authMiddleware(["DG", "ADMIN"]),
    (req, res) => controller.dgReturnToFinance(req, res)
);
router.post(
    "/:id/it/print-certificate",
    authMiddleware(["IT", "ADMIN"]),
    (req, res) => controller.printCertificate(req, res)
);
router.post(
    "/:id/it/issue-certificate",
    authMiddleware(["IT", "ADMIN"]),
    (req, res) => controller.issueCertificate(req, res)
);

// Public QR-verification lookup — no auth required.
router.get(
    "/verify/:certificateNumber",
    (req, res) => controller.verifyCertificate(req, res)
);

export default router;
