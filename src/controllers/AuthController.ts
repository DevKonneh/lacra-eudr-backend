import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { User, UserRole, UserStatus } from "../entities/User";
import { Farmer } from "../entities/Farmer";
import { Farm } from "../entities/Farm";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../middleware/auth.middleware";
import { EmailService } from "../services/EmailService";
import { successResponse, errorResponse } from "../utils/response";
import { toPublicFileUrl, toPublicFileUrls } from "../utils/fileUrl";

export class AuthController {
    private userRepository = AppDataSource.getRepository(User);
    private emailService = new EmailService();

    async register(req: Request, res: Response) {
        try {
            const { email, password, role, name } = req.body;

            const existingUser = await this.userRepository.findOneBy({ email });
            if (existingUser) {
                return errorResponse(res, "User already exists", [], 400);
            }

            const hashedPassword = await bcrypt.hash(password, 10);
            const user = this.userRepository.create({
                email,
                password: hashedPassword,
                role: role || UserRole.INSPECTOR,
                name
            });

            await this.userRepository.save(user);
            return successResponse(res, { userId: user.id }, "User registered successfully", 201);
        } catch (error: any) {
            console.error("Register Error", error);
            return errorResponse(res, "Error registering user", [error.message], 500);
        }
    }

    async login(req: Request, res: Response) {
        try {
            const { email, password } = req.body;

            const user = await this.userRepository.findOne({
                where: { email },
                relations: ["assignedRole"]
            });
            if (!user) {
                return errorResponse(res, "Invalid credentials", [], 401);
            }

            if (user.status !== UserStatus.ACTIVE) {
                return errorResponse(res, `Account is ${user.status}. Please contact support.`, [], 403);
            }

            const isMatch = await bcrypt.compare(password, user.password);
            if (!isMatch) {
                return errorResponse(res, "Invalid credentials", [], 401);
            }

            const permissions = user.assignedRole?.permissions || [];

            const token = jwt.sign(
                { id: user.id, email: user.email, role: user.role, name: user.name },
                JWT_SECRET,
                { expiresIn: "24h" }
            );

            return successResponse(res, {
                token,
                user: {
                    id: user.id,
                    email: user.email,
                    role: user.role,
                    name: user.name,
                    permissions
                }
            }, "Login successful");
        } catch (error: any) {
            console.error("Login Error", error);
            return errorResponse(res, "Error logging in", [error.message], 500);
        }
    }



    async forgotPassword(req: Request, res: Response) {
        try {
            const { email } = req.body;
            if (!email) return errorResponse(res, "Email is required", [], 400);

            const user = await this.userRepository.findOneBy({ email });
            if (!user) {
                // Return success even if user not found to prevent enumeration
                return successResponse(res, null, "If account exists, code sent.");
            }

            // Generate 6 digit code
            const code = Math.floor(100000 + Math.random() * 900000).toString();

            // Set expiration (15 mins)
            const expires = new Date();
            expires.setMinutes(expires.getMinutes() + 15);

            user.verificationCode = code;
            user.verificationCodeExpires = expires;
            await this.userRepository.save(user);

            // Send Email
            await this.emailService.sendVerificationEmail(email, code);

            return successResponse(res, null, "Verification code sent.");
        } catch (error: any) {
            console.error("Forgot Password Error", error);
            return errorResponse(res, "Error sending code", [error.message], 500);
        }
    }

    async resetPassword(req: Request, res: Response) {
        try {
            const { email, verificationCode, newPassword } = req.body;
            if (!email || !verificationCode || !newPassword) {
                return errorResponse(res, "Missing fields", [], 400);
            }

            const user = await this.userRepository.findOneBy({ email });
            if (!user) {
                return errorResponse(res, "Invalid request", [], 400);
            }

            // Check Code
            if (user.verificationCode !== verificationCode) {
                return errorResponse(res, "Invalid verification code", [], 400);
            }

            // Check Expiration
            if (!user.verificationCodeExpires || user.verificationCodeExpires < new Date()) {
                return errorResponse(res, "Verification code expired", [], 400);
            }

            // Update Password
            const hashedPassword = await bcrypt.hash(newPassword, 10);
            user.password = hashedPassword;

            // Clear Code
            user.verificationCode = null as any;
            user.verificationCodeExpires = null as any;

            await this.userRepository.save(user);

            return successResponse(res, null, "Password reset successfully. You can now login.");
        } catch (error: any) {
            console.error("Reset Password Error", error);
            return errorResponse(res, "Error resetting password", [error.message], 500);
        }
    }

