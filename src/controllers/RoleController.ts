import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Role } from "../entities/Role";
import { successResponse, errorResponse } from "../utils/response";

export class RoleController {
    private roleRepository = AppDataSource.getRepository(Role);

    async create(req: Request, res: Response) {
        try {
            const { name, description, permissions } = req.body;
            const existingRole = await this.roleRepository.findOneBy({ name });
            if (existingRole) {
                return errorResponse(res, "Role with this name already exists", [], 400);
            }

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
