import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Batch, BatchStatus } from "../entities/Batch";
import { License, LicenseStatus } from "../entities/License";
import { Farmer } from "../entities/Farmer";
import QRCode from 'qrcode';
import { In } from "typeorm";
import { successResponse, errorResponse } from "../utils/response";

export class BatchController {
    private batchRepository = AppDataSource.getRepository(Batch);
    private licenseRepository = AppDataSource.getRepository(License);
    private farmerRepository = AppDataSource.getRepository(Farmer);

    async create(req: any, res: Response) {
        try {
            const { farmersIds, weightKg, cropType } = req.body;
            const userId = req.user.id;

            // 1. Verify User has a valid License
            const license = await this.licenseRepository.findOne({
                where: { user: { id: userId }, status: LicenseStatus.ACTIVE }
            });

            if (!license) {
                return errorResponse(res, "Active license required to create batches.", [], 403);
            }

            // 2. Fetch Farmers
            const farmers = await this.farmerRepository.findBy({
                id: In(farmersIds)
            });

            if (farmers.length !== farmersIds.length) {
                return errorResponse(res, "One or more farmers not found.", [], 400);
            }

            // 3. Generate Batch ID
            const count = await this.batchRepository.count();
            const batchId = `BATCH-${new Date().getFullYear()}-${(count + 1).toString().padStart(6, '0')}`;

            // 4. Generate QR
            const qrData = JSON.stringify({ batchId, cropType, weight: weightKg, origin: farmers.length + " farmers" });
            const qrCode = await QRCode.toDataURL(qrData);

            // 5. Create Batch
            const batch = this.batchRepository.create({
                batchId,
                weightKg,
                cropType,
                status: BatchStatus.COLLECTED,
                createdBy: license,
                farmers,
                qrCode
            });

            await this.batchRepository.save(batch);
            return successResponse(res, batch, "Batch created successfully", 201);

        } catch (error: any) {
            console.error("Create Batch Error", error);
            return errorResponse(res, "Error creating batch", [error.message], 500);
        }
    }

    async updateStatus(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const { status } = req.body;

            const batch = await this.batchRepository.findOneBy({ id });
            if (!batch) return errorResponse(res, "Batch not found", [], 404);

            batch.status = status;
            await this.batchRepository.save(batch);
            return successResponse(res, batch, "Batch status updated");
        } catch (error: any) {
            return errorResponse(res, "Error updating batch status", [error.message], 500);
        }
    }

    async getTrace(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const batch = await this.batchRepository.findOne({
                where: { id },
                relations: ["farmers", "createdBy", "createdBy.user"]
            });
            if (!batch) return errorResponse(res, "Batch not found", [], 404);
            return successResponse(res, batch);
        } catch (error: any) {
            return errorResponse(res, "Error tracing batch", [error.message], 500);
        }
    }

    async getAll(req: any, res: Response) {
        try {
            // For simplicity, just return all batches for now. 
            // Ideally we filter by the logged in user's license/business.
            const batches = await this.batchRepository.find({
                relations: ["farmers", "createdBy"],
                order: { createdAt: "DESC" }
            });
            return successResponse(res, batches);
        } catch (error: any) {
            return errorResponse(res, "Error fetching batches", [error.message], 500);
        }
    }

    async getPublicBatch(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const batch = await this.batchRepository.findOne({
                where: { id },
                relations: ["farmers"]
            });

            if (!batch) {
                // Try finding by batchId (the readable string ID) if UUID search fails
                const batchByStringId = await this.batchRepository.findOne({
                    where: { batchId: id },
                    relations: ["farmers"]
                });

                if (!batchByStringId) return errorResponse(res, "Batch not found", [], 404);

                // Use the found batch
                return successResponse(res, {
                    id: batchByStringId.id,
                    batchId: batchByStringId.batchId,
                    weightKg: batchByStringId.weightKg,
                    cropType: batchByStringId.cropType,
                    status: batchByStringId.status,
                    createdAt: batchByStringId.createdAt,
                    farmers: batchByStringId.farmers.map(f => ({
                        id: f.id,
                        firstName: f.firstName,
                        lastName: f.lastName,
                        community: f.community,
                        district: f.district,
                        region: f.region,
                        profilePhoto: f.profilePhoto
                    }))
                });
            }

            return successResponse(res, {
                id: batch.id,
                batchId: batch.batchId,
                weightKg: batch.weightKg,
                cropType: batch.cropType,
                status: batch.status,
                createdAt: batch.createdAt,
                farmers: batch.farmers.map(f => ({
                    id: f.id,
                    firstName: f.firstName,
                    lastName: f.lastName,
                    community: f.community,
                    district: f.district,
                    region: f.region,
                    profilePhoto: f.profilePhoto
                }))
            });
        } catch (error: any) {
            console.error("Error fetching public batch:", error);
            return errorResponse(res, "Error loading batch", [error.message], 500);
        }
    }
}
