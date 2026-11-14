import { Request, Response } from "express";
import { Brackets, In } from "typeorm";
import { AppDataSource } from "../data-source";
import { Farmer } from "../entities/Farmer";
import { Farm } from "../entities/Farm";
import { Plot } from "../entities/Plot";
import { User, UserRole } from "../entities/User";
import { FarmerAuditLog, FarmerAuditAction } from "../entities/FarmerAuditLog";
import { FarmDocument } from "../entities/FarmDocument";
import { RiskAssessment } from "../entities/RiskAssessment";
import { SatelliteAlert } from "../entities/SatelliteAlert";
import { Inspection } from "../entities/Inspection";
import { Transfer } from "../entities/Transfer";
import { Batch } from "../entities/Batch";
import { OfflineSubmission } from "../entities/OfflineSubmission";
import bcrypt from 'bcryptjs';
import { successResponse, errorResponse } from "../utils/response";
import { uploadFileToCloudinary, uploadFilesToCloudinary } from "../utils/cloudUpload";
import { getGeoIdService, GeoIdService } from "../services/GeoIdService";
import { buildPlotsForFarm, deriveLegacyCropType, CommodityInput } from "../services/CommodityService";
import { CommodityRole, CroppingSystem, PlotCommodity } from "../entities/PlotCommodity";
import { validateAndAnnotateFarm, assertGeometryNotBlocking } from "../services/FarmGeometryHelper";
import { recordFarmCaptureFieldEvent } from "../services/FieldEventService";

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
// Fields that define WHO a farmer is for identity-verification purposes.
// If any of these change on a farmer whose identityStatus is currently
// "Verified", the verification no longer applies to the record as it now
// stands — identityStatus is automatically reverted to "Unverified" (see
// update() below) and an IDENTITY_REVERTED_TO_UNVERIFIED audit row is
// written, so the record goes back through review rather than silently
// keeping a stale "Verified" badge. idPhoto is included because it is the
// visual evidence verification was based on, even though it's uploaded as
// a file rather than a form field.
const IDENTITY_REVERIFICATION_FIELDS: (keyof Farmer)[] = [
    "firstName", "lastName", "dob", "nationalId", "idType", "idTypeOther", "otherId", "idPhoto",
];

const AUDITABLE_CONTACT_FIELDS: (keyof Farmer)[] = [
    "phoneNumber", "email", "address", "community", "district", "region", "directions",
];

/**
 * Best-effort GeoID mint + farm-scan QR generation for a farm that already
 * has a saved UUID. Never throws — a GeoID/network hiccup must NOT block
 * farmer/farm registration; the `/farms/backfill-geoids` endpoint can
 * recover any farm that ends up without one.
 *
 * farmQrCode encodes a GeoJSON Feature (see
 * GeoIdService.buildFarmGeoJsonFeature), always regenerated here (not only
 * when missing) since WHIMO's QR scanner reads the raw QR text as GeoJSON
 * directly — no HTTP fetch — so it must reflect this farm's current
 * geometry/GeoID whenever those could have changed.
 */
