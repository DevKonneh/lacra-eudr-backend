import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Notification } from "../entities/Notification";
import { successResponse, errorResponse } from "../utils/response";

export class NotificationController {
    private notificationRepository = AppDataSource.getRepository(Notification);

    async getMine(req: Request, res: Response) {
        try {
            const userId = (req as any).user?.id;
            if (!userId) return errorResponse(res, "Unauthorized", [], 401);

            const notifications = await this.notificationRepository.find({
                where: { userId },
                order: { createdAt: "DESC" },
                take: 50
            });
            return successResponse(res, notifications);
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error fetching notifications", [error.message], 500);
        }
    }

    async markRead(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const userId = (req as any).user?.id;
            if (!userId) return errorResponse(res, "Unauthorized", [], 401);

            const notification = await this.notificationRepository.findOne({
                where: { id, userId }
            });
            if (!notification) return errorResponse(res, "Notification not found", [], 404);

            notification.readAt = new Date();
            await this.notificationRepository.save(notification);
            return successResponse(res, notification);
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error updating notification", [error.message], 500);
        }
    }

    async markAllRead(req: Request, res: Response) {
        try {
            const userId = (req as any).user?.id;
            if (!userId) return errorResponse(res, "Unauthorized", [], 401);

            await this.notificationRepository
                .createQueryBuilder()
                .update(Notification)
                .set({ readAt: new Date() })
                .where("userId = :userId", { userId })
                .andWhere("readAt IS NULL")
                .execute();

            return successResponse(res, { message: "All notifications marked as read" });
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error updating notifications", [error.message], 500);
        }
    }
}
