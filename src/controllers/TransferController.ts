import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Transfer, TransferType } from "../entities/Transfer";
import { Batch } from "../entities/Batch";
import { Business } from "../entities/Business";
import { Farmer } from "../entities/Farmer";
import { successResponse, errorResponse } from "../utils/response";

export class TransferController {
    private transferRepository = AppDataSource.getRepository(Transfer);
    private batchRepository = AppDataSource.getRepository(Batch);
    private businessRepository = AppDataSource.getRepository(Business);
    private farmerRepository = AppDataSource.getRepository(Farmer);

    async create(req: Request, res: Response) {
        try {
            const { batchId, fromBusinessId, fromFarmerId, toBusinessId, quantityKg, transferDate, type, notes } = req.body;

            const batch = await this.batchRepository.findOneBy({ id: batchId });
            if (!batch) return errorResponse(res, "Batch not found", [], 404);

            if (quantityKg <= 0) return errorResponse(res, "Quantity must be positive", [], 400);
            if (quantityKg > batch.weightKg) return errorResponse(res, "Quantity exceeds batch weight", [], 400);

            let fromBusiness: Business | undefined;
            let fromFarmer: Farmer | undefined;
            let toBusiness: Business | undefined;

            if (fromBusinessId) {
                const fb = await this.businessRepository.findOneBy({ id: fromBusinessId });
                if (!fb) return errorResponse(res, "From business not found", [], 404);
                fromBusiness = fb;
            }
            if (fromFarmerId) {
                const ff = await this.farmerRepository.findOneBy({ id: fromFarmerId });
                if (!ff) return errorResponse(res, "From farmer not found", [], 404);
                fromFarmer = ff;
            }
            if (toBusinessId) {
                const tb = await this.businessRepository.findOneBy({ id: toBusinessId });
                if (!tb) return errorResponse(res, "To business not found", [], 404);
                toBusiness = tb;
            }

            if (type === TransferType.PURCHASE && !toBusiness) {
                return errorResponse(res, "Purchase requires a buyer (toBusinessId)", [], 400);
            }
            if ((type === TransferType.HANDOVER || type === TransferType.RECEIVE) && (!fromBusiness || !toBusiness)) {
                return errorResponse(res, "Handover/Receive requires both from and to business", [], 400);
            }

            const transfer = this.transferRepository.create({
                batch,
                batchId: batch.id,
                fromBusiness,
                fromBusinessId: fromBusiness?.id,
                fromFarmer,
                fromFarmerId: fromFarmer?.id,
                toBusiness,
                toBusinessId: toBusiness?.id,
                quantityKg,
                transferDate: new Date(transferDate),
                type,
                notes
            });

            await this.transferRepository.save(transfer);
            const saved = await this.transferRepository.findOne({
                where: { id: transfer.id },
                relations: ["batch", "fromBusiness", "toBusiness", "fromFarmer"]
            });
            return successResponse(res, saved, "Transfer recorded successfully", 201);
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error recording transfer", [error.message], 500);
        }
    }

    async getByBatch(req: Request, res: Response) {
        try {
            const { batchId } = req.query;
            if (!batchId || typeof batchId !== "string") {
                return errorResponse(res, "batchId query required", [], 400);
            }
            const transfers = await this.transferRepository.find({
                where: { batchId },
                relations: ["batch", "fromBusiness", "toBusiness", "fromFarmer"],
                order: { transferDate: "ASC", createdAt: "ASC" }
            });
            return successResponse(res, transfers);
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error fetching transfers", [error.message], 500);
        }
    }