async function mintGeoIdForFarm(farmRepository: ReturnType<typeof AppDataSource.getRepository<Farm>>, farm: Farm, context: string) {
    try {
        const geometry = GeoIdService.normaliseGeometry(farm.location);
        if (geometry) {
            const geoIdSvc = getGeoIdService();
            const result = await geoIdSvc.mintGeoId(geometry, farm.id);
            farm.geoId = result.geoid;
            farm.geoIdUri = result.uri;
            const feature = GeoIdService.buildFarmGeoJsonFeature(farm);
            if (feature) {
                farm.farmQrCode = await GeoIdService.encodeGeoJsonQr(
                    feature,
                    () => GeoIdService.buildFarmGeoJsonFeatureCentroidOnly(farm) ?? feature,
                );
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
                // The farmer ID-card QR now encodes a GeoJSON FeatureCollection
                // (see GeoIdService.buildFarmerGeoJsonFeatureCollection) - its
                // root carries farmerId/profileUrl specifically so LACRA's own
                // tooling (this search endpoint) can still resolve a farmer
                // from a scan, even though WHIMO's scanner only reads the
                // geometry. Try that first; fall back to the legacy
                // "QR encodes the public-profile URL" format (and bare
                // UUID/farmerId) for any already-printed old-style card.
                let qrLookupValue = qr;
                try {
                    const parsed = JSON.parse(qr);
                    if (parsed && typeof parsed === 'object') {
                        if (typeof parsed.farmerId === 'string' && parsed.farmerId) {
                            qrLookupValue = parsed.farmerId;
                        } else if (typeof parsed.profileUrl === 'string' && parsed.profileUrl) {
                            qrLookupValue = parsed.profileUrl;
                        }
                    }
                } catch {
                    // Not JSON - treat as the legacy URL/UUID/farmerId text as before.
                }
                const idMatch = qrLookupValue.match(/farmers\/([a-f0-9-]{36})/i);
                const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                const extractedId = idMatch ? idMatch[1] : qrLookupValue;
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
                        sub.orWhere("farmer.farmerId = :qrLookupValue", { qrLookupValue });
                    } else {
                        sub.where("farmer.farmerId = :qrLookupValue", { qrLookupValue });
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
                cooperativeName, cooperativeId, cooperativeSource, enumeratorName, enumeratorId, consent,
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
                // 'CDA_REGISTRY' when the picked value came from the real CDA
                // registry dropdown, 'OTHER' for the free-text fallback -
                // mirrors how the mobile app's /auth/register-farmer path
                // already tags this (see AuthController.registerFarmer).
                // Falls back to undefined (not '') for older admin-panel
                // builds that don't send this field yet, so existing
                // behavior is unaffected.
                farmer.cooperativeSource = cooperativeSource;
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
                        // Farm's own GPS reference point, when this caller sent
                        // one (the admin-panel's web forms normally don't - see
                        // the Monitoring field-event gating comment below - but
                        // this endpoint is also reachable by any future
                        // enumerator-facing caller that does capture it, and the
                        // field should be stored either way).
                        if (f.farmLat !== undefined && f.farmLat !== null && f.farmLat !== '') {
                            farm.farmLatitude = parseFloat(f.farmLat);
                        }
                        if (f.farmLng !== undefined && f.farmLng !== null && f.farmLng !== '') {
                            farm.farmLongitude = parseFloat(f.farmLng);
                        }

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

                // Generate a human-readable Farmer ID now that we have a real id.
                // NOTE: the ID-card QR itself (savedFarmer.qrCode) is generated
                // further below, AFTER the GeoID-minting loop — it now encodes a
                // GeoJSON FeatureCollection of this farmer's farms (see
                // GeoIdService.buildFarmerGeoJsonFeatureCollection), so it must
                // wait until each farm's geoId is actually known, or every
                // Feature would be minted with geoId: null.
                const shortId = savedFarmer.id.split('-')[0].toUpperCase();
                savedFarmer.farmerId = `LACRA-${shortId}`;
                await queryRunner.manager.save(Farmer, savedFarmer);

                // Monitoring field events for this web-form create() path.
                //
                // This endpoint is used by two DESK/web flows (admin-panel
                // Register.tsx self-registration, RegisterFarmer.tsx admin
                // creation) that draw a boundary on a map rather than
                // capturing live field GPS — `registeredByUserId` here
                // therefore identifies WHO ENTERED THE RECORD, not
                // necessarily an enumerator who physically visited the
                // farm. Per the explicit Monitoring decision, a
                // FARM_RECORD_CAPTURE field event must only be created from
                // this path when ALL three are true for a given farm:
                //   1. a verified enumerator - `registeredByUserId` came
                //      from the authenticated JWT (authMiddleware already
                //      guarantees this, never a client-supplied field), AND
                //      that user actually holds the INSPECTOR role (an
                //      ADMIN entering records on someone else's behalf is
                //      NOT "the enumerator who captured this farm" and must
                //      not be attributed a field event);
                //   2. an original (client-supplied) capture time
                //      (f.gpsCapturedAt) - never defaulted to "now", since
                //      "now" is when the desk entry happened, not when any
                //      GPS reading (if any) was actually taken;
                //   3. real field GPS coordinates on that specific farm
                //      (f.farmLat/f.farmLng) - the map-drawn polygon's
                //      centroid does NOT count as a GPS reading.
                // If any of these is missing, no field event is recorded -
                // the normal farmer/farm audit trail below still captures
                // who entered the record either way, so nothing is lost.
                const enumeratorRole = (req as any).user?.role;
                const isVerifiedEnumerator = !!registeredByUserId && enumeratorRole === UserRole.INSPECTOR;
                for (let i = 0; i < (savedFarmer.farms || []).length; i++) {
                    const savedFarm = savedFarmer.farms[i];
                    const f = farmsData && farmsData[i] ? farmsData[i] : undefined;
                    if (!isVerifiedEnumerator || !f?.gpsCapturedAt) continue;
                    if (savedFarm.farmLatitude === undefined || savedFarm.farmLatitude === null) continue;
                    if (savedFarm.farmLongitude === undefined || savedFarm.farmLongitude === null) continue;
                    await recordFarmCaptureFieldEvent({
                        farmId: savedFarm.id,
                        enumeratorId: registeredByUserId,
                        latitude: savedFarm.farmLatitude,
                        longitude: savedFarm.farmLongitude,
                        gpsAccuracyM: f.gpsAccuracyM !== undefined ? parseFloat(f.gpsAccuracyM) : null,
                        capturedAt: new Date(f.gpsCapturedAt),
                    });
                }

                // Audit-history entry for every farm created through this
                // path, REGARDLESS of whether a field event was recorded
                // above — this preserves "who entered the record" (desk
                // admin or verified enumerator alike) in FarmerAuditLog even
                // when the stricter field-event criteria above aren't met,
                // per the explicit instruction to keep that action in the
                // audit history rather than silently dropping attribution.
                if (registeredByUserId && (savedFarmer.farms || []).length > 0) {
                    const creationAuditRows = savedFarmer.farms.map((savedFarm) => {
                        const row = new FarmerAuditLog();
                        row.farmerId = savedFarmer.id;
                        row.action = FarmerAuditAction.FARM_ADDED;
                        row.farmId = savedFarm.id;
                        row.performedByUserId = registeredByUserId;
                        if (requester?.name) row.performedByName = requester.name;
                        row.notes = isVerifiedEnumerator
                            ? "Farm registered via web form by enumerator"
                            : "Farm record entered via admin web form (desk entry, not a field GPS capture)";
                        return row;
                    });
                    await queryRunner.manager.save(FarmerAuditLog, creationAuditRows);
                }

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
                                const feature = GeoIdService.buildFarmGeoJsonFeature(farm);
                                if (feature) {
                                    farm.farmQrCode = await GeoIdService.encodeGeoJsonQr(
                                        feature,
                                        () => GeoIdService.buildFarmGeoJsonFeatureCentroidOnly(farm) ?? feature,
                                    );
                                }
                                await queryRunner.manager.save(Farm, farm);
                                console.log(`[GeoID] Minted ${result.geoid} for farm ${farm.id} (farmer reg)`);
                            }
                        } catch (geoErr: any) {
                            console.warn(`[GeoID] Mint failed for farm ${farm.id} (non-fatal): ${geoErr.message}`);
                        }
                    }
                }

                // Generate the farmer's ID-card QR now that every farm above
                // has had a chance to mint its GeoID — encodes a GeoJSON
                // FeatureCollection (one Feature per farm) so WHIMO's scanner
                // (raw-text GeoJSON parse, no HTTP fetch - see
                // GeoIdService.farmScanUrl's comment) finds real geometry the
                // moment the card is scanned, with farmerId/profileUrl along
                // for LACRA's own tooling. Best-effort, same as GeoID minting
                // above: a QR-render hiccup must not abort registration.
                try {
                    const publicProfileUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/public/farmers/${savedFarmer.id}`;
                    const featureCollection = GeoIdService.buildFarmerGeoJsonFeatureCollection(savedFarmer, publicProfileUrl);
                    savedFarmer.qrCode = await GeoIdService.encodeGeoJsonQr(
                        featureCollection,
                        () => GeoIdService.buildFarmerGeoJsonFeatureCollectionCentroidOnly(savedFarmer, publicProfileUrl),
                    );
                    await queryRunner.manager.save(Farmer, savedFarmer);
                } catch (qrErr: any) {
                    console.warn(`[GeoID] Farmer QR generation failed for ${savedFarmer.id} (non-fatal): ${qrErr.message}`);
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
            cooperativeName, cooperativeId, cooperativeSource,
            enumeratorName, enumeratorId,
            directions, latitude, longitude,
            consent
            // NOTE: identityStatus is intentionally NOT accepted here.
            // This endpoint (PUT /farmers/:id) is reachable by the FARMER
            // role itself (see farmer.routes.ts), so a farmer must never
            // be able to set their own verification status through it —
            // hiding the button client-side is not enough. Identity
            // verification is ONLY possible via the dedicated, ADMIN-only
            // setVerificationStatus()/bulkSetVerificationStatus() endpoints
            // below. Any identityStatus field sent in this request body is
            // silently ignored.
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

            // Same capture for the identity-reverification fields (see
            // IDENTITY_REVERIFICATION_FIELDS) — used after save to decide
            // whether a currently-"Verified" farmer must be bounced back
            // to "Unverified" because one of their identity-defining
            // fields just changed. Values are normalised through
            // String(...) so Date fields (dob) compare by calendar value,
            // not by object reference (farmer.dob = new Date(dob) always
            // creates a fresh instance, which would otherwise look like a
            // "change" even when the exact same date is resubmitted).
            const normaliseIdentityValue = (value: any): string => {
                if (value === null || value === undefined) return "";
                if (value instanceof Date) return value.toISOString();
                return String(value);
            };
            const identityBefore: Record<string, string> = {};
            for (const field of IDENTITY_REVERIFICATION_FIELDS) {
                identityBefore[field as string] = normaliseIdentityValue((farmer as any)[field]);
            }
            const wasVerifiedBeforeEdit = farmer.identityStatus === "Verified";

            // Basic identity
            farmer.firstName = firstName ?? farmer.firstName;
            farmer.lastName = lastName ?? farmer.lastName;
            // `email` has a nullable + unique DB constraint. The edit form
            // submits "" (never undefined) for farmers with no email, and
            // Postgres treats "" as a normal, comparable value for a unique
            // index (unlike NULL, which is always distinct from every other
            // NULL) — so a second farmer saving email: "" collides with any
            // existing row that already has email === "" and the update
            // fails with a 500 (duplicate key value violates unique
            // constraint). Normalise "" to null here so "no email" is
            // represented consistently and multiple farmers without an
            // email can coexist, same as nationalId/clientRecordId already
            // rely on NULL (not "") for their own unique+nullable columns.
            if (email !== undefined) farmer.email = email.trim() === "" ? null as any : email;
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
            farmer.cooperativeSource = cooperativeSource ?? farmer.cooperativeSource;
            farmer.enumeratorName = enumeratorName ?? farmer.enumeratorName;
            farmer.enumeratorId = enumeratorId ?? farmer.enumeratorId;

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

            // Identity Verification safeguard: a previously-"Verified"
            // farmer whose identity-defining details just changed can no
            // longer be trusted to still match the identity that was
            // actually verified — automatically bounce them back to
            // "Unverified" so the updated record goes through review
            // again, rather than silently keeping a stale "Verified"
            // badge. This runs regardless of who made the edit (ADMIN,
            // INSPECTOR, or the FARMER themselves via their own profile).
            let identityRevertRow: FarmerAuditLog | null = null;
            if (wasVerifiedBeforeEdit) {
                const changedIdentityFields = IDENTITY_REVERIFICATION_FIELDS.filter(
                    (field) => (identityBefore[field as string] ?? "") !== normaliseIdentityValue((farmer as any)[field])
                );
                if (changedIdentityFields.length > 0) {
                    farmer.identityStatus = "Unverified";
                    farmer.identityVerifiedAt = null;
                    farmer.identityVerifiedByUserId = null as any;
                    farmer.identityVerifiedByName = null as any;
                    farmer.identityStatusReason = `Automatically reverted to Unverified: ${changedIdentityFields.join(", ")} changed after verification.`;

                    identityRevertRow = new FarmerAuditLog();
                    identityRevertRow.farmerId = farmer.id;
                    identityRevertRow.action = FarmerAuditAction.IDENTITY_REVERTED_TO_UNVERIFIED;
                    identityRevertRow.fieldName = "identityStatus";
                    identityRevertRow.previousValue = "Verified";
                    identityRevertRow.newValue = "Unverified";
                    identityRevertRow.notes = farmer.identityStatusReason;
                }
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
            if (identityRevertRow) {
                if (requester?.id) identityRevertRow.performedByUserId = requester.id;
                if (requester?.name) identityRevertRow.performedByName = requester.name;
                auditRows.push(identityRevertRow);
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

    // =====================================================================
    // Identity Verification feature
    //
    // This verifies the farmer's IDENTITY ONLY — it says nothing about
    // whether their farm boundaries, land rights, or EUDR requirements
    // have been validated (see the Data Correction Queue / RiskAssessment
    // for those, entirely separate concerns). Kept deliberately isolated
    // from the generic update() endpoint: identityStatus can ONLY be
    // changed through setVerificationStatus()/bulkSetVerificationStatus()
    // below, both gated to ADMIN by canManageVerification() so a farmer
    // (or an inspector) can never self-verify — see routes/farmer.routes.ts.
    //
    // "Data readiness" (computeDataReadiness below) is a SEPARATE concept
    // from identityStatus: it only reflects whether the record LOOKS
    // complete enough to review (documents present, no obviously
    // conflicting signals). A fully "Ready for Review" record can still
    // turn out to belong to the wrong person — readiness is a triage aid
    // for reviewers, never a verification decision by itself.
    // =====================================================================

    /**
     * Single authorization choke point for every identity-verification
     * action (single + bulk). ADMIN-only today, per "Who can verify?
     * ADMIN-only initially." Kept as one function so introducing a
     * dedicated, more granular verification permission later (instead of
     * a full ADMIN role) is a one-line change here rather than a
     * multi-file refactor.
     */
    private canManageVerification(requester: any): boolean {
        return requester?.role === UserRole.ADMIN;
    }

    /**
     * Read-only triage signal for the Verification Queue — NOT the
     * identityStatus itself. Three buckets:
     *  - "Ready for Review": every required identity document/field is
     *    present and nothing obviously conflicting was detected. Means
     *    "an admin can review this quickly", NOT "this identity is
     *    verified".
     *  - "Missing Information": at least one required field/document is
     *    absent. `missingFields` lists exactly what, in plain language,
     *    so a reviewer (or the inspector who needs to go fix it) knows
     *    precisely what's missing.
     *  - "Potential Issue": nothing is missing, but something warrants a
     *    closer look before approving — currently: this farmer's phone
     *    number is shared with at least one other farmer record. This is
     *    surfaced as "needs review", NOT auto-flagged as a duplicate,
     *    because family members legitimately share a single phone number.
     */
    private computeDataReadiness(farmer: Farmer, phoneNumberCounts: Map<string, number>): {
        readiness: "Ready for Review" | "Missing Information" | "Potential Issue";
        missingFields: string[];
        potentialIssues: string[];
    } {
        const missingFields: string[] = [];
        if (!farmer.profilePhoto) missingFields.push("Profile photo");
        if (!farmer.idPhoto) missingFields.push("ID photo");
        if (!farmer.signature) missingFields.push("Signature");
        if (!farmer.nationalId) missingFields.push("National ID number");
        if (!farmer.phoneNumber) missingFields.push("Phone number");
        if (!farmer.consent) missingFields.push("Recorded consent");

        if (missingFields.length > 0) {
            return { readiness: "Missing Information", missingFields, potentialIssues: [] };
        }

        const potentialIssues: string[] = [];
        const sharedPhoneCount = farmer.phoneNumber ? (phoneNumberCounts.get(farmer.phoneNumber) ?? 0) : 0;
        if (sharedPhoneCount > 1) {
            potentialIssues.push(`Phone number shared with ${sharedPhoneCount - 1} other farmer record(s) — may be family members, confirm before approving.`);
        }

        if (potentialIssues.length > 0) {
            return { readiness: "Potential Issue", missingFields: [], potentialIssues };
        }

        return { readiness: "Ready for Review", missingFields: [], potentialIssues: [] };
    }

    /**
     * Verification Queue: every farmer whose identityStatus is NOT
     * "Verified" (i.e. "Unverified" or "Conflict"), annotated with the
     * data-readiness triage above so a reviewer can prioritise the
     * straightforward, complete records instead of working strictly
     * oldest-first. ADMIN + INSPECTOR can both view (read-only) so
     * inspectors can see what still needs fixing on records they
     * registered; only ADMIN can act on them (see routes).
     */
    async getVerificationQueue(req: Request, res: Response) {
        try {
            const statusFilter = (req.query.status as string) || null; // 'Unverified' | 'Conflict'
            const readinessFilter = (req.query.readiness as string) || null;

            const statuses = statusFilter ? [statusFilter] : ["Unverified", "Conflict"];
            const farmers = await this.farmerRepository
                .createQueryBuilder("farmer")
                .leftJoinAndSelect("farmer.farms", "farms")
                .where("farmer.identityStatus IN (:...statuses)", { statuses })
                .orderBy("farmer.createdAt", "ASC")
                .getMany();

            // Build phone-number frequency map across ALL farmers (not just
            // this queue) so a shared-number signal isn't missed just
            // because the other matching farmer happens to already be
            // Verified.
            const allPhoneRows = await this.farmerRepository
                .createQueryBuilder("farmer")
                .select("farmer.phoneNumber", "phoneNumber")
                .addSelect("COUNT(*)", "count")
                .where("farmer.phoneNumber IS NOT NULL")
                .groupBy("farmer.phoneNumber")
                .getRawMany();
            const phoneNumberCounts = new Map<string, number>(
                allPhoneRows.map((r: any) => [r.phoneNumber, parseInt(r.count, 10)])
            );

            let items = farmers.map((farmer) => {
                const { readiness, missingFields, potentialIssues } = this.computeDataReadiness(farmer, phoneNumberCounts);
                return {
                    id: farmer.id,
                    farmerId: farmer.farmerId,
                    firstName: farmer.firstName,
                    lastName: farmer.lastName,
                    phoneNumber: farmer.phoneNumber,
                    nationalId: farmer.nationalId,
                    profilePhoto: farmer.profilePhoto,
                    community: farmer.community,
                    district: farmer.district,
                    region: farmer.region,
                    farmCount: farmer.farms?.length ?? 0,
                    identityStatus: farmer.identityStatus,
                    identityStatusReason: farmer.identityStatusReason,
                    identityVerifiedAt: farmer.identityVerifiedAt,
                    createdAt: farmer.createdAt,
                    dataReadiness: readiness,
                    missingFields,
                    potentialIssues,
                };
            });

            if (readinessFilter) {
                items = items.filter((i) => i.dataReadiness === readinessFilter);
            }

            const summary = {
                total: items.length,
                byStatus: {
                    Unverified: items.filter((i) => i.identityStatus === "Unverified").length,
                    Conflict: items.filter((i) => i.identityStatus === "Conflict").length,
                },
                byReadiness: {
                    "Ready for Review": items.filter((i) => i.dataReadiness === "Ready for Review").length,
                    "Missing Information": items.filter((i) => i.dataReadiness === "Missing Information").length,
                    "Potential Issue": items.filter((i) => i.dataReadiness === "Potential Issue").length,
                },
            };

            return successResponse(res, { summary, farmers: items }, "Verification queue fetched successfully");
        } catch (error: any) {
            console.error("Error fetching verification queue:", error);
            return errorResponse(res, "Error fetching verification queue", [error.message], 500);
        }
    }

    /**
     * Sets a single farmer's identityStatus. ADMIN-only (see
     * canManageVerification). This is the ONLY place identityStatus may
     * be changed for a single farmer (aside from the automatic revert in
     * update() above) — never accept it from the generic update() body.
     *
     * Body: { status: 'Verified' | 'Conflict' | 'Unverified', reason?: string }
     * Reason is REQUIRED when:
     *   - status === 'Conflict' (must explain the contradictory/suspicious signal), or
     *   - reversing an existing 'Verified' status (status !== 'Verified' while farmer.identityStatus === 'Verified').
     */
    async setVerificationStatus(req: Request, res: Response) {
        try {
            const requester = (req as any).user;
            if (!this.canManageVerification(requester)) {
                return errorResponse(res, "Only an administrator can change a farmer's identity verification status", [], 403);
            }

            const { id } = req.params;
            const { status, reason } = req.body as { status?: string; reason?: string };

            if (!status || !["Verified", "Unverified", "Conflict"].includes(status)) {
                return errorResponse(res, "status must be one of: Verified, Unverified, Conflict", [], 400);
            }

            const farmer = await this.farmerRepository.findOne({ where: { id } });
            if (!farmer) return errorResponse(res, "Farmer not found", [], 404);

            const previousStatus = farmer.identityStatus;
            const isReversingVerification = previousStatus === "Verified" && status !== "Verified";

            // NOTE: `farmer` above is fetched WITHOUT relations (we only need
            // scalar columns to validate/mutate identityStatus). The response
            // sent back to the admin panel, however, replaces the entire
            // in-memory `farmer` object on the profile page (setFarmer(res.data.data)
            // in FarmerProfile.tsx), which unconditionally reads farmer.farms
            // (e.g. farmer.farms.find(...), farmer.farms.length) to render the
            // "Registered Farms" section. Returning the relation-less farmer
            // here previously caused farmer.farms to be undefined client-side,
            // crashing the whole page with "Cannot read properties of
            // undefined (reading 'find')" immediately after every successful
            // verify/flag-conflict/revert action. Re-fetch with the same
            // relations used by getOne() before responding, so the profile
            // page gets a complete farmer object and keeps rendering normally.

            if (status === "Conflict" && !reason?.trim()) {
                return errorResponse(res, "A reason is required when flagging a Conflict", [], 400);
            }
            if (isReversingVerification && !reason?.trim()) {
                return errorResponse(res, "A reason is required when reversing a farmer's Verified status", [], 400);
            }
            if (previousStatus === status) {
                return errorResponse(res, `Farmer is already ${status}`, [], 400);
            }

            farmer.identityStatus = status;
            farmer.identityStatusReason = reason?.trim() || null;
            if (status === "Verified") {
                farmer.identityVerifiedAt = new Date();
                farmer.identityVerifiedByUserId = requester.id;
                farmer.identityVerifiedByName = requester.name;
            } else {
                farmer.identityVerifiedAt = null;
                farmer.identityVerifiedByUserId = null as any;
                farmer.identityVerifiedByName = null as any;
            }
            await this.farmerRepository.save(farmer);

            const action =
                status === "Verified" ? FarmerAuditAction.IDENTITY_VERIFIED :
                status === "Conflict" ? FarmerAuditAction.IDENTITY_CONFLICT_FLAGGED :
                FarmerAuditAction.IDENTITY_REVERTED_TO_UNVERIFIED;

            const row = new FarmerAuditLog();
            row.farmerId = farmer.id;
            row.action = action;
            row.fieldName = "identityStatus";
            row.previousValue = previousStatus;
            row.newValue = status;
            row.notes = (reason?.trim() || null) as any;
            row.performedByUserId = requester.id;
            row.performedByName = requester.name;
            await this.auditLogRepository.save(row);

            // Re-fetch with the full relation set (see note above) so the
            // admin panel's FarmerProfile page receives a complete farmer
            // object, matching what getOne() returns, instead of a
            // relation-less entity that crashes farmer.farms.find()/.map().
            const farmerWithRelations = await this.farmerRepository.findOne({
                where: { id: farmer.id },
                relations: FARMER_FARM_COMMODITY_RELATIONS
            });

            return successResponse(res, farmerWithRelations ?? farmer, `Farmer identity status set to ${status}`);
        } catch (error: any) {
            console.error("Error setting farmer verification status:", error);
            return errorResponse(res, "Error setting farmer verification status", [error.message], 500);
        }
    }

    /**
     * Bulk verification: requires an explicit list of farmerIds (no
     * "verify everyone currently filtered" implicit selection) per "Bulk
     * verification should require explicit selection". Every selected
     * record's eligibility and the requester's permission are checked
     * individually server-side — the client-shown "confirmation summary"
     * is a UX convenience only, never trusted as authorization. One
     * audit-log row is created per farmer actually changed.
     *
     * Body: { farmerIds: string[], status: 'Verified' | 'Conflict', reason?: string }
     * Only 'Verified' and 'Conflict' are supported in bulk (reverting to
     * Unverified is a single-farmer, always-reasoned action via
     * setVerificationStatus — not something to do in bulk).
     * `reason` is REQUIRED when status === 'Conflict', applied identically
     * to every selected farmer in this batch.
     */
    async bulkSetVerificationStatus(req: Request, res: Response) {
        try {
            const requester = (req as any).user;
            if (!this.canManageVerification(requester)) {
                return errorResponse(res, "Only an administrator can change a farmer's identity verification status", [], 403);
            }

            const { farmerIds, status, reason } = req.body as { farmerIds?: string[]; status?: string; reason?: string };

            if (!Array.isArray(farmerIds) || farmerIds.length === 0) {
                return errorResponse(res, "farmerIds must be a non-empty array — bulk verification requires explicit selection", [], 400);
            }
            if (!status || !["Verified", "Conflict"].includes(status)) {
                return errorResponse(res, "status must be one of: Verified, Conflict for bulk actions", [], 400);
            }
            if (status === "Conflict" && !reason?.trim()) {
                return errorResponse(res, "A reason is required when flagging Conflict in bulk", [], 400);
            }

            const farmers = await this.farmerRepository.find({ where: { id: In(farmerIds) } });
            const foundIds = new Set(farmers.map((f) => f.id));

            const results: { farmerId: string; success: boolean; message: string }[] = [];
            const auditRows: FarmerAuditLog[] = [];
            const toSave: Farmer[] = [];

            for (const requestedId of farmerIds) {
                const farmer = farmers.find((f) => f.id === requestedId);
                if (!farmer) {
                    results.push({ farmerId: requestedId, success: false, message: "Farmer not found" });
                    continue;
                }
                if (farmer.identityStatus === status) {
                    results.push({ farmerId: requestedId, success: false, message: `Already ${status}` });
                    continue;
                }

                const previousStatus = farmer.identityStatus;
                farmer.identityStatus = status;
                farmer.identityStatusReason = reason?.trim() || null;
                if (status === "Verified") {
                    farmer.identityVerifiedAt = new Date();
                    farmer.identityVerifiedByUserId = requester.id;
                    farmer.identityVerifiedByName = requester.name;
                }
                toSave.push(farmer);

                const row = new FarmerAuditLog();
                row.farmerId = farmer.id;
                row.action = status === "Verified" ? FarmerAuditAction.IDENTITY_VERIFIED : FarmerAuditAction.IDENTITY_CONFLICT_FLAGGED;
                row.fieldName = "identityStatus";
                row.previousValue = previousStatus;
                row.newValue = status;
                row.notes = (reason?.trim() || null) as any;
                row.performedByUserId = requester.id;
                row.performedByName = requester.name;
                auditRows.push(row);

                results.push({ farmerId: requestedId, success: true, message: `Set to ${status}` });
            }

            if (toSave.length > 0) await this.farmerRepository.save(toSave);
            if (auditRows.length > 0) await this.auditLogRepository.save(auditRows);

            const unknownIds = farmerIds.filter((fid) => !foundIds.has(fid));
            for (const unknownId of unknownIds) {
                if (!results.find((r) => r.farmerId === unknownId)) {
                    results.push({ farmerId: unknownId, success: false, message: "Farmer not found" });
                }
            }

            const successCount = results.filter((r) => r.success).length;
            return successResponse(
                res,
                { successCount, failureCount: results.length - successCount, results },
                `${successCount} of ${farmerIds.length} farmer(s) set to ${status}`
            );
        } catch (error: any) {
            console.error("Error in bulk verification status update:", error);
            return errorResponse(res, "Error in bulk verification status update", [error.message], 500);
        }
    }

    /**
     * Permanently deletes a single farmer and every record that belongs to
     * them — their farm(s), plots/plot-commodities (cascade via DB-level
     * FK constraints), farm documents, risk assessments, satellite alerts,
     * farmer audit log, and their own FARMER-role login account (if any).
     * Dependent records that are NOT owned by the farmer (Inspection,
     * Transfer, Batch) are cleaned up WITHOUT being destroyed themselves:
     * - Inspection.farmId is nulled (the inspection record itself is kept
     *   as its own auditable history, same as the global reset endpoint).
     * - Transfer rows that reference this farmer or one of their
     *   farms/plots/plot-commodities as the SOURCE are deleted (the
     *   transfer record only has meaning in relation to that source).
     * - This farmer is removed from any Batch.farmers many-to-many link
     *   (the batch itself is preserved).
     * - Any OfflineSubmission shadow record already synced to this farmer
     *   is deleted (it's pure historical clutter once the real farmer is
     *   gone and is not FK-constrained to it anyway).
     *
     * This is a single admin-only, transactional, irreversible operation
     * scoped to ONE farmerId — modelled directly on
     * AdminMaintenanceController.resetFarmerFarmData()'s proven cascade
     * pattern, but scoped down instead of wiping every farmer.
     */
    async delete(req: Request, res: Response) {
        const { id } = req.params;

        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const manager = queryRunner.manager;

            const farmer = await manager.findOne(Farmer, {
                where: { id },
                relations: ["farms"],
            });
            if (!farmer) {
                await queryRunner.rollbackTransaction();
                return errorResponse(res, "Farmer not found", [], 404);
            }

            const farmIds = (farmer.farms || []).map((f) => f.id);
            const farmsDeleted = farmIds.length;

            if (farmIds.length > 0) {
                // 1. Records that reference this farmer's Farm(s) directly
                // (Plot/PlotCommodity cascade automatically via DB-level
                // onDelete: "CASCADE" once the Farm rows are deleted below).
                await manager
                    .createQueryBuilder()
                    .delete()
                    .from(FarmDocument)
                    .where("farmId IN (:...farmIds)", { farmIds })
                    .execute();

                await manager
                    .createQueryBuilder()
                    .delete()
                    .from(RiskAssessment)
                    .where("farmId IN (:...farmIds)", { farmIds })
                    .execute();

                await manager
                    .createQueryBuilder()
                    .delete()
                    .from(SatelliteAlert)
                    .where("farmId IN (:...farmIds)", { farmIds })
                    .execute();

                // Inspection.farm is nullable — clear the link rather than
                // deleting the inspection record itself (an inspection is
                // its own auditable record, not owned by the farm).
                await manager
                    .createQueryBuilder()
                    .update(Inspection)
                    .set({ farm: undefined as any })
                    .where("farmId IN (:...farmIds)", { farmIds })
                    .execute();

                // Collect this farmer's plot/plot-commodity ids BEFORE the
                // farms (and their cascaded plots) are deleted, so Transfer
                // rows sourced from them can be cleaned up too.
                const plots = await manager.find(Plot, { where: { farmId: In(farmIds) } });
                const plotIds = plots.map((p) => p.id);
                const plotCommodities = plotIds.length > 0
                    ? await manager.find(PlotCommodity, { where: { plotId: In(plotIds) } })
                    : [];
                const plotCommodityIds = plotCommodities.map((pc) => pc.id);

                const transferDeleteQb = manager
                    .createQueryBuilder()
                    .delete()
                    .from(Transfer)
                    .where("fromFarmerId = :farmerId", { farmerId: id })
                    .orWhere("sourceFarmId IN (:...farmIds)", { farmIds });
                if (plotIds.length > 0) {
                    transferDeleteQb.orWhere("sourcePlotId IN (:...plotIds)", { plotIds });
                }
                if (plotCommodityIds.length > 0) {
                    transferDeleteQb.orWhere("sourcePlotCommodityId IN (:...plotCommodityIds)", { plotCommodityIds });
                }
                await transferDeleteQb.execute();
            } else {
                // No farms, but the farmer could still be directly
                // referenced as a Transfer source.
                await manager
                    .createQueryBuilder()
                    .delete()
                    .from(Transfer)
                    .where("fromFarmerId = :farmerId", { farmerId: id })
                    .execute();
            }

            // Remove this farmer from any Batch <-> Farmer many-to-many
            // link, without deleting the batch itself.
            const batches = await manager
                .createQueryBuilder(Batch, "batch")
                .innerJoin("batch.farmers", "farmer", "farmer.id = :farmerId", { farmerId: id })
                .getMany();
            for (const batchId of batches.map((b) => b.id)) {
                const batch = await manager.findOne(Batch, { where: { id: batchId }, relations: ["farmers"] });
                if (batch) {
                    batch.farmers = (batch.farmers || []).filter((f) => f.id !== id);
                    await manager.save(Batch, batch);
                }
            }

            // Pure historical clutter once the real farmer is gone — not
            // FK-constrained (syncedFarmerId is a plain string column).
            await manager
                .createQueryBuilder()
                .delete()
                .from(OfflineSubmission)
                .where("syncedFarmerId = :farmerId", { farmerId: id })
                .execute();

            // Delete the farmer's farm(s) — Plot/PlotCommodity cascade
            // automatically via DB-level onDelete: "CASCADE".
            if (farmIds.length > 0) {
                await manager
                    .createQueryBuilder()
                    .delete()
                    .from(Farm)
                    .where("id IN (:...farmIds)", { farmIds })
                    .execute();
            }

            // FarmerAuditLog cascades automatically via DB-level
            // onDelete: "CASCADE" on Farmer, but delete explicitly first
            // for clarity/defensiveness regardless of constraint timing.
            await manager
                .createQueryBuilder()
                .delete()
                .from(FarmerAuditLog)
                .where("farmerId = :farmerId", { farmerId: id })
                .execute();

            // Capture the linked User id BEFORE deleting the farmer (the FK
            // from Farmer -> User is on the Farmer side via userId).
            const linkedUserId = farmer.userId;

            await manager
                .createQueryBuilder()
                .delete()
                .from(Farmer)
                .where("id = :id", { id })
                .execute();

            // Delete the farmer's own FARMER-role login account (never
            // touches ADMIN/INSPECTOR/BUYER/EXPORTER accounts).
            let userAccountDeleted = false;
            if (linkedUserId) {
                const result = await manager
                    .createQueryBuilder()
                    .delete()
                    .from(User)
                    .where("id = :userId", { userId: linkedUserId })
                    .andWhere("role = :role", { role: UserRole.FARMER })
                    .execute();
                userAccountDeleted = (result.affected || 0) > 0;
            }

            await queryRunner.commitTransaction();

            return successResponse(
                res,
                { deleted: true, farmsDeleted, userAccountDeleted },
                "Farmer deleted successfully"
            );
        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            console.error("Error deleting farmer:", error);
            return errorResponse(res, "Error deleting farmer — no changes were made", [error.message], 500);
        } finally {
            await queryRunner.release();
        }
    }

    /**
     * GET /api/public/farmers/:id — the endpoint every farmer QR code
     * (printed on the farmer's physical ID card) resolves to. Reachable by
     * anyone who scans a card/QR, with NO authentication required
     * (optionalAuthMiddleware on the route — see public.routes.ts), so this
     * must never return sensitive PII unless the caller presents a valid
     * staff JWT.
     *
     * Two response shapes, selected by whether `req.user` was populated:
     *
     *  - ANONYMOUS (no token / invalid-expired token) — e.g. WHIMO or LACRA
     *    Trace scanning the farmer's card in the field: "geo" view only.
     *    Per the FAO OpenForis GeoID spec (https://www.openforis.org/geoid/),
     *    GeoID converts a plot's location geometry into a fixed-size,
     *    anonymous, attribute-less identifier so a plot's identity can be
     *    exchanged along the traceability chain WITHOUT exposing the raw
     *    geolocation or the farmer's PII. WHIMO/LACRA Trace only ever need
     *    GeoID + geometry here (same geo-only shape already used by
     *    FarmScanController's farm-QR scan — kept consistent on purpose),
     *    never the farmer's name, photo, contact details, or any other
     *    identity attribute.
     *
     *  - AUTHENTICATED STAFF (ADMIN / INSPECTOR / BUYER / EXPORTER token) —
     *    i.e. LACRA's own Farm Mapping Tools app/admin panel scanning the
     *    SAME card: full profile, unchanged from the previous behaviour —
     *    same shape already relied on by FarmerProfile.tsx / ExportController,
     *    so no internal workflow breaks.
     *
     * Route is also wrapped in generalPublicLimiter (rate limiting) — see
     * public.routes.ts — as a second layer of abuse protection regardless
     * of auth status.
     */
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

            const requester = (req as any).user;
            const isAuthorizedStaff = !!requester && [
                UserRole.ADMIN,
                UserRole.INSPECTOR,
                UserRole.BUYER,
                UserRole.EXPORTER,
            ].includes(requester.role);

            if (!isAuthorizedStaff) {
                // ── ANONYMOUS / GEO-ONLY VIEW (WHIMO / LACRA Trace / any
                // external scanner) ───────────────────────────────────────────
                // Zero farmer PII — no name, no photo, no contact info, no
                // identity-document data. Only each registered farm's GeoID
                // (an anonymous, geometry-derived identifier — see GeoIdService)
                // plus the geometry/compliance attributes WHIMO/LACRA Trace
                // actually need to pre-fill a transaction's location, mirroring
                // FarmScanController.scan()'s geo payload field-for-field so
                // downstream integrations only need to understand one shape.
                //
                // `farmerId` (the human-readable "LACRA-XXXXXXXX" code) is kept
                // because it is already printed in plaintext on the physical
                // card itself — it is a reference code, not PII, and lets an
                // external system correlate the scan back to the printed card
                // without exposing anything private.
                const geoData = {
                    id: farmer.id,
                    farmerId: farmer.farmerId,
                    farms: farmer.farms.map(f => {
                        const geometry = GeoIdService.normaliseGeometry(f.location);
                        const centroid = geometry ? GeoIdService.centroidFromGeometry(geometry) : null;
                        return {
                            farmId: f.id,
                            geoId: f.geoId ?? null,
                            geoIdUri: f.geoIdUri ?? null,
                            // Centroid + full polygon are part of what GeoID
                            // resolves to (same as FarmScanController) — the
                            // anonymity GeoID provides is over the farmer's
                            // IDENTITY, not the geometry itself, which is what
                            // WHIMO/Whisp need for the compliance/traceability
                            // chain.
                            centroid: centroid ? { lat: centroid.lat, lng: centroid.lng } : null,
                            geojson: geometry
                                ? {
                                    type: "Feature",
                                    id: f.geoId ?? f.id,
                                    geometry,
                                    properties: {
                                        farmId: f.id,
                                        geoId: f.geoId ?? null,
                                        cropType: f.cropType,
                                        totalAreaHa: f.totalAreaHa ?? null,
                                        riskLevel: f.riskLevel,
                                    },
                                }
                                : null,
                            cropType: f.cropType,
                            totalAreaHa: f.totalAreaHa ?? null,
                            riskLevel: f.riskLevel,
                            farmRegistrationStatus: f.farmRegistrationStatus ?? null,
                        };
                    }),
                    _access: "geo", // lets the frontend distinguish the two shapes without guessing from field presence
                };
                return successResponse(res, geoData);
            }

            // ── AUTHENTICATED STAFF / FULL VIEW (unchanged) ──────────────────
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
                    })),
                })),
                _access: "full",
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
                    // Recovery pass: the farmer+farms were already saved on
                    // a previous attempt, but this retry gives us another
                    // chance to write any FieldEvent that failed to record
                    // last time (e.g. a crash between the farm save and the
                    // event write). recordFarmCaptureFieldEvent's eventId is
                    // derived from the farm's own (already-persisted,
                    // unchanged) id, so this is always safe to re-attempt —
                    // if the event already exists, the insert is a no-op; if
                    // it's missing, this is what recovers it.
                    for (const savedFarm of existingByClientId.farms || []) {
                        const match = (farmsData || []).find((f: any) => f.name === savedFarm.name);
                        if (!match) continue;
                        await recordFarmCaptureFieldEvent({
                            farmId: savedFarm.id,
                            enumeratorId: existingByClientId.registeredByUserId,
                            latitude: savedFarm.farmLatitude,
                            longitude: savedFarm.farmLongitude,
                            gpsAccuracyM: match.gpsAccuracyM !== undefined ? parseFloat(match.gpsAccuracyM) : null,
                            capturedAt: match.gpsCapturedAt ? new Date(match.gpsCapturedAt) : undefined,
                        });
                    }
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
            farmer.countyOfOrigin = farmerData.countyOfOrigin;
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

            // Generate human-readable Farmer ID now that we have a real id. The
            // farmer's ID-card QR (savedFarmer.qrCode) is intentionally NOT
            // generated here - it's generated further below, after every farm in
            // this offline-sync batch has had a chance to mint its GeoID via
            // mintGeoIdForFarm(), so the embedded GeoJSON FeatureCollection's
            // Features carry real geoId values instead of null.
            const shortId = savedFarmer.id.split('-')[0].toUpperCase();
            savedFarmer.farmerId = `LACRA-${shortId}`;
            await this.farmerRepository.save(savedFarmer);

            // Farms rejected for invalid geometry are NOT silently discarded —
            // they're reported back in the response (rejectedFarms) so the
            // offline mobile client knows which queued farm(s) need boundary
            // correction and can retry, rather than data quietly vanishing.
            const rejectedFarms: { name: string; errors: string[] }[] = [];
            const geometryResultsByFarmName: Record<string, any> = {};
            // Saved farms from this batch, used below to rebuild the farmer's
            // ID-card QR (GeoJSON FeatureCollection) once every farm has had a
            // chance to mint its GeoID via mintGeoIdForFarm().
            const createdFarms: Farm[] = [];

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
                // Farm's own GPS reference point (see AuthController.registerFarmer
                // for the live-path equivalent) - kept consistent across both
                // the live and offline-queue-replay sync paths.
                if (f.farmLat !== undefined && f.farmLat !== null && f.farmLat !== '') {
                    farm.farmLatitude = parseFloat(f.farmLat);
                }
                if (f.farmLng !== undefined && f.farmLng !== null && f.farmLng !== '') {
                    farm.farmLongitude = parseFloat(f.farmLng);
                }
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
                createdFarms.push(savedFarm);

                // Monitoring: "Last reported location" - GPS captured at
                // farm record capture, for the mobile app's offline
                // farmer+farm sync path. Uses the farm's own capturedAt (if
                // the client sent one) so a delayed upload cannot look more
                // recent than it actually was.
                await recordFarmCaptureFieldEvent({
                    farmId: savedFarm.id,
                    enumeratorId: farmer.registeredByUserId,
                    latitude: savedFarm.farmLatitude,
                    longitude: savedFarm.farmLongitude,
                    gpsAccuracyM: f.gpsAccuracyM !== undefined ? parseFloat(f.gpsAccuracyM) : null,
                    capturedAt: f.gpsCapturedAt ? new Date(f.gpsCapturedAt) : undefined,
                });

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

            // Generate the farmer's ID-card QR now that every farm in this batch
            // has had a chance to mint its GeoID (via mintGeoIdForFarm above) -
            // encodes a GeoJSON FeatureCollection (one Feature per farm), same
            // reasoning as FarmerController.create() and AuthController.registerFarmer.
            // Best-effort: a QR-render hiccup must not fail the whole sync.
            try {
                const publicProfileUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/public/farmers/${savedFarmer.id}`;
                const featureCollection = GeoIdService.buildFarmerGeoJsonFeatureCollection(
                    { id: savedFarmer.id, farmerId: savedFarmer.farmerId, farms: createdFarms },
                    publicProfileUrl,
                );
                savedFarmer.qrCode = await GeoIdService.encodeGeoJsonQr(
                    featureCollection,
                    () => GeoIdService.buildFarmerGeoJsonFeatureCollectionCentroidOnly(
                        { id: savedFarmer.id, farmerId: savedFarmer.farmerId, farms: createdFarms },
                        publicProfileUrl,
                    ),
                );
                await this.farmerRepository.save(savedFarmer);
            } catch (qrErr: any) {
                console.warn(`[GeoID] Farmer QR generation failed for ${savedFarmer.id} (non-fatal): ${qrErr.message}`);
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
                    // GeoJSON FeatureCollection QR (same format as every other
                    // registration path) - load this farmer's farms since the
                    // query above doesn't eagerly fetch them.
                    const withFarms = await this.farmerRepository.findOne({
                        where: { id: farmer.id },
                        relations: ["farms"],
                    });
                    const publicProfileUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/public/farmers/${farmer.id}`;
                    const featureCollection = GeoIdService.buildFarmerGeoJsonFeatureCollection(
                        { id: farmer.id, farmerId: farmer.farmerId, farms: withFarms?.farms || [] },
                        publicProfileUrl,
                    );
                    farmer.qrCode = await GeoIdService.encodeGeoJsonQr(
                        featureCollection,
                        () => GeoIdService.buildFarmerGeoJsonFeatureCollectionCentroidOnly(
                            { id: farmer.id, farmerId: farmer.farmerId, farms: withFarms?.farms || [] },
                            publicProfileUrl,
                        ),
                    );
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

    /**
     * One-time maintenance endpoint: UNCONDITIONALLY regenerates every farmer's
     * ID-card QR code (farmer.qrCode) and every one of their farms' QR codes
     * (farm.farmQrCode) as GeoJSON (Feature / FeatureCollection - see
     * GeoIdService), replacing any stale URL-only QR that was generated before
     * this format existed. Unlike backfillFarmerIds() above (which only fills
     * in a MISSING qrCode), this endpoint always overwrites, since a farmer
     * registered before this rework already has a non-null but WRONG-FORMAT
     * qrCode that would otherwise never be touched again.
     *
     * Safe to call repeatedly - every run produces the same content for
     * unchanged data (GeoID minting is content-addressed/idempotent, and QR
     * rendering is deterministic for the same input).
     *
     * This does NOT mint missing GeoIDs itself - run POST /farms/backfill-geoids
     * first so every farm's geoId is populated before regenerating QRs here,
     * otherwise farms without a geoId will still get a QR, just with
     * properties.geoId: null.
     */
    async regenerateQrCodes(req: Request, res: Response) {
        try {
            const farmers = await this.farmerRepository.find({ relations: ["farms"] });

            let farmersUpdated = 0;
            let farmsUpdated = 0;
            let farmsSkippedNoGeometry = 0;
            const errors: string[] = [];

            for (const farmer of farmers) {
                try {
                    // Regenerate each of this farmer's farm QRs first, so the
                    // FeatureCollection built right after reflects their
                    // current (possibly just-updated) farmQrCode/geoId.
                    for (const farm of farmer.farms || []) {
                        const geometry = GeoIdService.normaliseGeometry(farm.location);
                        if (!geometry) {
                            farmsSkippedNoGeometry++;
                            continue;
                        }
                        const feature = GeoIdService.buildFarmGeoJsonFeature(farm);
                        if (feature) {
                            farm.farmQrCode = await GeoIdService.encodeGeoJsonQr(
                                feature,
                                () => GeoIdService.buildFarmGeoJsonFeatureCentroidOnly(farm) ?? feature,
                            );
                            await this.farmRepository.save(farm);
                            farmsUpdated++;
                        }
                    }

                    const publicProfileUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/public/farmers/${farmer.id}`;
                    const featureCollection = GeoIdService.buildFarmerGeoJsonFeatureCollection(
                        { id: farmer.id, farmerId: farmer.farmerId, farms: farmer.farms || [] },
                        publicProfileUrl,
                    );
                    farmer.qrCode = await GeoIdService.encodeGeoJsonQr(
                        featureCollection,
                        () => GeoIdService.buildFarmerGeoJsonFeatureCollectionCentroidOnly(
                            { id: farmer.id, farmerId: farmer.farmerId, farms: farmer.farms || [] },
                            publicProfileUrl,
                        ),
                    );
                    await this.farmerRepository.save(farmer);
                    farmersUpdated++;
                } catch (err: any) {
                    const msg = err?.message ?? String(err);
                    errors.push(`Farmer ${farmer.id}: ${msg}`);
                    console.warn(`[QR regen] Failed for farmer ${farmer.id} (non-fatal): ${msg}`);
                }
            }

            return successResponse(
                res,
                {
                    totalFarmers: farmers.length,
                    farmersUpdated,
                    farmsUpdated,
                    farmsSkippedNoGeometry,
                    errors: errors.length > 0 ? errors : undefined,
                },
                `Regenerated ${farmersUpdated} farmer QR(s) and ${farmsUpdated} farm QR(s)`
            );
        } catch (error: any) {
            console.error("Error regenerating QR codes:", error);
            return errorResponse(res, "Error regenerating QR codes", [error.message], 500);
        }
    }
}
