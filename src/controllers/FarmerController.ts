import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Farmer } from "../entities/Farmer";
import { Farm } from "../entities/Farm";
import { User, UserRole } from "../entities/User";
import QRCode from 'qrcode';
import bcrypt from 'bcryptjs';
import { successResponse, errorResponse } from "../utils/response";
import { uploadFileToCloudinary, uploadFilesToCloudinary } from "../utils/cloudUpload";

export class FarmerController {
    private farmerRepository = AppDataSource.getRepository(Farmer);
    private farmRepository = AppDataSource.getRepository(Farm);
    private userRepository = AppDataSource.getRepository(User);

    async getAll(req: Request, res: Response) {
        try {
            const requester = (req as any).user;

            // Access rule:
            // - ADMIN sees every farmer, no restrictions.
            // - INSPECTOR sees only (a) farmers they personally registered
            //   (registeredByUserId matches their own user id), plus
            //   (b) "legacy" farmers created before this field existed
            //   (registeredByUserId IS NULL), so no previously-visible data
            //   disappears for anyone. New registrations going forward are
            //   properly attributed and scoped per inspector.
            // - BUYER/EXPORTER unaffected for now (out of scope of this fix).
            let farmers: Farmer[];
            if (requester?.role === UserRole.INSPECTOR) {
                farmers = await this.farmerRepository
                    .createQueryBuilder("farmer")
                    .leftJoinAndSelect("farmer.farms", "farms")
                    .where("farmer.registeredByUserId = :userId", { userId: requester.id })
                    .orWhere("farmer.registeredByUserId IS NULL")
                    .getMany();
            } else {
                farmers = await this.farmerRepository.find({ relations: ["farms"] });
            }

            return successResponse(res, farmers);
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error fetching farmers", [error.message], 500);
        }
    }

    async getMe(req: Request, res: Response) {
        try {
            const userId = (req as any).user?.id;
            if (!userId) return errorResponse(res, "Unauthorized", [], 401);

            const farmer = await this.farmerRepository.findOne({
                where: { user: { id: userId } },
                relations: ["farms"]
            });

            if (!farmer) return errorResponse(res, "Farmer profile not found for this user", [], 404);
            return successResponse(res, farmer);
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error fetching profile", [error.message], 500);
        }
    }

