import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { FarmDocument, DocumentStatus, DocumentType } from "../entities/FarmDocument";
import { Farm } from "../entities/Farm";
import { successResponse, errorResponse } from "../utils/response";

export class FarmDocumentController {
    private docRepo = AppDataSource.getRepository(FarmDocument);
    private farmRepo = AppDataSource.getRepository(Farm);

    async uploadDocument(req: Request, res: Response) {
        try {
            const { farmId, type, documentUrl } = req.body;

            const farm = await this.farmRepo.findOne({ where: { id: farmId } });
            if (!farm) return errorResponse(res, "Farm not found", [], 404);

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
