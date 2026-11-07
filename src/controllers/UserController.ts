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

    /**
     * Validates a proposed `supervisorId` for the Monitoring feature's
     * supervisor assignment: the id must refer to a real, existing
     * account whose access-control role is FIELD_SUPERVISOR (per the
     * explicit instruction: "Validate that the selected supervisor has
     * the correct role"). Returns the supervisor User row on success, or
     * an error string on failure — never throws, so callers can decide
     * how to respond.
     */
    private async validateSupervisor(supervisorId: string): Promise<{ supervisor?: User; error?: string }> {
        const supervisor = await this.userRepository.findOneBy({ id: supervisorId });
        if (!supervisor) {
            return { error: "Selected supervisor account was not found." };
        }
        if (supervisor.role !== UserRole.FIELD_SUPERVISOR) {
            return { error: "Selected supervisor must have the Field Supervisor role." };
        }
        return { supervisor };
    }

    async create(req: Request, res: Response) {
        try {
            const {
                email, password, name, phone, roleId, status, roleType,
                supervisorId, assignedCounty, assignedDistrict,
            } = req.body;

            const existingUser = await this.userRepository.findOneBy({ email });
            if (existingUser) {
                return errorResponse(res, "User with this email already exists", [], 400);
            }

            if (supervisorId) {
                const { error } = await this.validateSupervisor(supervisorId);
                if (error) return errorResponse(res, error, [], 400);
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
            user.supervisorId = supervisorId || null;
            user.assignedCounty = assignedCounty || null;
            user.assignedDistrict = assignedDistrict || null;

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

    /**
     * Attaches a lightweight `supervisorName` (and the raw `supervisorId`
     * already on each row) to a list of users, for display on the User
     * Management / User Form screens without the caller needing a second
     * round trip. supervisorId is a plain uuid column (not a TypeORM
     * relation — see User.ts's comment on why), so this is a small extra
     * in-memory join rather than something `relations: [...]` can fetch.
     */
    private async attachSupervisorNames<T extends { supervisorId: string | null }>(users: T[]): Promise<(T & { supervisorName: string | null })[]> {
        const supervisorIds = Array.from(new Set(users.map(u => u.supervisorId).filter((id): id is string => !!id)));
        if (supervisorIds.length === 0) {
            return users.map(u => ({ ...u, supervisorName: null }));
        }
        const supervisors = await this.userRepository.findByIds(supervisorIds);
        const nameById = new Map(supervisors.map(s => [s.id, s.name || s.email]));
        return users.map(u => ({ ...u, supervisorName: u.supervisorId ? (nameById.get(u.supervisorId) || null) : null }));
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
            const withSupervisorNames = await this.attachSupervisorNames(safeUsers);
            return successResponse(res, withSupervisorNames);
        } catch (error: any) {
            console.error("Get Users Error", error);
            return errorResponse(res, "Error fetching users", [error.message], 500);
        }
    }

    /**
     * All accounts eligible to be selected as a supervisor (role ===
     * FIELD_SUPERVISOR) — powers the "Supervisor" dropdown on the admin
     * User Form, so it only ever offers accounts the backend will
     * actually accept (see validateSupervisor above).
     */
    async getSupervisorOptions(req: Request, res: Response) {
        try {
            const supervisors = await this.userRepository.find({
                where: { role: UserRole.FIELD_SUPERVISOR, status: UserStatus.ACTIVE },
                order: { name: "ASC" },
            });
            const safe = supervisors.map(({ password, ...rest }) => rest);
            return successResponse(res, safe);
        } catch (error: any) {
            console.error("Get Supervisor Options Error", error);
            return errorResponse(res, "Error fetching supervisor options", [error.message], 500);
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
            const [withSupervisorName] = await this.attachSupervisorNames([rest]);
            return successResponse(res, withSupervisorName);
        } catch (error: any) {
            return errorResponse(res, "Error fetching user", [error.message], 500);
        }
    }

    async update(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const {
                email, name, phone, roleId, status, roleType, password,
                supervisorId, assignedCounty, assignedDistrict,
            } = req.body;

            const user = await this.userRepository.findOneBy({ id });
            if (!user) {
                return errorResponse(res, "User not found", [], 404);
            }

            // A supervisor cannot supervise themselves - guards against an
            // obvious data-integrity mistake on the User Form.
            if (supervisorId && supervisorId === id) {
                return errorResponse(res, "An account cannot be its own supervisor.", [], 400);
            }

            // Validate BEFORE any field is mutated, so a bad supervisorId
            // rejects the whole request rather than partially applying
            // other changes.
            if (supervisorId !== undefined && supervisorId !== null && supervisorId !== "") {
                const { error } = await this.validateSupervisor(supervisorId);
                if (error) return errorResponse(res, error, [], 400);
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
            const previousSupervisorId = user.supervisorId;
            const previousAssignedCounty = user.assignedCounty;
            const previousAssignedDistrict = user.assignedDistrict;

            user.name = name ?? user.name;
            user.phone = phone ?? user.phone;
            user.status = status ?? user.status;
            user.role = roleType ?? user.role;
            if (assignedCounty !== undefined) user.assignedCounty = assignedCounty || null;
            if (assignedDistrict !== undefined) user.assignedDistrict = assignedDistrict || null;
            // Explicit null/"" clears the supervisor (reassignment away
            // from an existing one); undefined leaves it untouched. This
            // is the write that makes "the previous supervisor loses
            // access after reassignment" true - access everywhere is
            // computed live from this column, never cached, so the moment
            // this save() commits, the old supervisor's queries simply no
            // longer match this enumerator.
            if (supervisorId !== undefined) {
                user.supervisorId = supervisorId || null;
            }

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
            if (supervisorId !== undefined && user.supervisorId !== previousSupervisorId) {
                const [prevName, newName] = await Promise.all([
                    previousSupervisorId ? this.userRepository.findOneBy({ id: previousSupervisorId }) : null,
                    user.supervisorId ? this.userRepository.findOneBy({ id: user.supervisorId }) : null,
                ]);
                auditRows.push(
                    this.auditLogRepository.create({
                        userId: user.id,
                        action: UserAuditAction.SUPERVISOR_CHANGED,
                        previousValue: prevName ? (prevName.name || prevName.email) : null,
                        newValue: newName ? (newName.name || newName.email) : null,
                        performedByUserId: requester?.id || null,
                        performedByName: requester?.name || null,
                        notes: null,
                    })
                );
            }
            if (
                (assignedCounty !== undefined && user.assignedCounty !== previousAssignedCounty) ||
                (assignedDistrict !== undefined && user.assignedDistrict !== previousAssignedDistrict)
            ) {
                const fmt = (county: string | null, district: string | null) =>
                    (county || district) ? `${county || '—'} / ${district || '—'}` : null;
                auditRows.push(
                    this.auditLogRepository.create({
                        userId: user.id,
                        action: UserAuditAction.TERRITORY_CHANGED,
                        previousValue: fmt(previousAssignedCounty, previousAssignedDistrict),
                        newValue: fmt(user.assignedCounty, user.assignedDistrict),
                        performedByUserId: requester?.id || null,
                        performedByName: requester?.name || null,
                        notes: null,
                    })
                );
            }
            if (auditRows.length > 0) {
                await this.auditLogRepository.save(auditRows);
            }

            const { password: _, ...rest } = user;
            const [withSupervisorName] = await this.attachSupervisorNames([rest]);
            return successResponse(res, withSupervisorName);
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
