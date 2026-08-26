import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { FarmDocument, DocumentStatus, DocumentType } from "../entities/FarmDocument";
import { Farm } from "../entities/Farm";
import { successResponse, errorResponse } from "../utils/response";
import { uploadFileToCloudinary } from "../utils/cloudUpload";

export class FarmDocumentController {
    private docRepo = AppDataSource.getRepository(FarmDocument);
    private farmRepo = AppDataSource.getRepository(Farm);

    /// Accepts EITHER:
    /// 1) A pre-uploaded URL in the JSON body: { farmId, type, documentUrl }
    ///    (kept for backward compatibility with the admin panel's existing
    ///    upload-elsewhere-then-register flow).
    /// 2) A direct multipart file upload: { farmId, type } + a file field
    ///    named "document" (used by the mobile app's Compliance Documents
    ///    upload step) - uploaded straight to Cloudinary here, same as
    ///    AuthController.registerFarmer does for photos/signature.
    async uploadDocument(req: Request, res: Response) {
        try {
            const { farmId, type } = req.body;
            let { documentUrl } = req.body;

            const farm = await this.farmRepo.findOne({ where: { id: farmId } });
            if (!farm) return errorResponse(res, "Farm not found", [], 404);

            const files = (req as any).files as Express.Multer.File[] | undefined;
            const file = files?.find((f) => f.fieldname === "document");
            if (file) {
                documentUrl = await uploadFileToCloudinary(file);
            }

            if (!documentUrl) {
                return errorResponse(res, "documentUrl or a 'document' file is required", [], 400);
            }

            const doc = this.docRepo.create({
                farm,
                farmId: farm.id,
                type: type as DocumentType,
                documentUrl,
                status: DocumentStatus.PENDING // Default to pending verification
            });

            await this.docRepo.save(doc);
            return successResponse(res, doc, "Document uploaded successfully", 201);
        } catch (error: any) {
            return errorResponse(res, error.message, [error.message], 500);
        }
    }

    /// Accepts multiple files in one request: { farmId } + file fields, each
    /// named "document_<DocumentType enum value, url-safe>" is impractical
    /// since types contain slashes/spaces, so instead the mobile app sends a
    /// parallel `types` JSON array (same order as the `documents` files) -
    /// see document.routes.ts multipart field name "documents".
    async uploadDocumentsBatch(req: Request, res: Response) {
        try {
            const { farmId } = req.body;
            let types: string[] = [];
            try {
                types = req.body.types ? JSON.parse(req.body.types) : [];
            } catch {
                types = [];
            }

            const farm = await this.farmRepo.findOne({ where: { id: farmId } });
            if (!farm) return errorResponse(res, "Farm not found", [], 404);

            const files = (req as any).files as Express.Multer.File[] | undefined;
            const documentFiles = files?.filter((f) => f.fieldname === "documents") || [];

            if (documentFiles.length === 0) {
                return errorResponse(res, "No document files provided", [], 400);
            }

            const savedDocs: FarmDocument[] = [];
            for (let i = 0; i < documentFiles.length; i++) {
                const documentUrl = await uploadFileToCloudinary(documentFiles[i]);
                const type = (types[i] as DocumentType) || DocumentType.OTHER;
                const doc = this.docRepo.create({
                    farm,
                    farmId: farm.id,
                    type,
                    documentUrl,
                    status: DocumentStatus.PENDING
                });
                savedDocs.push(await this.docRepo.save(doc));
            }

            return successResponse(res, savedDocs, "Documents uploaded successfully", 201);
        } catch (error: any) {
            return errorResponse(res, error.message, [error.message], 500);
        }
    }

    async getDocuments(req: Request, res: Response) {
        try {
            const { farmId } = req.params;
            const docs = await this.docRepo.find({ where: { farmId } });
            return successResponse(res, docs);
        } catch (error: any) {
            return errorResponse(res, error.message, [error.message], 500);
        }
    }

    async updateStatus(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const { status } = req.body;

            const doc = await this.docRepo.findOne({ where: { id } });
            if (!doc) return errorResponse(res, "Document not found", [], 404);

            doc.status = status;
            await this.docRepo.save(doc);

            return successResponse(res, doc);
        } catch (error: any) {
            return errorResponse(res, error.message, [error.message], 500);
        }
    }
}
