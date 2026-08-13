import { AppDataSource } from "../data-source";
import { Notification } from "../entities/Notification";
import { User, UserRole } from "../entities/User";

export class NotificationService {
    static async createForAdmins(type: string, title: string, body: string) {
        const userRepo = AppDataSource.getRepository(User);
        const admins = await userRepo.find({
            where: [{ role: UserRole.ADMIN }]
        });
        const notificationRepo = AppDataSource.getRepository(Notification);
        for (const admin of admins) {
            const n = notificationRepo.create({
                user: admin as any,
                userId: admin.id,
                type,
                title,
                body
            });
            await notificationRepo.save(n);
        }
    }

    static async createForUser(userId: string, type: string, title: string, body: string) {
        const userRepo = AppDataSource.getRepository(User);
        const user = await userRepo.findOneBy({ id: userId });
        if (!user) return;
        const notificationRepo = AppDataSource.getRepository(Notification);
        const n = notificationRepo.create({
            user,
            userId,
            type,
            title,
            body
        });
        await notificationRepo.save(n);
    }
}
