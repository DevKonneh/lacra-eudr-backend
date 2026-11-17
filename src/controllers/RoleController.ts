import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Role } from "../entities/Role";
import { User } from "../entities/User";
import { successResponse, errorResponse } from "../utils/response";
import { getEffectivePermissions, isSubsetOfActorPermissions, ALL_PERMISSIONS, WILDCARD_PERMISSION } from "../config/permissions";

export class RoleController {
    private roleRepository = AppDataSource.getRepository(Role);
    private userRepository = AppDataSource.getRepository(User);

    /**
     * Privilege-escalation guard: a Role's `permissions` array may only be
     * set to a subset of the REQUESTING actor's own current effective
     * permissions (or the actor already holds the 'all' wildcard, i.e. is
     * ADMIN). Also rejects any permission string that isn't in the known
     * catalog, so a typo or a client-side bug can't silently create a
     * permission string that nothing will ever actually check (defeating
     * the entire point of this system). Returns an error string on
     * failure, undefined on success.
     *
     * Every route calling into this controller is ADMIN-only today (see
     * role.routes.ts's blanket authMiddleware([UserRole.ADMIN])), and
     * ADMIN always holds the 'all' wildcard, so in practice this guard is
     * currently a no-op for every real caller — it is still applied
     * defensively so that if role.routes.ts is ever changed to allow a
     * non-ADMIN account with ROLE_CREATE/ROLE_EDIT permission to reach
     * this controller, self-escalation is already blocked from day one.
     */
    private async checkPermissionsEscalation(req: Request, requestedPermissions: string[]): Promise<string | undefined> {
        const invalid = requestedPermissions.filter(
            (p) => p !== WILDCARD_PERMISSION && !ALL_PERMISSIONS.includes(p)
        );
        if (invalid.length > 0) {
            return `Unknown permission(s): ${invalid.join(", ")}`;
        }

        const requester = (req as any).user;
        if (!requester?.id) {
            return "Unable to verify requester identity for this operation.";
        }
        const actorUser = await this.userRepository.findOne({
            where: { id: requester.id },
            relations: ["assignedRole"],
        });
        if (!actorUser) {
            return "Requesting account could not be verified.";
        }
        const actorPermissions = getEffectivePermissions(actorUser);

        if (!isSubsetOfActorPermissions(requestedPermissions, actorPermissions)) {
            return "You cannot create or edit a permission group that grants more access than your own account currently has.";
        }
        return undefined;
    }

    async create(req: Request, res: Response) {
        try {
            const { name, description, permissions } = req.body;
            const existingRole = await this.roleRepository.findOneBy({ name });
            if (existingRole) {
                return errorResponse(res, "Role with this name already exists", [], 400);
            }

            const escalationError = await this.checkPermissionsEscalation(req, Array.isArray(permissions) ? permissions : []);
            if (escalationError) return errorResponse(res, escalationError, [], 403);

            const role = this.roleRepository.create({ name, description, permissions });
            await this.roleRepository.save(role);
            return successResponse(res, role, "Role created successfully", 201);
        } catch (error: any) {
            console.error("Create Role Error", error);
            return errorResponse(res, "Error creating role", [error.message], 500);
        }
    }

    async getAll(req: Request, res: Response) {
        try {
            const roles = await this.roleRepository.find();
            return successResponse(res, roles);
        } catch (error: any) {
            console.error("Get Roles Error", error);
            return errorResponse(res, "Error fetching roles", [error.message], 500);
        }
    }

    async getOne(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const role = await this.roleRepository.findOneBy({ id });
            if (!role) {
                return errorResponse(res, "Role not found", [], 404);
            }
            return successResponse(res, role);
        } catch (error: any) {
            return errorResponse(res, "Error fetching role", [error.message], 500);
        }
    }

    async update(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const { name, description, permissions } = req.body;
            const role = await this.roleRepository.findOneBy({ id });

            if (!role) {
                return errorResponse(res, "Role not found", [], 404);
            }

            if (name && name !== role.name) {
                const existingRole = await this.roleRepository.findOneBy({ name });
                if (existingRole) {
                    return errorResponse(res, "Role with this name already exists", [], 400);
                }
            }

            if (permissions !== undefined) {
                const escalationError = await this.checkPermissionsEscalation(req, Array.isArray(permissions) ? permissions : []);
                if (escalationError) return errorResponse(res, escalationError, [], 403);
            }

            role.name = name ?? role.name;
            role.description = description ?? role.description;
            role.permissions = permissions ?? role.permissions;

            await this.roleRepository.save(role);
            return successResponse(res, role);
        } catch (error: any) {
            return errorResponse(res, "Error updating role", [error.message], 500);
        }
    }

    async delete(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const result = await this.roleRepository.delete(id);
            if (result.affected === 0) {
                return errorResponse(res, "Role not found", [], 404);
            }
            return successResponse(res, { deleted: true }, "Role deleted successfully");
        } catch (error: any) {
            return errorResponse(res, "Error deleting role", [error.message], 500);
        }
    }
}
