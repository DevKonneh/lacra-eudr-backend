import { In } from "typeorm";
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

    /**
     * Broadcasts a notification to every user holding any of the given
     * roles — used by the Application workflow so a department's staff
     * (Commercial, DG, Technical, Finance, IT) learn an item has landed in
     * their queue instead of having to keep polling the queue page. ADMIN
     * is always included alongside whatever roles are passed, mirroring
     * the admin-panel's own role-gated navigation pattern (every workflow
     * queue link is `roles: [<department>, ADMIN]`), so admins stay able
     * to see everything without a separate notification path.
     */
    static async createForRoles(roles: UserRole[], type: string, title: string, body: string) {
        const targetRoles = Array.from(new Set([...roles, UserRole.ADMIN]));
        const userRepo = AppDataSource.getRepository(User);
        const users = await userRepo.find({ where: { role: In(targetRoles) } });
        const notificationRepo = AppDataSource.getRepository(Notification);
        for (const user of users) {
            const n = notificationRepo.create({
                user: user as any,
                userId: user.id,
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
