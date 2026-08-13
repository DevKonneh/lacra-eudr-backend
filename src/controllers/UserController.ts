import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { User, UserRole, UserStatus } from "../entities/User";
import { Role } from "../entities/Role";
import bcrypt from "bcryptjs";
import { successResponse, errorResponse } from "../utils/response";

export class UserController {
    private userRepository = AppDataSource.getRepository(User);
    private roleRepository = AppDataSource.getRepository(Role);

    async create(req: Request, res: Response) {
        try {
            const { email, password, name, roleId, status, roleType } = req.body;

            const existingUser = await this.userRepository.findOneBy({ email });
            if (existingUser) {
                return errorResponse(res, "User with this email already exists", [], 400);
            }

            const hashedPassword = await bcrypt.hash(password, 10);

            const user = new User();
            user.email = email;
            user.password = hashedPassword;
            user.name = name;
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
            const { email, name, roleId, status, roleType, password } = req.body;

            const user = await this.userRepository.findOneBy({ id });
            if (!user) {
                return errorResponse(res, "User not found", [], 404);
            }

            if (email && email !== user.email) {
                const existingUser = await this.userRepository.findOneBy({ email });
                if (existingUser) {
                    return errorResponse(res, "User with this email already exists", [], 400);
                }
                user.email = email;
            }

            if (password) {
                user.password = await bcrypt.hash(password, 10);
            }

            user.name = name ?? user.name;
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

            const { password: _, ...rest } = user;
            return successResponse(res, rest);
        } catch (error: any) {
            return errorResponse(res, "Error updating user", [error.message], 500);
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
