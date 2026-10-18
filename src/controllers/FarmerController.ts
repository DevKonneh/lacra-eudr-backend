import { Request, Response } from "express";
import { Brackets } from "typeorm";
import { AppDataSource } from "../data-source";
import { Farmer } from "../entities/Farmer";
import { Farm } from "../entities/Farm";
import { Plot } from "../entities/Plot";
import { User, UserRole } from "../entities/User";
import { FarmerAuditLog, FarmerAuditAction } from "../entities/FarmerAuditLog";
import QRCode from 'qrcode';
import bcrypt from 'bcryptjs';
import { successResponse, errorResponse } from "../utils/response";
import { uploadFileToCloudinary, uploadFilesToCloudinary } from "../utils/cloudUpload";
import { getGeoIdService, GeoIdService } from "../services/GeoIdService";
import { buildPlotsForFarm, deriveLegacyCropType, CommodityInput } from "../services/CommodityService";
import { CommodityRole, CroppingSystem } from "../entities/PlotCommodity";
import { validateAndAnnotateFarm, assertGeometryNotBlocking } from "../services/FarmGeometryHelper";

// Relations needed whenever a Farmer response should include each farm's
// full multi-commodity structure (Plot -> PlotCommodity -> Commodity), used
// by the FarmerProfile "Registered Farms" table (primary/additional
// commodities, cropping system, estimated production, compliance).
const FARMER_FARM_COMMODITY_RELATIONS = ["farms", "farms.plots", "farms.plots.plotCommodities", "farms.plots.plotCommodities.commodity"];

// Contact/location fields that are safe to update on a returning farmer
// via the "Add Farm to Existing Farmer" flow's identity-confirmation
// screen, WITHOUT re-collecting the farmer's full personal profile.
// Every change to one of these fields is written to FarmerAuditLog (see
// update() below) so there is a reviewable trail of who changed what.
const AUDITABLE_CONTACT_FIELDS: (keyof Farmer)[] = [
    "phoneNumber", "email", "address", "community", "district", "region", "directions",
];

/**
 * Best-effort GeoID mint + farm-scan QR generation for a farm that already
 * has a saved UUID. Never throws — a GeoID/network hiccup must NOT block
 * farmer/farm registration; the `/farms/backfill-geoids` endpoint can
 * recover any farm that ends up without one.
 */
async function mintGeoIdForFarm(farmRepository: ReturnType<typeof AppDataSource.getRepository<Farm>>, farm: Farm, context: string) {
    try {
        const geometry = GeoIdService.normaliseGeometry(farm.location);
        if (geometry) {
            const geoIdSvc = getGeoIdService();
            const result = await geoIdSvc.mintGeoId(geometry, farm.id);
            farm.geoId = result.geoid;
            farm.geoIdUri = result.uri;
            if (!farm.farmQrCode) {
                const scanUrl = GeoIdService.farmScanUrl(farm.id);
                farm.farmQrCode = await QRCode.toDataURL(scanUrl);
            }
            await farmRepository.save(farm);
            console.log(`[GeoID] Minted ${result.geoid} for farm ${farm.id} (${context})`);
        }
    } catch (geoErr: any) {
        console.warn(`[GeoID] Mint failed for farm ${farm.id} (${context}, non-fatal): ${geoErr.message}`);
    }
}

