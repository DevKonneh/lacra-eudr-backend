import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { User, UserRole, UserStatus } from "../entities/User";
import { Role } from "../entities/Role";
import { UserAuditLog, UserAuditAction } from "../entities/UserAuditLog";
import bcrypt from "bcryptjs";
import { successResponse, errorResponse } from "../utils/response";
import { validatePassword } from "../utils/passwordPolicy";
import { getEffectivePermissions, isSubsetOfActorPermissions } from "../config/permissions";

export class UserController {
    private userRepository = AppDataSource.getRepository(User);
    private roleRepository = AppDataSource.getRepository(Role);
    private auditLogRepository = AppDataSource.getRepository(UserAuditLog);

    /**
     * Privilege-escalation guard for any request that assigns/changes a
     * target account's `roleId` (Permission Group). Loads the requesting
     * actor's OWN effective permissions and confirms the candidate Role's
     * permissions are a subset of them (or the actor already holds the
     * 'all' wildcard, i.e. is ADMIN) — so nobody can grant another account
     * (or, via UserController.update(), even their own account if an
     * ADMIN's UI ever allowed self-edit) a wider permission set than they
     * themselves hold. Returns an error string on failure, undefined on
     * success.
     */
    private async checkRoleAssignmentEscalation(req: Request, roleId: string): Promise<string | undefined> {
        const requester = (req as any).user;
        if (!requester?.id) {
            // Should never happen on an authMiddleware-protected route, but
            // fail closed rather than open if it somehow does.
            return "Unable to verify requester identity for this operation.";
        }

        const candidateRole = await this.roleRepository.findOneBy({ id: roleId });
        if (!candidateRole) {
            return "Selected permission group was not found.";
        }

        // ADMIN requesters always pass (they hold the 'all' wildcard by
        // design — see config/permissions.ts), but we still resolve their
        // actual effective permissions here rather than special-casing
        // `requester.role === ADMIN` directly, so this stays correct if a
        // future non-ADMIN role is ever granted ROLE_EDIT/USER_EDIT.
        const actorUser = await this.userRepository.findOne({
            where: { id: requester.id },
            relations: ["assignedRole"],
        });
        if (!actorUser) {
            return "Requesting account could not be verified.";
        }
        const actorPermissions = getEffectivePermissions(actorUser);
        const candidatePermissions = candidateRole.permissions || [];

        if (!isSubsetOfActorPermissions(candidatePermissions, actorPermissions)) {
            return "You cannot assign a permission group that grants more access than your own account currently has.";
        }
        return undefined;
    }

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

            const passwordCheck = validatePassword(password);
            if (!passwordCheck.valid) {
                return errorResponse(res, "Password does not meet security requirements", passwordCheck.errors, 400);
            }

            if (supervisorId) {
                const { error } = await this.validateSupervisor(supervisorId);
                if (error) return errorResponse(res, error, [], 400);
            }