    async registerFarmer(req: Request, res: Response) {
        try {
            const body = req.body;

            // Parse farms if it's a string (since multipart sends it as string)
            let farmsData = body.farms;
            if (typeof farmsData === 'string') {
                try {
                    farmsData = JSON.parse(farmsData);
                } catch (e) {
                    console.error("Error parsing farms JSON", e);
                    farmsData = [];
                }
            }

            const {
                // Personal
                fullName,
                gender,
                dob,
                phone, // maps to phoneNumber
                nationality,
                nationalId,
                otherId,
                // Location
                county,
                district,
                community,
                inspectorName,
                lat,
                lng,
                directions,
                // Farm
                farmName,
                crop,
                ownership,
                regStatus,
                farmSizeManual,
                farmUnitManual,
                farmNotes,
                // Mapping
                boundaryJson,
                areaHa,
                areaAc,
                // Misc
                consent,
                email // still needed for User account
            } = body;

            // Handle files
            const files = (req as any).files as Express.Multer.File[];
            const getFilePath = (fieldname: string) => {
                const file = files?.find(f => f.fieldname === fieldname);
                return file ? file.path : undefined;
            };

            const queryRunner = AppDataSource.createQueryRunner();
            await queryRunner.connect();
            await queryRunner.startTransaction();

            try {
                // Determine email to use
                let userEmail = email;
                if (!userEmail) {
                    const randomId = Math.random().toString(36).substring(2, 10);
                    userEmail = `farmer_${Date.now()}_${randomId}@lacra.temp`;
                } else {
                    // Check existing user only if email was provided
                    const existingUser = await queryRunner.manager.findOne(User, { where: { email: userEmail } });
                    if (existingUser) {
                        await queryRunner.rollbackTransaction();
                        return errorResponse(res, "User already exists", [], 400);
                    }
                }

                // Create User (Generate random password if none provided, since this is inspector-led)
                const generatedPassword = Math.random().toString(36).slice(-8);
                const hashedPassword = await bcrypt.hash(generatedPassword, 10);

                const user = new User();
                user.email = userEmail;
                user.password = hashedPassword;
                user.role = UserRole.FARMER;
                user.name = fullName;
                user.status = UserStatus.PENDING;
                await queryRunner.manager.save(user);

                // Create Farmer
                const farmer = new Farmer();
                // Split name
                const names = (fullName || "").split(' ');
                farmer.firstName = names[0] || "";
                farmer.lastName = names.slice(1).join(' ') || "";

                farmer.email = email;
                farmer.phoneNumber = phone;
                farmer.gender = gender;
                farmer.dob = dob ? new Date(dob) : new Date(); // Handle valid date parsing
                farmer.nationality = nationality;
                farmer.nationalId = nationalId;
                farmer.otherId = otherId;
                farmer.district = district;
                farmer.community = community;

                // Map county to region/address or just save in address for now if no county col, 
                // but we added none. Assuming county maps to region or address. 
                // Let's put county in region for this mapping.
                farmer.region = county;

                farmer.enumeratorName = inspectorName;
                farmer.directions = directions;
                farmer.latitude = lat;
                farmer.longitude = lng;
                farmer.consent = consent === 'true' || consent === true;

                // Map Files
                farmer.profilePhoto = toPublicFileUrl(getFilePath('farmerPhoto')) as string;
                farmer.idPhoto = toPublicFileUrl(getFilePath('idPhoto') || getFilePath('nationalId')) as string;
                farmer.farmSelfie = toPublicFileUrl(getFilePath('farmSelfie')) as string;
                farmer.signature = toPublicFileUrl(getFilePath('signature')) as string;

                farmer.user = user;

                await queryRunner.manager.save(Farmer, farmer);

                // Create Farm if details provided
                if (farmsData && Array.isArray(farmsData) && farmsData.length > 0) {
                    // If farmsData passed via JSON string (advanced frontend)
                    for (let i = 0; i < farmsData.length; i++) {
                        const f = farmsData[i];
                        const farm = new Farm();
                        farm.name = f.name;
                        farm.cropType = f.cropType;
                        farm.location = f.location;
                        farm.totalAreaHa = f.totalAreaHa ? parseFloat(f.totalAreaHa) : 0;
                        farm.ownershipType = f.ownershipType;
                        farm.farmRegistrationStatus = f.farmRegistrationStatus;
                        farm.numberOfTrees = f.numberOfTrees ? parseInt(f.numberOfTrees) : 0;
                        farm.yearsInCultivation = f.yearsInCultivation ? parseInt(f.yearsInCultivation) : 0;
                        farm.harvestSeason = f.harvestSeason;
                        farm.averageYield = f.averageYield;
                        farm.buyers = f.buyers;
                        farm.useChemicals = f.useChemicals === 'true' || f.useChemicals === true;
                        farm.extensionServices = f.extensionServices === 'true' || f.extensionServices === true;
                        farm.farmAddress = f.farmAddress;
                        // Handle farm photos for first farm
                        if (i === 0) {
                            const farmPhotos = files?.filter(file => file.fieldname === 'farmPhotos[]' || file.fieldname === 'farmPhotos');
                            if (farmPhotos && farmPhotos.length > 0) {
                                farm.farmPhotos = toPublicFileUrls(farmPhotos.map(fp => fp.path));
                            }
                        }
                        farm.farmer = farmer;
                        await queryRunner.manager.save(Farm, farm);
                    }
                } else if (farmName) {
                    // Fallback to flat fields if farms array not used
                    const farm = new Farm();
                    farm.name = farmName;
                    farm.cropType = crop;
                    farm.ownershipType = ownership;
                    farm.farmRegistrationStatus = regStatus;
                    farm.totalAreaHa = areaHa ? parseFloat(areaHa) : 0;
                    farm.farmNotes = farmNotes;
                    farm.manualSizeInput = farmSizeManual;
                    farm.manualSizeUnit = farmUnitManual;

                    if (boundaryJson) {
                        try {
                            const boundary = JSON.parse(boundaryJson);
                            farm.location = boundary.geometry || boundary;
                        } catch (e) {
                            console.error("Invalid GeoJSON", e);
                        }
                    } else if (lat && lng) {
                        // Point geom if no boundary
                        const point = { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] };
                        farm.location = point;
                    }

                    // Map farm photos to this single farm
                    const farmPhotos = files?.filter(file => file.fieldname === 'farmPhotos[]' || file.fieldname === 'farmPhotos');
                    if (farmPhotos && farmPhotos.length > 0) {
                        farm.farmPhotos = toPublicFileUrls(farmPhotos.map(fp => fp.path));
                    }

                    farm.farmer = farmer;

                    await queryRunner.manager.save(Farm, farm);
                }

                await queryRunner.commitTransaction();
                return successResponse(res, null, "Registration successful. Pending approval.", 201);
            } catch (error: any) {
                await queryRunner.rollbackTransaction();
                console.error("Farmer Register Error", error);

                // Handle unique constraint violation (Postgres code 23505)
                if (error.code === '23505') {
                    // Try to extract field from detail "Key (email)=(...) already exists."
                    const detail = error.detail;
                    if (detail) {
                        const match = detail.match(/Key \((.*?)\)=\(.*?\) already exists/);
                        if (match && match[1]) {
                            return errorResponse(res, `Duplicate entry: ${match[1]} already exists.`, [], 400);
                        }
                    }
                    // Fallback if detail parsing fails but we know it's a unique constraint
                    return errorResponse(res, "Duplicate entry found. Please check email or ID fields.", [], 400);
                }

                return errorResponse(res, "Error registering farmer", [error.message], 500);
            } finally {
                await queryRunner.release();
            }
        } catch (error: any) {
            console.error("Auth Controller Error", error);
            return errorResponse(res, "Internal server error", [error.message], 500);
        }
    }

    async getPendingUsers(req: Request, res: Response) {
        try {
            const users = await this.userRepository.find({
                where: { status: UserStatus.PENDING },
                order: { createdAt: 'DESC' }
            });
            return successResponse(res, users);
        } catch (error: any) {
            return errorResponse(res, "Error fetching pending users", [error.message], 500);
        }
    }

    async approveUser(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const user = await this.userRepository.findOneBy({ id });
            if (!user) return errorResponse(res, "User not found", [], 404);

            user.status = UserStatus.ACTIVE;
            await this.userRepository.save(user);
            return successResponse(res, null, "User approved successfully");
        } catch (error: any) {
            return errorResponse(res, "Error approving user", [error.message], 500);
        }
    }

    async rejectUser(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const user = await this.userRepository.findOneBy({ id });
            if (!user) return errorResponse(res, "User not found", [], 404);

            user.status = UserStatus.REJECTED;
            await this.userRepository.save(user);
            return successResponse(res, null, "User rejected");
        } catch (error: any) {
            return errorResponse(res, "Error rejecting user", [error.message], 500);
        }
    }
}