export class FarmerController {
    private farmerRepository = AppDataSource.getRepository(Farmer);
    private farmRepository = AppDataSource.getRepository(Farm);
    private plotRepository = AppDataSource.getRepository(Plot);
    private userRepository = AppDataSource.getRepository(User);
    private auditLogRepository = AppDataSource.getRepository(FarmerAuditLog);

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
                relations: FARMER_FARM_COMMODITY_RELATIONS
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
                relations: FARMER_FARM_COMMODITY_RELATIONS
            });
            if (!farmer) return errorResponse(res, "Farmer not found", [], 404);
            return successResponse(res, farmer);
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error fetching farmer", [error.message], 500);
        }
    }

    /**
     * Farmer lookup for the "Add Farm to Existing Farmer" workflow step.
     * Supports every search method the spec requires:
     *   - Farmer ID (exact, e.g. "LACRA-A1B2C3D4")
     *   - QR code payload (the public-profile URL encoded in the QR, or a
     *     bare farmer UUID/farmerId scanned from it — see resolution below)
     *   - Telephone number (exact or partial match)
     *   - National ID (exact match)
     *   - Free-text across name / county / district / community (partial)
     * Returns a lightweight "possible matches" projection (not the full
     * record) — photo, name, Farmer ID, phone, county/community, farm
     * count, and distinct commodities — exactly matching what the spec
     * says the enumerator should be shown before picking a farmer.
     */
    async search(req: Request, res: Response) {
        try {
            const requester = (req as any).user;
            const q = String(req.query.q || "").trim();
            const qr = String(req.query.qr || "").trim();
            if (!q && !qr) {
                return errorResponse(res, "Provide a search query ('q') or scanned QR payload ('qr')", [], 400);
            }

            const qb = this.farmerRepository
                .createQueryBuilder("farmer")
                .leftJoinAndSelect("farmer.farms", "farms");

            if (qr) {
                // A scanned QR encodes the public-profile URL
                // (".../public/farmers/<uuid>"), but be tolerant of a bare
                // UUID or farmerId being scanned/pasted too.
                const idMatch = qr.match(/farmers\/([a-f0-9-]{36})/i);
                const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                const extractedId = idMatch ? idMatch[1] : qr;
                // Postgres type-checks a `uuid` column comparison even inside an
                // OR branch that won't ultimately match, so only include the
                // `farmer.id = :extractedId` clause when extractedId actually
                // looks like a UUID — otherwise a bare farmerId (e.g.
                // "LACRA-XXXXXXXX") scanned/pasted here would throw
                // "invalid input syntax for type uuid" before the farmerId
                // branch even gets a chance to match.
                qb.andWhere(new Brackets((sub) => {
                    if (uuidRegex.test(extractedId)) {
                        sub.where("farmer.id = :extractedId", { extractedId });
                        sub.orWhere("farmer.farmerId = :qr", { qr });
                    } else {
                        sub.where("farmer.farmerId = :qr", { qr });
                    }
                }));
            } else {
                qb.andWhere(new Brackets((sub) => {
                    sub.where("farmer.farmerId ILIKE :exact", { exact: q })
                        .orWhere("farmer.phoneNumber ILIKE :partial", { partial: `%${q}%` })
                        .orWhere("farmer.nationalId ILIKE :exact", { exact: q })
                        .orWhere("farmer.firstName ILIKE :partial", { partial: `%${q}%` })
                        .orWhere("farmer.lastName ILIKE :partial", { partial: `%${q}%` })
                        .orWhere("farmer.region ILIKE :partial", { partial: `%${q}%` })
                        .orWhere("farmer.district ILIKE :partial", { partial: `%${q}%` })
                        .orWhere("farmer.community ILIKE :partial", { partial: `%${q}%` });
                }));
            }

            // Same per-inspector visibility scoping as getAll(): an
            // INSPECTOR must only be able to find (and thus add a farm
            // to) farmers they personally registered, plus legacy
            // farmers with no registeredByUserId recorded. ADMIN is
            // unrestricted. This prevents the search-first workflow from
            // becoming a way to browse/edit farmers outside an
            // inspector's own scope.
            if (requester?.role === UserRole.INSPECTOR) {
                qb.andWhere(new Brackets((sub) => {
                    sub.where("farmer.registeredByUserId = :userId", { userId: requester.id })
                        .orWhere("farmer.registeredByUserId IS NULL");
                }));
            }

            const matches = await qb.take(25).getMany();

            const results = matches.map((f) => ({
                id: f.id,
                farmerId: f.farmerId,
                fullName: `${f.firstName} ${f.lastName}`.trim(),
                profilePhoto: f.profilePhoto,
                phoneNumber: f.phoneNumber,
                county: f.region,
                district: f.district,
                community: f.community,
                farmCount: f.farms?.length || 0,
                commodities: Array.from(new Set((f.farms || []).map((farm) => farm.cropType))),
                isActive: f.isActive,
            }));

            return successResponse(res, results);
        } catch (error: any) {
            console.error("Error searching farmers:", error);
            return errorResponse(res, "Error searching farmers", [error.message], 500);
        }
    }

    /**
     * Returns the audit trail (contact-info changes + farm-added events)
     * for a farmer, most-recent first. Used on the Farmer Profile page
     * and available for compliance review of the "Add Farm to Existing
     * Farmer" workflow's identity-confirmation step.
     */
    async getAuditLog(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const logs = await this.auditLogRepository.find({
                where: { farmerId: id },
                order: { createdAt: "DESC" },
            });
            return successResponse(res, logs);
        } catch (error: any) {
            console.error("Error fetching farmer audit log:", error);
            return errorResponse(res, "Error fetching audit log", [error.message], 500);
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

                // Per-farm commodities arrays (new multi-commodity model),
                // captured alongside each farm object below so Plot +
                // PlotCommodity rows can be created once each farm has a
                // real id (after the initial save further down).
                const perFarmCommodityInputs: CommodityInput[][] = [];

                if (farmsData && Array.isArray(farmsData)) {
                    farmer.farms = farmsData.map((f: any, index: number) => {
                        const farm = new Farm();
                        farm.name = f.name;
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

                        // Replaces the old single Crop Type field: accepts a
                        // `commodities` array (see CommodityInput) per farm.
                        // Falls back to wrapping a legacy `cropType` string
                        // into an equivalent single-commodity array for any
                        // caller not yet updated to the new format.
                        let commodityInputs: CommodityInput[] = Array.isArray(f.commodities) ? f.commodities : [];
                        if (commodityInputs.length === 0 && f.cropType) {
                            commodityInputs = [{ commodityName: f.cropType, role: CommodityRole.PRIMARY, croppingSystem: CroppingSystem.MONOCROP }];
                        }
                        perFarmCommodityInputs[index] = commodityInputs;

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

                // --- GPS polygon / farm-area geometry validation ---
                // Runs on EVERY farm in this new-farmer registration BEFORE
                // anything is saved, so an invalid boundary on any one farm
                // rolls back the whole transaction (farmer + all farms)
                // rather than leaving a partially-created farmer with a bad
                // farm record. Valid-but-suspicious geometry (area mismatch,
                // overlap, etc.) is allowed through as "Needs Review".
                const geometryResultsByFarmIndex: any[] = [];
                for (let i = 0; i < (farmer.farms || []).length; i++) {
                    const f = farmer.farms[i];
                    const rawGpsAccuracy = (farmsData && farmsData[i] && farmsData[i].gpsAccuracyM !== undefined)
                        ? parseFloat(farmsData[i].gpsAccuracyM) : null;
                    const geometryResult = await validateAndAnnotateFarm(f, { gpsAccuracyM: rawGpsAccuracy });
                    assertGeometryNotBlocking(geometryResult);
                    geometryResultsByFarmIndex[i] = geometryResult;
                }

                const savedFarmer = await queryRunner.manager.save(Farmer, farmer);

                // Generate a human-readable Farmer ID + QR code (data URL) now that we have a real id
                const shortId = savedFarmer.id.split('-')[0].toUpperCase();
                savedFarmer.farmerId = `LACRA-${shortId}`;
                const publicProfileUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/public/farmers/${savedFarmer.id}`;
                savedFarmer.qrCode = await QRCode.toDataURL(publicProfileUrl);
                await queryRunner.manager.save(Farmer, savedFarmer);

                // Build the multi-commodity Plot/PlotCommodity structure for
                // each newly-created farm, now that each has a real id.
                // Kept inside the same DB transaction (queryRunner.manager)
                // as the farmer/farm rows themselves.
                for (let i = 0; i < (savedFarmer.farms || []).length; i++) {
                    const savedFarm = savedFarmer.farms[i];
                    const commodityInputs = perFarmCommodityInputs[i] || [];
                    if (commodityInputs.length === 0) continue;
                    const { plots } = await buildPlotsForFarm(savedFarm, commodityInputs);
                    for (const plot of plots) {
                        plot.farm = savedFarm;
                        plot.farmId = savedFarm.id;
                    }
                    const savedPlots = await queryRunner.manager.save(Plot, plots);
                    savedFarm.cropType = deriveLegacyCropType(savedPlots);
                    await queryRunner.manager.save(Farm, savedFarm);
                }

                // ── Mint a GeoID + farm QR for every farm registered alongside the farmer ──
                // Best-effort: GeoID failure does NOT abort farmer registration.
                // Each farm gets its own GeoID (derived from its geometry) and its own
                // farm-scan QR code (for WHIMO / trader scanning). Uses the same
                // queryRunner.manager so this still participates in the transaction's
                // save semantics even though GeoID minting itself is an external call.
                if (savedFarmer.farms && savedFarmer.farms.length > 0) {
                    const geoIdSvc = getGeoIdService();
                    for (const farm of savedFarmer.farms) {
                        try {
                            const geometry = GeoIdService.normaliseGeometry(farm.location);
                            if (geometry) {
                                const result = await geoIdSvc.mintGeoId(geometry, farm.id);
                                farm.geoId = result.geoid;
                                farm.geoIdUri = result.uri;
                                if (!farm.farmQrCode) {
                                    const scanUrl = GeoIdService.farmScanUrl(farm.id);
                                    farm.farmQrCode = await QRCode.toDataURL(scanUrl);
                                }
                                await queryRunner.manager.save(Farm, farm);
                                console.log(`[GeoID] Minted ${result.geoid} for farm ${farm.id} (farmer reg)`);
                            }
                        } catch (geoErr: any) {
                            console.warn(`[GeoID] Mint failed for farm ${farm.id} (non-fatal): ${geoErr.message}`);
                        }
                    }
                }

                await queryRunner.commitTransaction();

                return successResponse(res, { ...savedFarmer, geometryValidation: geometryResultsByFarmIndex }, "Farmer created successfully", 201);
            } catch (error: any) {
                await queryRunner.rollbackTransaction();
                console.error("Error creating farmer:", error);
                if (error.isGeometryValidationError) {
                    return errorResponse(res, error.message, [error.message], 400);
                }
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

            // Capture "before" values for every auditable contact field
            // BEFORE mutating the entity, so real changes (not just
            // resubmitted-identical values) get logged below.
            const before: Record<string, string> = {};
            for (const field of AUDITABLE_CONTACT_FIELDS) {
                before[field as string] = (farmer as any)[field] ?? "";
            }

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

            // Log every ACTUAL change to an auditable contact field. Per
            // the spec: "Allow permitted contact information to be
            // updated. Record all changes in an audit log."
            const requester = (req as any).user;
            const auditRows: FarmerAuditLog[] = [];
            for (const field of AUDITABLE_CONTACT_FIELDS) {
                const prev = before[field as string] ?? "";
                const next = (farmer as any)[field] ?? "";
                if (prev !== next) {
                    const row = new FarmerAuditLog();
                    row.farmerId = farmer.id;
                    row.action = FarmerAuditAction.CONTACT_UPDATED;
                    row.fieldName = field as string;
                    row.previousValue = prev;
                    row.newValue = next;
                    if (requester?.id) row.performedByUserId = requester.id;
                    if (requester?.name) row.performedByName = requester.name;
                    auditRows.push(row);
                }
            }
            if (auditRows.length > 0) {
                await this.auditLogRepository.save(auditRows);
            }

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
                relations: FARMER_FARM_COMMODITY_RELATIONS
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
                    farmAddress: f.farmAddress,
                    // Multi-commodity structure, so the public verification
                    // profile also shows what's actually grown on this farm.
                    plots: (f.plots || []).map(p => ({
                        name: p.name,
                        isDefault: p.isDefault,
                        areaHa: p.areaHa,
                        commodities: (p.plotCommodities || []).filter(pc => pc.isActive).map(pc => ({
                            commodityName: pc.commodityName,
                            role: pc.role,
                            croppingSystem: pc.croppingSystem,
                            plantedAreaHa: pc.plantedAreaHa,
                            productionStatus: pc.productionStatus,
                            estimatedAnnualProduction: pc.estimatedAnnualProduction,
                            unitOfMeasurement: pc.unitOfMeasurement,
                        }))
                    }))
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
            // clientRecordId is sent at the top level of the JSON body
            // (sibling to farmer/farms) — see ApiService.syncFarmerOffline()
            // on the Flutter side. It is the mobile offline queue's stable,
            // client-generated PendingSyncItem.id, unchanged across retries
            // of the same locally-created record.
            const { farmer: farmerData, farms: farmsData = [], clientRecordId } = req.body;
            if (!farmerData?.firstName || !farmerData?.lastName || !farmerData?.phoneNumber) {
                return errorResponse(res, "Farmer firstName, lastName and phoneNumber required", [], 400);
            }

            // Idempotency guard (task spec section 13: "Prevent Duplicate
            // Sync"). If this exact locally-created record was already
            // synced previously (e.g. the client's connection dropped
            // before it could see the first success response and it
            // retried), return the EXISTING farmer instead of erroring or
            // creating a second row — retries must always be safe.
            if (clientRecordId) {
                const existingByClientId = await this.farmerRepository.findOne({
                    where: { clientRecordId },
                    relations: ["farms"],
                });
                if (existingByClientId) {
                    return successResponse(
                        res,
                        { ...existingByClientId, geometryValidation: {}, rejectedFarms: [] },
                        "Farmer already synced (duplicate submission ignored)",
                        200
                    );
                }
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
            farmer.cooperativeSource = farmerData.cooperativeSource;
            farmer.enumeratorId = farmerData.enumeratorId;
            farmer.enumeratorName = farmerData.enumeratorName;
            farmer.registeredByUserId = (req as any).user?.id;
            // Undefined (not empty string) when absent, so the column's
            // `unique: true` constraint never sees multiple rows colliding
            // on '' (same reasoning as Farmer.email elsewhere in this file).
            farmer.clientRecordId = clientRecordId && String(clientRecordId).trim() !== ''
                ? clientRecordId
                : undefined as any;

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

            // Farms rejected for invalid geometry are NOT silently discarded —
            // they're reported back in the response (rejectedFarms) so the
            // offline mobile client knows which queued farm(s) need boundary
            // correction and can retry, rather than data quietly vanishing.
            const rejectedFarms: { name: string; errors: string[] }[] = [];
            const geometryResultsByFarmName: Record<string, any> = {};

            for (const f of farmsData) {
                // cropType (legacy) OR commodities (new) must identify at
                // least one initial commodity; location is always required.
                if (!f.name || !f.location || (!f.cropType && !(Array.isArray(f.commodities) && f.commodities.length))) continue;
                const farm = new Farm();
                farm.name = f.name;
                const parsedLocation = typeof f.location === "string" ? JSON.parse(f.location) : f.location;
                farm.location = parsedLocation;
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

                // GPS polygon / farm-area geometry validation — invalid
                // geometry blocks THIS farm from being created (but does not
                // fail the whole farmer sync, since farmer + other farms in
                // the same batch are independently valid/already-queued
                // offline data that shouldn't be lost over one bad boundary).
                const geometryResult = await validateAndAnnotateFarm(farm, {
                    gpsAccuracyM: f.gpsAccuracyM !== undefined ? parseFloat(f.gpsAccuracyM) : null,
                });
                if (geometryResult.blockSubmission) {
                    rejectedFarms.push({ name: f.name, errors: geometryResult.errors });
                    continue;
                }
                geometryResultsByFarmName[f.name] = geometryResult;

                const savedFarm = await this.farmRepository.save(farm);

                // Mint GeoID best-effort for offline-synced farms
                await mintGeoIdForFarm(this.farmRepository, savedFarm, "offline farmer sync");

                let commodityInputs: CommodityInput[] = Array.isArray(f.commodities) ? f.commodities : [];
                if (commodityInputs.length === 0 && f.cropType) {
                    commodityInputs = [{ commodityName: f.cropType, role: CommodityRole.PRIMARY, croppingSystem: CroppingSystem.MONOCROP }];
                }
                if (commodityInputs.length > 0) {
                    const { plots } = await buildPlotsForFarm(savedFarm, commodityInputs);
                    for (const plot of plots) {
                        plot.farm = savedFarm;
                        plot.farmId = savedFarm.id;
                    }
                    const savedPlots = await this.plotRepository.save(plots);
                    savedFarm.cropType = deriveLegacyCropType(savedPlots);
                    await this.farmRepository.save(savedFarm);
                }
            }

            return successResponse(
                res,
                { ...savedFarmer, geometryValidation: geometryResultsByFarmName, rejectedFarms },
                rejectedFarms.length > 0
                    ? `Farmer synced successfully; ${rejectedFarms.length} farm(s) rejected for invalid geometry.`
                    : "Farmer synced successfully",
                201
            );
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