    async getCustodyHistory(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const batch = await this.batchRepository.findOne({
                where: [{ id }, { batchId: id }],
                relations: ["farmers"]
            });
            if (!batch) return errorResponse(res, "Batch not found", [], 404);

            const transfers = await this.transferRepository.find({
                where: { batchId: batch.id },
                relations: ["fromBusiness", "toBusiness", "fromFarmer"],
                order: { transferDate: "ASC", createdAt: "ASC" }
            });

            const custodyChain = transfers.map(t => ({
                id: t.id,
                type: t.type,
                date: t.transferDate,
                from: t.fromFarmer
                    ? `Farmer: ${t.fromFarmer.firstName} ${t.fromFarmer.lastName}`
                    : t.fromBusiness
                    ? t.fromBusiness.name
                    : "Origin",
                to: t.toBusiness ? t.toBusiness.name : "N/A",
                quantityKg: t.quantityKg,
                notes: t.notes
            }));

            const currentHolder =
                transfers.length > 0 && transfers[transfers.length - 1].toBusiness
                    ? transfers[transfers.length - 1].toBusiness!.name
                    : "Farmers (Origin)";

            return successResponse(res, {
                batch: { id: batch.id, batchId: batch.batchId, weightKg: batch.weightKg, cropType: batch.cropType },
                custodyChain,
                currentHolder
            });
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error fetching custody history", [error.message], 500);
        }
    }

    async getAuditDashboard(req: Request, res: Response) {
        try {
            const { batchId, fromBusinessId, toBusinessId, startDate, endDate } = req.query;

            let qb = this.transferRepository
                .createQueryBuilder("t")
                .leftJoinAndSelect("t.batch", "batch")
                .leftJoinAndSelect("t.fromBusiness", "fromBusiness")
                .leftJoinAndSelect("t.toBusiness", "toBusiness")
                .leftJoinAndSelect("t.fromFarmer", "fromFarmer")
                .orderBy("t.transferDate", "DESC");

            if (batchId && typeof batchId === "string") qb = qb.andWhere("t.batchId = :batchId", { batchId });
            if (fromBusinessId && typeof fromBusinessId === "string")
                qb = qb.andWhere("t.fromBusinessId = :fromBusinessId", { fromBusinessId });
            if (toBusinessId && typeof toBusinessId === "string")
                qb = qb.andWhere("t.toBusinessId = :toBusinessId", { toBusinessId });
            if (startDate && typeof startDate === "string")
                qb = qb.andWhere("t.transferDate >= :startDate", { startDate });
            if (endDate && typeof endDate === "string")
                qb = qb.andWhere("t.transferDate <= :endDate", { endDate });

            const transfers = await qb.getMany();

            const totalTransferred = transfers.reduce((sum, t) => sum + t.quantityKg, 0);

            return successResponse(res, {
                transfers,
                summary: { totalTransfers: transfers.length, totalQuantityKg: totalTransferred }
            });
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error fetching audit dashboard", [error.message], 500);
        }
    }

    async getReconciliation(req: Request, res: Response) {
        try {
            const { batchId } = req.query;
            if (!batchId || typeof batchId !== "string") {
                return errorResponse(res, "batchId query required", [], 400);
            }

            const batch = await this.batchRepository.findOneBy({ id: batchId });
            if (!batch) return errorResponse(res, "Batch not found", [], 404);

            const transfers = await this.transferRepository.find({
                where: { batchId },
                relations: ["fromBusiness", "toBusiness"]
            });

            const sumReceived = transfers
                .filter(t => t.type === TransferType.RECEIVE || t.type === TransferType.PURCHASE)
                .reduce((sum, t) => sum + t.quantityKg, 0);
            const sumTransferred = transfers
                .filter(t => t.type === TransferType.HANDOVER)
                .reduce((sum, t) => sum + t.quantityKg, 0);

            const reconciled = Math.abs(batch.weightKg - sumReceived) < 0.01 && sumTransferred <= sumReceived + 0.01;

            return successResponse(res, {
                batchId: batch.batchId,
                batchWeightKg: batch.weightKg,
                sumReceivedKg: sumReceived,
                sumTransferredKg: sumTransferred,
                varianceKg: batch.weightKg - sumReceived,
                reconciled
            });
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error fetching reconciliation", [error.message], 500);
        }
    }
}
