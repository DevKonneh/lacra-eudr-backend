import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { User, UserRole, UserStatus } from "../entities/User";
import { Role } from "../entities/Role";
import { UserAuditLog, UserAuditAction } from "../entities/UserAuditLog";
import bcrypt from "bcryptjs";
import { successResponse, errorResponse } from "../utils/response";

export class UserController {
    private userRepository = AppDataSource.getRepository(User);
    private roleRepository = AppDataSource.getRepository(Role);
    private auditLogRepository = AppDataSource.getRepository(UserAuditLog);

    async create(req: Request, res: Response) {
        try {
            const { email, password, name, phone, roleId, status, roleType } = req.body;

            const existingUser = await this.userRepository.findOneBy({ email });
            if (existingUser) {
                return errorResponse(res, "User with this email already exists", [], 400);
            }

            const hashedPassword = await bcrypt.hash(password, 10);

            const user = new User();
            user.email = email;
            user.password = hashedPassword;
            user.name = name;
            user.phone = phone;
            user.status = status || UserStatus.ACTIVE;
            // Fallback to inspector if roleType not provided. 
            // NOTE: In a real "User Management" system, we might want to strictly enforce roles.
            user.role = roleType || UserRole.INSPECTOR;

            if (roleId) {
                const assignedRole = await this.roleRepository.findOneBy({ id: roleId });
                if (assignedRole) {
                    user.assignedRole = assignedRole;
                }
            }

            await this.userRepository.save(user);

            const requester = (req as any).user;
            await this.auditLogRepository.save(
                this.auditLogRepository.create({
                    userId: user.id,
                    action: UserAuditAction.CREATED,
                    previousValue: null,
                    newValue: user.role,
                    performedByUserId: requester?.id || null,
                    performedByName: requester?.name || null,
                    notes: `Account created with role "${user.role}" and status "${user.status}".`,
                })
            );

            // Return user without password
            const { password: _, ...userWithoutPassword } = user;
            return successResponse(res, userWithoutPassword, "User created successfully", 201);
        } catch (error: any) {
            console.error("Create User Error", error);
            return errorResponse(res, "Error creating user", [error.message], 500);
        }
    }

    async getAll(req: Request, res: Response) {
        try {
            const users = await this.userRepository.find({
                relations: ["assignedRole"],
                order: { createdAt: "DESC" }
            });
            // Filter out passwords
            const safeUsers = users.map(u => {
                const { password, ...rest } = u;
                return rest;
            });
            return successResponse(res, safeUsers);
        } catch (error: any) {
            console.error("Get Users Error", error);
            return errorResponse(res, "Error fetching users", [error.message], 500);
        }
    }