    async getOne(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const farmer = await this.farmerRepository.findOne({
                where: { id },
                relations: ["farms"]
            });
            if (!farmer) return errorResponse(res, "Farmer not found", [], 404);
            return successResponse(res, farmer);
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error fetching farmer", [error.message], 500);
        }
    }

    async create(req: Request, res: Response) {
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
                firstName, lastName, email, phoneNumber, password,
                gender, dob, nationality, nationalId, idType, idTypeOther, otherId, address, community, district, region,
                cooperativeName, cooperativeId, enumeratorName, enumeratorId, consent,
                directions, latitude, longitude
            } = body;

            // Real, reliable identity of whoever is authenticated and making
            // this request (from the verified JWT, not a free-text form
            // field) — used for per-inspector data scoping in getAll().
            const requester = (req as any).user;
            const registeredByUserId: string | undefined = requester?.id;

            // Basic validation
            if (!firstName || !lastName || !phoneNumber) {
                return res.status(400).json({ message: "Missing required fields" });
            }

            // Handle files — uploaded to Cloudinary (not local disk) so they
            // survive Render restarts/redeploys.
            const files = (req as any).files as Express.Multer.File[];
            const getFile = (fieldname: string) => files?.find(f => f.fieldname === fieldname);

            const queryRunner = AppDataSource.createQueryRunner();
            await queryRunner.connect();
            await queryRunner.startTransaction();

            try {
                // 1. Create User (if email is provided)
                let user: User | undefined;
                if (email) {
                    const existingUser = await queryRunner.manager.findOne(User, { where: { email } });
                    if (existingUser) {
                        await queryRunner.rollbackTransaction();
                        return res.status(400).json({ message: "User with this email already exists" });
                    }

                    const hashedPassword = await bcrypt.hash(password || "password123", 10);
                    user = new User();
                    user.email = email;
                    user.password = hashedPassword;
                    user.role = UserRole.FARMER;
                    user.name = `${firstName} ${lastName}`;
                    await queryRunner.manager.save(user);
                }

                // Duplication prevention: check nationalId and phoneNumber
                if (body.nationalId) {
                    const dupNat = await queryRunner.manager.findOne(Farmer, { where: { nationalId: body.nationalId } });
                    if (dupNat) {
                        await queryRunner.rollbackTransaction();
                        return errorResponse(res, "Farmer with this National ID already exists", [], 400);
                    }
                }
                // 2. Create Farmer
                const farmer = new Farmer();
                farmer.firstName = firstName;
                farmer.lastName = lastName;
                farmer.email = email;
                farmer.phoneNumber = phoneNumber;
                farmer.gender = gender;
                farmer.dob = dob ? new Date(dob) : undefined as any;
                farmer.nationality = nationality;
                farmer.nationalId = nationalId;
                farmer.idType = idType;
                farmer.idTypeOther = idTypeOther;
                farmer.otherId = otherId;
                farmer.address = address;
                farmer.community = community;
                farmer.district = district;
                farmer.region = region;
                farmer.cooperativeName = cooperativeName;
                farmer.cooperativeId = cooperativeId;
                farmer.enumeratorName = enumeratorName;
                farmer.enumeratorId = enumeratorId;
                farmer.registeredByUserId = registeredByUserId as any;
                farmer.consent = consent === 'true' || consent === true;
                farmer.directions = directions;
                farmer.latitude = latitude;
                farmer.longitude = longitude;

                const farmerPhotoFile = getFile('farmerPhoto');
                const idPhotoFile = getFile('idPhoto') || getFile('nationalId');
                const signatureFile = getFile('signature');
                const farmSelfieFile = getFile('farmSelfie');

                if (farmerPhotoFile) farmer.profilePhoto = await uploadFileToCloudinary(farmerPhotoFile);
                if (idPhotoFile) farmer.idPhoto = await uploadFileToCloudinary(idPhotoFile);
                if (signatureFile) farmer.signature = await uploadFileToCloudinary(signatureFile);
                if (farmSelfieFile) farmer.farmSelfie = await uploadFileToCloudinary(farmSelfieFile);

                if (user) {
                    farmer.user = user;
                }

                if (farmsData && Array.isArray(farmsData)) {
                    farmer.farms = farmsData.map((f: any, index: number) => {
                        const farm = new Farm();
                        farm.name = f.name;
                        farm.cropType = f.cropType;
                        farm.location = f.location;
                        farm.riskLevel = f.riskLevel;
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

                        return farm;
                    });
                    // Associate farmPhotos with the FIRST farm (as per requirement/limitations
                    // of FormData mapping simplicity). Uploaded to Cloudinary. Done outside the
                    // .map() above since it's async and .map() callbacks there are sync.
                    if (farmer.farms.length > 0) {
                        const farmPhotos = files?.filter(f => f.fieldname === 'farmPhotos[]' || f.fieldname === 'farmPhotos');
                        if (farmPhotos && farmPhotos.length > 0) {
                            farmer.farms[0].farmPhotos = await uploadFilesToCloudinary(farmPhotos);
                        }
                    }
                }

                const savedFarmer = await queryRunner.manager.save(Farmer, farmer);

                // Generate a human-readable Farmer ID + QR code (data URL) now that we have a real id
                const shortId = savedFarmer.id.split('-')[0].toUpperCase();
                savedFarmer.farmerId = `LACRA-${shortId}`;
                const publicProfileUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/public/farmers/${savedFarmer.id}`;
                savedFarmer.qrCode = await QRCode.toDataURL(publicProfileUrl);
                await queryRunner.manager.save(Farmer, savedFarmer);

                await queryRunner.commitTransaction();

                return successResponse(res, savedFarmer, "Farmer created successfully", 201);
            } catch (error: any) {
                await queryRunner.rollbackTransaction();
                console.error("Error creating farmer:", error);
                return errorResponse(res, "Error saving farmer", [error.message], 500);
            } finally {
                await queryRunner.release();
            }
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Internal server error", [error.message], 500);
        }
    }

    async update(req: Request, res: Response) {
        const { id } = req.params;
        const {
            firstName, lastName, email, phoneNumber,
            gender, dob, nationality, nationalId, idType, idTypeOther, otherId,
            address, community, district, region,
            cooperativeName, cooperativeId,
            enumeratorName, enumeratorId,
            directions, latitude, longitude,
            identityStatus, consent
        } = req.body;

        try {
            const farmer = await this.farmerRepository.findOne({
                where: { id },
                relations: ["farms"]
            });
            if (!farmer) return errorResponse(res, "Farmer not found", [], 404);

            // Basic identity
            farmer.firstName = firstName ?? farmer.firstName;
            farmer.lastName = lastName ?? farmer.lastName;
            farmer.email = email ?? farmer.email;
            farmer.phoneNumber = phoneNumber ?? farmer.phoneNumber;
            farmer.gender = gender ?? farmer.gender;
            farmer.dob = dob ? new Date(dob) : farmer.dob;
            farmer.nationality = nationality ?? farmer.nationality;
            farmer.nationalId = nationalId ?? farmer.nationalId;
            farmer.idType = idType ?? farmer.idType;
            farmer.idTypeOther = idTypeOther ?? farmer.idTypeOther;
            farmer.otherId = otherId ?? farmer.otherId;

            // Address / Location
            farmer.address = address ?? farmer.address;
            farmer.community = community ?? farmer.community;
            farmer.district = district ?? farmer.district;
            farmer.region = region ?? farmer.region;
            farmer.directions = directions ?? farmer.directions;
            farmer.latitude = latitude ?? farmer.latitude;
            farmer.longitude = longitude ?? farmer.longitude;

            // Cooperative / Enumerator
            farmer.cooperativeName = cooperativeName ?? farmer.cooperativeName;
            farmer.cooperativeId = cooperativeId ?? farmer.cooperativeId;
            farmer.enumeratorName = enumeratorName ?? farmer.enumeratorName;
            farmer.enumeratorId = enumeratorId ?? farmer.enumeratorId;

            // Verification
            if (identityStatus) farmer.identityStatus = identityStatus;
            if (consent !== undefined) farmer.consent = consent === true || consent === 'true';

            // Optional photo re-uploads (multipart) — uploaded to Cloudinary.
            const files = (req as any).files as Express.Multer.File[] | undefined;
            if (files && files.length > 0) {
                const getFile = (fieldname: string) => files.find(f => f.fieldname === fieldname);
                const farmerPhotoFile = getFile('farmerPhoto');
                const idPhotoFile = getFile('idPhoto') || getFile('nationalId');
                const signatureFile = getFile('signature');
                const farmSelfieFile = getFile('farmSelfie');
                if (farmerPhotoFile) farmer.profilePhoto = await uploadFileToCloudinary(farmerPhotoFile);
                if (idPhotoFile) farmer.idPhoto = await uploadFileToCloudinary(idPhotoFile);
                if (signatureFile) farmer.signature = await uploadFileToCloudinary(signatureFile);
                if (farmSelfieFile) farmer.farmSelfie = await uploadFileToCloudinary(farmSelfieFile);
            }

            await this.farmerRepository.save(farmer);
            return successResponse(res, farmer);
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error updating farmer", [error.message], 500);
        }
    }

    async setActiveStatus(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const { isActive } = req.body;

            const farmer = await this.farmerRepository.findOne({ where: { id } });
            if (!farmer) return errorResponse(res, "Farmer not found", [], 404);

            farmer.isActive = isActive === true || isActive === 'true';
            await this.farmerRepository.save(farmer);

            return successResponse(res, farmer, farmer.isActive ? "Farmer reactivated" : "Farmer deactivated");
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error updating farmer status", [error.message], 500);
        }
    }

    async getPublicFarmer(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const farmer = await this.farmerRepository.findOne({
                where: { id },
                relations: ["farms"]
            });

            if (!farmer) {
                return res.status(404).json({ message: "Farmer not found" });
            }

            // Return ALL fields as requested
            const publicData = {
                id: farmer.id,
                farmerId: farmer.farmerId,
                firstName: farmer.firstName,
                lastName: farmer.lastName,
                email: farmer.email,
                phoneNumber: farmer.phoneNumber,
                nationalId: farmer.nationalId,
                idType: farmer.idType,
                idTypeOther: farmer.idTypeOther,
                gender: farmer.gender,
                dob: farmer.dob,
                nationality: farmer.nationality,
                otherId: farmer.otherId,
                address: farmer.address,
                community: farmer.community,
                district: farmer.district,
                region: farmer.region,
                cooperativeName: farmer.cooperativeName,
                cooperativeId: farmer.cooperativeId,
                enumeratorName: farmer.enumeratorName,
                enumeratorId: farmer.enumeratorId,
                profilePhoto: farmer.profilePhoto, // Assuming this is a public URL or path handled by frontend
                idPhoto: farmer.idPhoto,
                signature: farmer.signature,
                consent: farmer.consent,
                identityStatus: farmer.identityStatus,
                directions: farmer.directions,
                latitude: farmer.latitude,
                longitude: farmer.longitude,
                createdAt: farmer.createdAt,
                updatedAt: farmer.updatedAt,
                farms: farmer.farms.map(f => ({
                    name: f.name,
                    cropType: f.cropType,
                    totalAreaHa: f.totalAreaHa,
                    location: f.location,
                    riskLevel: f.riskLevel,
                    farmRegistrationStatus: f.farmRegistrationStatus,
                    ownershipType: f.ownershipType,
                    numberOfTrees: f.numberOfTrees,
                    yearsInCultivation: f.yearsInCultivation,
                    harvestSeason: f.harvestSeason,
                    averageYield: f.averageYield,
                    useChemicals: f.useChemicals,
                    extensionServices: f.extensionServices,
                    farmAddress: f.farmAddress
                }))
            };

            return successResponse(res, publicData);
        } catch (error: any) {
            console.error("Error fetching public farmer profile:", error);
            return errorResponse(res, "Error loading profile", [error.message], 500);
        }
    }

    async offlineSync(req: Request, res: Response) {
        try {
            const { farmer: farmerData, farms: farmsData = [] } = req.body;
            if (!farmerData?.firstName || !farmerData?.lastName || !farmerData?.phoneNumber) {
                return errorResponse(res, "Farmer firstName, lastName and phoneNumber required", [], 400);
            }
            if (farmerData.nationalId) {
                const dup = await this.farmerRepository.findOneBy({ nationalId: farmerData.nationalId });
                if (dup) return errorResponse(res, "Farmer with this National ID already exists", [], 400);
            }
            if (farmerData.email) {
                const dupUser = await this.userRepository.findOneBy({ email: farmerData.email });
                if (dupUser) return errorResponse(res, "User with this email already exists", [], 400);
            }

            const farmer = new Farmer();
            farmer.firstName = farmerData.firstName;
            farmer.lastName = farmerData.lastName;
            farmer.phoneNumber = farmerData.phoneNumber;
            farmer.email = farmerData.email;
            farmer.nationalId = farmerData.nationalId;
            farmer.idType = farmerData.idType;
            farmer.idTypeOther = farmerData.idTypeOther;
            farmer.gender = farmerData.gender;
            farmer.address = farmerData.address;
            farmer.community = farmerData.community;
            farmer.district = farmerData.district;
            farmer.region = farmerData.region;
            farmer.consent = farmerData.consent === true || farmerData.consent === "true";
            farmer.cooperativeName = farmerData.cooperativeName;
            farmer.cooperativeId = farmerData.cooperativeId;
            farmer.enumeratorId = farmerData.enumeratorId;
            farmer.enumeratorName = farmerData.enumeratorName;
            farmer.registeredByUserId = (req as any).user?.id;

            if (farmerData.email) {
                const user = new User();
                user.email = farmerData.email;
                user.password = await bcrypt.hash(farmerData.password || "password123", 10);
                user.role = UserRole.FARMER;
                user.name = `${farmerData.firstName} ${farmerData.lastName}`;
                await this.userRepository.save(user);
                farmer.user = user;
            }

            const savedFarmer = await this.farmerRepository.save(farmer);

            // Generate human-readable Farmer ID + QR code now that we have a real id
            const shortId = savedFarmer.id.split('-')[0].toUpperCase();
            savedFarmer.farmerId = `LACRA-${shortId}`;
            const publicProfileUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/public/farmers/${savedFarmer.id}`;
            savedFarmer.qrCode = await QRCode.toDataURL(publicProfileUrl);
            await this.farmerRepository.save(savedFarmer);

            for (const f of farmsData) {
                if (!f.name || !f.cropType || !f.location) continue;
                const farm = new Farm();
                farm.name = f.name;
                farm.cropType = f.cropType;
                farm.location = typeof f.location === "string" ? JSON.parse(f.location) : f.location;
                if (f.totalAreaHa) farm.totalAreaHa = parseFloat(f.totalAreaHa);
                if (f.numberOfTrees) farm.numberOfTrees = parseInt(f.numberOfTrees);
                if (f.yearsInCultivation) farm.yearsInCultivation = parseInt(f.yearsInCultivation);
                farm.harvestSeason = f.harvestSeason;
                farm.averageYield = f.averageYield;
                farm.buyers = f.buyers;
                farm.useChemicals = f.useChemicals === true || f.useChemicals === "true";
                farm.extensionServices = f.extensionServices === true || f.extensionServices === "true";
                farm.farmAddress = f.farmAddress;
                farm.farmer = savedFarmer;
                await this.farmRepository.save(farm);
            }

            return successResponse(res, savedFarmer, "Farmer synced successfully", 201);
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error syncing farmer", [error.message], 500);
        }
    }

    /**
     * One-time maintenance endpoint: assigns a human-readable Farmer ID (LACRA-XXXXXXXX)
     * + QR code to any existing farmer record that was created before this generation step
     * existed on a given registration path (e.g. the mobile-app flow in AuthController.register,
     * which was missing this logic until now). Safe to call repeatedly - only touches farmers
     * whose farmerId is still NULL/empty, so already-assigned IDs are never overwritten.
     */
    async backfillFarmerIds(req: Request, res: Response) {
        try {
            const farmers = await this.farmerRepository
                .createQueryBuilder("farmer")
                .where("farmer.farmerId IS NULL")
                .orWhere("farmer.farmerId = :empty", { empty: "" })
                .getMany();

            let updated = 0;
            for (const farmer of farmers) {
                const shortId = farmer.id.split('-')[0].toUpperCase();
                farmer.farmerId = `LACRA-${shortId}`;
                if (!farmer.qrCode) {
                    const publicProfileUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/public/farmers/${farmer.id}`;
                    farmer.qrCode = await QRCode.toDataURL(publicProfileUrl);
                }
                await this.farmerRepository.save(farmer);
                updated++;
            }

            return successResponse(res, { updated, total: farmers.length }, `Backfilled ${updated} farmer ID(s)`);
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error backfilling farmer IDs", [error.message], 500);
        }
    }
}