            // Privilege-escalation guard: an actor may only assign a
            // permission group whose permissions are a subset of their own.
            if (roleId) {
                const escalationError = await this.checkRoleAssignmentEscalation(req, roleId);
                if (escalationError) return errorResponse(res, escalationError, [], 403);
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
            const createAuditRows: UserAuditLog[] = [
                this.auditLogRepository.create({
                    userId: user.id,
                    action: UserAuditAction.CREATED,
                    previousValue: null,
                    newValue: user.role,
                    performedByUserId: requester?.id || null,
                    performedByName: requester?.name || null,
                    notes: `Account created with role "${user.role}" and status "${user.status}".`,
                }),
            ];
            if (user.assignedRole) {
                createAuditRows.push(
                    this.auditLogRepository.create({
                        userId: user.id,
                        action: UserAuditAction.PERMISSION_GROUP_CHANGED,
                        previousValue: null,
                        newValue: user.assignedRole.name,
                        performedByUserId: requester?.id || null,
                        performedByName: requester?.name || null,
                        notes: `Permission group "${user.assignedRole.name}" assigned at account creation.`,
                    })
                );
            }
            await this.auditLogRepository.save(createAuditRows);

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

            // Load with the assignedRole relation populated so the
            // "previous permission group" audit value below is accurate
            // (a plain findOneBy() would leave user.assignedRole
            // undefined, since it's a non-eager relation).
            const user = await this.userRepository.findOne({ where: { id }, relations: ["assignedRole"] });
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

            // Privilege-escalation guard, checked BEFORE any field is
            // mutated (same reasoning as the supervisor check above): an
            // actor may only assign a permission group whose permissions
            // are a subset of their own effective permissions.
            if (roleId) {
                const escalationError = await this.checkRoleAssignmentEscalation(req, roleId);
                if (escalationError) return errorResponse(res, escalationError, [], 403);
            }

            // Password policy, checked BEFORE mutation for the same reason.
            if (password) {
                const passwordCheck = validatePassword(password);
                if (!passwordCheck.valid) {
                    return errorResponse(res, "Password does not meet security requirements", passwordCheck.errors, 400);
                }
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
                // An admin-initiated password reset must invalidate the
                // account's existing sessions, same as a self-service
                // reset/change (task #5) — the account holder's old
                // password/token should not keep working after an admin
                // deliberately resets it (e.g. because it was compromised).
                user.tokenVersion = (user.tokenVersion ?? 0) + 1;
                auditRows.push(
                    this.auditLogRepository.create({
                        userId: user.id,
                        action: UserAuditAction.PASSWORD_RESET,
                        previousValue: null,
                        newValue: null,
                        performedByUserId: requester?.id || null,
                        performedByName: requester?.name || null,
                        notes: "Password reset by an administrator.",
                    }),
                    this.auditLogRepository.create({
                        userId: user.id,
                        action: UserAuditAction.SESSIONS_REVOKED,
                        previousValue: null,
                        newValue: null,
                        performedByUserId: requester?.id || null,
                        performedByName: requester?.name || null,
                        notes: "Sessions invalidated: password reset by an administrator.",
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
            // Captured BEFORE any reassignment below (the "assignedRole"
            // relation was loaded on the initial findOne() above), so the
            // audit row below can show a reliable "before" permission
            // group name.
            const previousAssignedRole = user.assignedRole ?? null;
            const previousAssignedRoleId: string | null = previousAssignedRole ? previousAssignedRole.id : null;

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

            let newAssignedRole: Role | null = null;
            let assignedRoleChanged = false;
            if (roleId) {
                const assignedRole = await this.roleRepository.findOneBy({ id: roleId });
                if (assignedRole) {
                    user.assignedRole = assignedRole;
                    newAssignedRole = assignedRole;
                    assignedRoleChanged = assignedRole.id !== previousAssignedRoleId;
                }
            } else if (roleId === null) {
                // If explicitly set to null, remove the role
                // TypeORM might need different handling for nulling relation
                // @ts-ignore
                user.assignedRole = null;
                assignedRoleChanged = previousAssignedRoleId !== null;
            }

            // Suspending/deactivating/rejecting an account (or any other
            // status transition) must invalidate its existing sessions
            // immediately — this is the core fix for task #1 ("suspension
            // enforcement"). Without this, authMiddleware's live status
            // check alone already blocks further requests once the DB row
            // is SUSPENDED (see auth.middleware.ts), but bumping
            // tokenVersion here too means that if the account is later
            // REACTIVATED, any token issued before the suspend/reactivate
            // cycle still cannot be replayed — only a fresh login works.
            const statusChanging = status && status !== previousStatus;
            if (statusChanging) {
                user.tokenVersion = (user.tokenVersion ?? 0) + 1;
            }

            await this.userRepository.save(user);

            if (statusChanging) {
                auditRows.push(
                    this.auditLogRepository.create({
                        userId: user.id,
                        action: UserAuditAction.SESSIONS_REVOKED,
                        previousValue: null,
                        newValue: null,
                        performedByUserId: requester?.id || null,
                        performedByName: requester?.name || null,
                        notes: `Sessions invalidated: account status changed from "${previousStatus}" to "${status}".`,
                    })
                );
            }

            if (assignedRoleChanged) {
                auditRows.push(
                    this.auditLogRepository.create({
                        userId: user.id,
                        action: UserAuditAction.PERMISSION_GROUP_CHANGED,
                        previousValue: previousAssignedRole?.name ?? null,
                        newValue: newAssignedRole?.name ?? null,
                        performedByUserId: requester?.id || null,
                        performedByName: requester?.name || null,
                        notes: null,
                    })
                );
            }

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
            const statusActuallyChanging = status !== previousStatus;
            user.status = status;
            if (statusActuallyChanging) {
                // Core fix for task #1 (suspension enforcement): bumping
                // tokenVersion here means every token issued for this
                // account BEFORE this moment is rejected by
                // authMiddleware's live tokenVersion check on its very
                // next request, regardless of the token's stated 24h
                // expiry. See User.tokenVersion's doc comment for the full
                // mechanism.
                user.tokenVersion = (user.tokenVersion ?? 0) + 1;
            }
            await this.userRepository.save(user);

            const requester = (req as any).user;
            const auditRows: UserAuditLog[] = [
                this.auditLogRepository.create({
                    userId: user.id,
                    action: UserAuditAction.STATUS_CHANGED,
                    previousValue: previousStatus,
                    newValue: status,
                    performedByUserId: requester?.id || null,
                    performedByName: requester?.name || null,
                    notes: null,
                }),
            ];
            if (statusActuallyChanging) {
                auditRows.push(
                    this.auditLogRepository.create({
                        userId: user.id,
                        action: UserAuditAction.SESSIONS_REVOKED,
                        previousValue: null,
                        newValue: null,
                        performedByUserId: requester?.id || null,
                        performedByName: requester?.name || null,
                        notes: `Sessions invalidated: account status changed from "${previousStatus}" to "${status}".`,
                    })
                );
            }
            await this.auditLogRepository.save(auditRows);

            const { password, ...rest } = user;
            return successResponse(res, rest, "User status updated successfully");
        } catch (error: any) {
            console.error("Set User Status Error", error);
            return errorResponse(res, "Error updating user status", [error.message], 500);
        }
    }

    /**
     * Explicit admin-triggered session revocation (task #5: "Allow
     * administrators to revoke a user's active sessions"). Bumps
     * tokenVersion so every token issued for this account before this
     * moment is rejected by authMiddleware's live tokenVersion check on
     * its very next request — the account itself is NOT suspended/
     * modified in any other way, it is simply forced to log in again
     * everywhere it is currently signed in. Distinct from setStatus()
     * (which ALSO revokes sessions, but as a side effect of a status
     * change) - this endpoint is for "this specific account's sessions
     * look suspicious / the user reported a lost device" without
     * otherwise touching the account.
     */
    async revokeSessions(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const user = await this.userRepository.findOneBy({ id });
            if (!user) {
                return errorResponse(res, "User not found", [], 404);
            }

            user.tokenVersion = (user.tokenVersion ?? 0) + 1;
            await this.userRepository.save(user);

            const requester = (req as any).user;
            await this.auditLogRepository.save(
                this.auditLogRepository.create({
                    userId: user.id,
                    action: UserAuditAction.SESSIONS_REVOKED,
                    previousValue: null,
                    newValue: null,
                    performedByUserId: requester?.id || null,
                    performedByName: requester?.name || null,
                    notes: "Sessions explicitly revoked by an administrator.",
                })
            );

            return successResponse(res, null, "All active sessions for this user have been revoked.");
        } catch (error: any) {
            console.error("Revoke Sessions Error", error);
            return errorResponse(res, "Error revoking sessions", [error.message], 500);
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