    async getOne(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const user = await this.userRepository.findOne({
                where: { id },
                relations: ["assignedRole"]
            });
            if (!user) {
                return errorResponse(res, "User not found", [], 404);
            }
            const { password, ...rest } = user;
            return successResponse(res, rest);
        } catch (error: any) {
            return errorResponse(res, "Error fetching user", [error.message], 500);
        }
    }

    async update(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const { email, name, phone, roleId, status, roleType, password } = req.body;

            const user = await this.userRepository.findOneBy({ id });
            if (!user) {
                return errorResponse(res, "User not found", [], 404);
            }

            const requester = (req as any).user;
            const auditRows: UserAuditLog[] = [];

            if (email && email !== user.email) {
                const existingUser = await this.userRepository.findOneBy({ email });
                if (existingUser) {
                    return errorResponse(res, "User with this email already exists", [], 400);
                }
                user.email = email;
            }

            if (password) {
                user.password = await bcrypt.hash(password, 10);
                auditRows.push(
                    this.auditLogRepository.create({
                        userId: user.id,
                        action: UserAuditAction.PASSWORD_RESET,
                        previousValue: null,
                        newValue: null,
                        performedByUserId: requester?.id || null,
                        performedByName: requester?.name || null,
                        notes: "Password reset by an administrator.",
                    })
                );
            }

            // Capture before/after for the fields that get their own
            // dedicated audit action (role, status) so the trail reads
            // "INSPECTOR -> TECHNICAL" rather than just "something changed".
            const previousRole = user.role;
            const previousStatus = user.status;

            user.name = name ?? user.name;
            user.phone = phone ?? user.phone;
            user.status = status ?? user.status;
            user.role = roleType ?? user.role;

            if (roleId) {
                const assignedRole = await this.roleRepository.findOneBy({ id: roleId });
                if (assignedRole) {
                    user.assignedRole = assignedRole;
                }
            } else if (roleId === null) {
                // If explicitly set to null, remove the role
                // TypeORM might need different handling for nulling relation
                // @ts-ignore
                user.assignedRole = null;
            }

            await this.userRepository.save(user);

            if (roleType && roleType !== previousRole) {
                auditRows.push(
                    this.auditLogRepository.create({
                        userId: user.id,
                        action: UserAuditAction.ROLE_CHANGED,
                        previousValue: previousRole,
                        newValue: roleType,
                        performedByUserId: requester?.id || null,
                        performedByName: requester?.name || null,
                        notes: null,
                    })
                );
            }
            if (status && status !== previousStatus) {
                auditRows.push(
                    this.auditLogRepository.create({
                        userId: user.id,
                        action: UserAuditAction.STATUS_CHANGED,
                        previousValue: previousStatus,
                        newValue: status,
                        performedByUserId: requester?.id || null,
                        performedByName: requester?.name || null,
                        notes: null,
                    })
                );
            }
            if (name !== undefined || phone !== undefined) {
                auditRows.push(
                    this.auditLogRepository.create({
                        userId: user.id,
                        action: UserAuditAction.PROFILE_UPDATED,
                        previousValue: null,
                        newValue: null,
                        performedByUserId: requester?.id || null,
                        performedByName: requester?.name || null,
                        notes: "Profile details (name/phone/email) updated.",
                    })
                );
            }
            if (auditRows.length > 0) {
                await this.auditLogRepository.save(auditRows);
            }

            const { password: _, ...rest } = user;
            return successResponse(res, rest);
        } catch (error: any) {
            return errorResponse(res, "Error updating user", [error.message], 500);
        }
    }

    /**
     * Dedicated status-only endpoint for the User Management "Deactivate" /
     * "Reactivate" row action — a safer, auditable alternative to the
     * destructive hard DELETE for the common case of an account that
     * should stop being able to log in without losing its history or the
     * records (farmers registered, applications reviewed, etc.) it is
     * still referenced by.
     */
    async setStatus(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const { status } = req.body;

            if (!Object.values(UserStatus).includes(status)) {
                return errorResponse(res, "Invalid status value", [], 400);
            }

            const user = await this.userRepository.findOneBy({ id });
            if (!user) {
                return errorResponse(res, "User not found", [], 404);
            }

            const previousStatus = user.status;
            user.status = status;
            await this.userRepository.save(user);

            const requester = (req as any).user;
            await this.auditLogRepository.save(
                this.auditLogRepository.create({
                    userId: user.id,
                    action: UserAuditAction.STATUS_CHANGED,
                    previousValue: previousStatus,
                    newValue: status,
                    performedByUserId: requester?.id || null,
                    performedByName: requester?.name || null,
                    notes: null,
                })
            );

            const { password, ...rest } = user;
            return successResponse(res, rest, "User status updated successfully");
        } catch (error: any) {
            console.error("Set User Status Error", error);
            return errorResponse(res, "Error updating user status", [error.message], 500);
        }
    }

    /**
     * Returns the audit trail (role/status changes, password resets,
     * profile updates, approvals) for a user account, most-recent first —
     * the User Management equivalent of the Farmer Profile audit log.
     */
    async getAuditLog(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const logs = await this.auditLogRepository.find({
                where: { userId: id },
                order: { createdAt: "DESC" },
            });
            return successResponse(res, logs);
        } catch (error: any) {
            console.error("Error fetching user audit log:", error);
            return errorResponse(res, "Error fetching audit log", [error.message], 500);
        }
    }

    async delete(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const result = await this.userRepository.delete(id);
            if (result.affected === 0) {
                return errorResponse(res, "User not found", [], 404);
            }
            return successResponse(res, { deleted: true }, "User deleted successfully");
        } catch (error: any) {
            return errorResponse(res, "Error deleting user", [error.message], 500);
        }
    }
}
