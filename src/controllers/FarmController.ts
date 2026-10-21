import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Farm } from "../entities/Farm";
import { Plot } from "../entities/Plot";
import { PlotCommodity } from "../entities/PlotCommodity";
import { UserRole } from "../entities/User";
import { FarmerAuditLog, FarmerAuditAction } from "../entities/FarmerAuditLog";
import { successResponse, errorResponse } from "../utils/response";
import { uploadFilesToCloudinary, uploadFileToCloudinary } from "../utils/cloudUpload";
import { getGeoIdService, GeoIdService } from "../services/GeoIdService";
import QRCode from "qrcode";
import {
    buildPlotsForFarm,
    resolveCommodity,
    refreshFarmPlotsAndLegacyCropType,
    computeAreaWarning,
    CommodityInput,
} from "../services/CommodityService";
import { CroppingSystem, CommodityRole, ProductionStatus } from "../entities/PlotCommodity";
import { validateAndAnnotateFarm, assertGeometryNotBlocking } from "../services/FarmGeometryHelper";

// Relations needed whenever a Farm response should include its full
// multi-commodity structure (Plot -> PlotCommodity -> Commodity).
const FARM_COMMODITY_RELATIONS = ["farmer", "plots", "plots.plotCommodities", "plots.plotCommodities.commodity"];

/**
 * Parses the "commodities" field from a farm create/update payload. Sent
 * as a JSON string over multipart/form-data (same convention as
 * `boundaryGeoJson` elsewhere), or may already be a real array on a plain
 * JSON request (e.g. offline-sync).
 */
function parseCommodities(raw: any): CommodityInput[] {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            console.error("Error parsing commodities JSON", e);
            return [];
        }
    }
    return [];
}

/**
 * Best-effort GeoID mint + farm-scan QR generation for a farm that already
 * has a saved UUID. Never throws — a GeoID/network hiccup must NOT block
 * farm creation/sync; the `/farms/backfill-geoids` endpoint can recover
 * any farm that ends up without one. Mutates and persists `farm` in place.
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

export class FarmController {
    private farmRepository = AppDataSource.getRepository(Farm);
    private plotRepository = AppDataSource.getRepository(Plot);
    private plotCommodityRepository = AppDataSource.getRepository(PlotCommodity);
    private auditLogRepository = AppDataSource.getRepository(FarmerAuditLog);

    async getAll(req: Request, res: Response) {
        try {
            const user = (req as any).user;

            if (user && user.role === UserRole.FARMER) {
                // Find Farmer profile linked to this user
                const farmerRepository = AppDataSource.getRepository("Farmer");
                const farmer = await farmerRepository.findOne({ where: { user: { id: user.id } } });

                if (!farmer) return successResponse(res, []);

                const farms = await this.farmRepository.find({
                    where: { farmer: { id: farmer.id } },
                    relations: FARM_COMMODITY_RELATIONS,
                    order: { name: "ASC" }
                });
                return successResponse(res, farms);
            }

            // Access rule (same per-enumerator visibility scoping already
            // used by FarmerController.getAll(), kept consistent so the
            // Farm Registry and Farmers list always agree on what a given
            // inspector can see):
            // - ADMIN sees every farm, no restrictions.
            // - INSPECTOR sees only (a) farms belonging to a farmer THEY
            //   personally registered (farmer.registeredByUserId matches
            //   their own user id), plus (b) farms whose farmer is
            //   "legacy" (registeredByUserId IS NULL), so no
            //   previously-visible data disappears for anyone. Before
            //   this fix, every INSPECTOR saw every farm from every
            //   enumerator here with zero filtering, even though the
            //   Farmers list was already correctly scoped — this closes
            //   that gap so the two lists behave consistently.
            // - BUYER unaffected for now (out of scope of this fix, same
            //   as the farmers-side scoping).
            let farms: Farm[];
            if (user && user.role === UserRole.INSPECTOR) {
                farms = await this.farmRepository
                    .createQueryBuilder("farm")
                    .leftJoinAndSelect("farm.farmer", "farmer")
                    .leftJoinAndSelect("farm.plots", "plots")
                    .leftJoinAndSelect("plots.plotCommodities", "plotCommodities")
                    .leftJoinAndSelect("plotCommodities.commodity", "commodity")
                    .where("farmer.registeredByUserId = :userId", { userId: user.id })
                    .orWhere("farmer.registeredByUserId IS NULL")
                    .orderBy("farm.name", "ASC")
                    .getMany();
            } else {
                farms = await this.farmRepository.find({
                    relations: FARM_COMMODITY_RELATIONS,
                    order: { name: "ASC" }
                });
            }

            return successResponse(res, farms);
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error fetching farms", [error.message], 500);
        }
    }

    async getOne(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const farm = await this.farmRepository.findOne({
                where: { id },
                relations: FARM_COMMODITY_RELATIONS
            });
            if (!farm) return errorResponse(res, "Farm not found", [], 404);
            return successResponse(res, farm);
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error fetching farm", [error.message], 500);
        }
    }

    async create(req: Request, res: Response) {
        try {
            const user = (req as any).user;
            if (!user) return errorResponse(res, "Unauthorized", [], 401);

            const {
                name, cropType, lat, lng, farmerId, location, totalAreaHa,
                ownershipType, farmRegistrationStatus, numberOfTrees, yearsInCultivation,
                harvestSeason, averageYield, buyers, useChemicals, extensionServices,
                farmAddress, manualSizeInput, manualSizeUnit, farmNotes, ownershipDocument,
                commodities, gpsAccuracyM,
            } = req.body;
            let farmer = null;

            const farmerRepository = AppDataSource.getRepository("Farmer");

            if (user.role === UserRole.ADMIN || user.role === UserRole.INSPECTOR) {
                if (farmerId) {
                    farmer = await farmerRepository.findOne({ where: { id: farmerId } });
                    if (!farmer) return errorResponse(res, "Specified farmer not found", [], 404);
                } else {
                    return errorResponse(res, "Admin must specify farmerId", [], 400);
                }
            } else {
                // Regular Farmer user
                farmer = await farmerRepository.findOne({ where: { user: { id: user.id } } });
                if (!farmer) {
                    return errorResponse(res, "Farmer profile not found for this user", [], 404);
                }
            }

            // Duplication prevention: same farmer cannot have two farms with same name
            const existingFarm = await this.farmRepository.findOne({
                where: { farmer: { id: (farmer as any).id }, name }
            });
            if (existingFarm) {
                return errorResponse(res, `Farm with name "${name}" already exists for this farmer`, [], 400);
            }

            const farm = new Farm();
            farm.name = name;
            farm.farmer = farmer as any;

            // Prefer a real field-mapped polygon boundary (GeoJSON) if one was submitted.
            // Only fall back to a synthetic square around a single point when no real
            // boundary is available (e.g. legacy single-pin flow).
            if (location) {
                const parsedLocation = typeof location === "string" ? JSON.parse(location) : location;
                farm.location = parsedLocation;
            } else if (lat !== undefined && lng !== undefined) {
                const latNum = parseFloat(lat);
                const lngNum = parseFloat(lng);
                farm.location = {
                    type: "Polygon",
                    coordinates: [[
                        [lngNum - 0.001, latNum - 0.001],
                        [lngNum + 0.001, latNum - 0.001],
                        [lngNum + 0.001, latNum + 0.001],
                        [lngNum - 0.001, latNum + 0.001],
                        [lngNum - 0.001, latNum - 0.001]
                    ]]
                };
            } else {
                return errorResponse(res, "Either a GeoJSON 'location' polygon or lat/lng is required", [], 400);
            }

            if (totalAreaHa) {
                farm.totalAreaHa = parseFloat(totalAreaHa);
            }

            // Full farm-detail field set — matches what FarmerController.create()'s
            // farmsData[] mapping already supports, so a farm added to an EXISTING
            // farmer via this endpoint captures the same richness as a farm created
            // as part of brand-new farmer registration.
            if (ownershipType !== undefined) farm.ownershipType = ownershipType;
            if (ownershipDocument !== undefined) farm.ownershipDocument = ownershipDocument;
            if (farmRegistrationStatus !== undefined) farm.farmRegistrationStatus = farmRegistrationStatus;
            if (numberOfTrees !== undefined && numberOfTrees !== "") farm.numberOfTrees = parseInt(numberOfTrees);
            if (yearsInCultivation !== undefined && yearsInCultivation !== "") farm.yearsInCultivation = parseInt(yearsInCultivation);
            if (harvestSeason !== undefined) farm.harvestSeason = harvestSeason;
            if (averageYield !== undefined) farm.averageYield = averageYield;
            if (buyers !== undefined) farm.buyers = buyers;
            if (useChemicals !== undefined) farm.useChemicals = useChemicals === true || useChemicals === "true";
            if (extensionServices !== undefined) farm.extensionServices = extensionServices === true || extensionServices === "true";
            if (farmAddress !== undefined) farm.farmAddress = farmAddress;
            if (farmNotes !== undefined) farm.farmNotes = farmNotes;
            if (manualSizeInput !== undefined && manualSizeInput !== "") farm.manualSizeInput = String(manualSizeInput);
            if (manualSizeUnit !== undefined) farm.manualSizeUnit = manualSizeUnit;

            // --- GPS polygon / farm-area geometry validation ---
            // Runs BEFORE saving. Invalid geometry (self-intersecting, not
            // closed, <3 distinct non-collinear points, duplicate points,
            // zero/near-zero area, or coordinates outside Liberia) BLOCKS
            // the submission entirely. Valid-but-suspicious geometry (area
            // mismatch, overlap, unusual shape, poor GPS accuracy) is
            // allowed through as "Needs Review" — the result is cached on
            // the farm record either way for later display/reporting.
            const geometryResult = await validateAndAnnotateFarm(farm, {
                gpsAccuracyM: gpsAccuracyM !== undefined ? parseFloat(gpsAccuracyM) : null,
            });
            assertGeometryNotBlocking(geometryResult);

            // ── Save farm first to get a real UUID ──────────────────────────
            await this.farmRepository.save(farm);

            // ── Mint GeoID (non-blocking — farm is already saved) ───────────
            // We use the farm's UUID as the external_id so the GeoID API can
            // link back to our record if needed. GeoID is safe to share publicly:
            // it contains NO farmer PII, only the geometry.
            await mintGeoIdForFarm(this.farmRepository, farm, "create");

            // --- Multi-commodity structure (Plot + PlotCommodity) ---
            // Replaces the old single `cropType` select. Accepts either the
            // new `commodities` array (preferred — see CommodityInput), or,
            // for backward compatibility with any caller still only sending
            // the legacy `cropType` string, wraps that single value into an
            // equivalent one-commodity array so old integrations (e.g. the
            // mobile app, if not yet updated) keep working unmodified.
            let commodityInputs: CommodityInput[] = parseCommodities(commodities);
            if (commodityInputs.length === 0 && cropType) {
                commodityInputs = [{ commodityName: cropType, role: CommodityRole.PRIMARY, croppingSystem: CroppingSystem.MONOCROP }];
            }

            let areaWarning: string | null = null;
            if (commodityInputs.length > 0) {
                const { plots, warning } = await buildPlotsForFarm(farm, commodityInputs);
                for (const plot of plots) {
                    plot.farm = farm;
                    plot.farmId = farm.id;
                }
                await this.plotRepository.save(plots);
                areaWarning = warning;

                const { cropType: derivedCropType } = await refreshFarmPlotsAndLegacyCropType(farm.id);
                farm.cropType = derivedCropType;
                await this.farmRepository.save(farm);
            }

            // Farm photos (multipart field "farmPhotos" or "farmPhotos[]"), same
            // convention used elsewhere (addPhotos(), FarmerController.create()).
            const files = (req as any).files as Express.Multer.File[] | undefined;
            const photoFiles = files?.filter(f => f.fieldname === 'farmPhotos' || f.fieldname === 'farmPhotos[]');
            if (photoFiles && photoFiles.length > 0) {
                farm.farmPhotos = await uploadFilesToCloudinary(photoFiles);
                await this.farmRepository.save(farm);
            }

            // ── Optional compliance document ─────────────────────────────────
            const { documentType, documentUrl } = req.body;
            if (documentType && documentUrl) {
                const docRepository = AppDataSource.getRepository("FarmDocument");
                const doc = docRepository.create({
                    farm,
                    farmId: farm.id,
                    type: documentType,
                    documentUrl,
                    status: "Pending"
                });
                await docRepository.save(doc);
            }

            // Audit trail entry for the "Add Farm to Existing Farmer" workflow:
            // whenever an ADMIN/INSPECTOR attaches a NEW farm to an ALREADY
            // EXISTING farmer (as opposed to a farmer newly registered in the
            // same request via FarmerController.create()), record it so there's
            // a reviewable history of which farms were added to which farmer,
            // by whom, and when.
            if ((user.role === UserRole.ADMIN || user.role === UserRole.INSPECTOR) && farmerId) {
                const auditRow = new FarmerAuditLog();
                auditRow.farmerId = (farmer as any).id;
                auditRow.action = FarmerAuditAction.FARM_ADDED;
                auditRow.farmId = farm.id;
                const commodityLabel = farm.cropType ? ` (${farm.cropType})` : "";
                auditRow.notes = `Farm "${farm.name}"${commodityLabel} added to existing farmer.`;
                if (user.id) auditRow.performedByUserId = user.id;
                if (user.name) auditRow.performedByName = user.name;
                await this.auditLogRepository.save(auditRow);
            }

            const savedFarm = await this.farmRepository.findOne({ where: { id: farm.id }, relations: FARM_COMMODITY_RELATIONS });
            return successResponse(res, { ...savedFarm, areaWarning, geometryValidation: geometryResult }, "Farm created successfully", 201);
        } catch (error: any) {
            console.error("Error creating farm:", error);
            if (error.isGeometryValidationError) {
                return errorResponse(res, error.message, [error.message], 400);
            }
            return errorResponse(res, "Error creating farm", [error.message], 500);
        }
    }

    // Attach one or more photos to an existing farm (multipart, field name "farmPhotos").
    // Appends to any photos already stored on the farm rather than replacing them,
    // so this can be called multiple times (e.g. inspector adding more photos later).
    async addPhotos(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const farm = await this.farmRepository.findOne({ where: { id } });
            if (!farm) return errorResponse(res, "Farm not found", [], 404);

            const files = (req as any).files as Express.Multer.File[] | undefined;
            const photoFiles = files?.filter(f => f.fieldname === 'farmPhotos' || f.fieldname === 'farmPhotos[]');
            if (!photoFiles || photoFiles.length === 0) {
                return errorResponse(res, "No photo files provided (expected field name 'farmPhotos')", [], 400);
            }

            const newUrls = await uploadFilesToCloudinary(photoFiles);
            farm.farmPhotos = [...(farm.farmPhotos || []), ...newUrls];
            await this.farmRepository.save(farm);

            return successResponse(res, farm, "Farm photos added successfully");
        } catch (error: any) {
            console.error("Error adding farm photos:", error);
            return errorResponse(res, "Error adding farm photos", [error.message], 500);
        }
    }

    // Attach EUDR-standard boundary evidence (per-GPS-point geotagged photos) to
    // an existing farm. Expects a multipart request with:
    //   - field "points": JSON string array of
    //       { sequence, lat, lng, accuracy?, timestamp? }
    //   - files with fieldname "boundaryPhoto_<sequence>" (one photo per point,
    //     sequence matching the corresponding entry in "points")
    // Each point's file is matched by its sequence number so ordering in the
    // multipart payload doesn't matter. Optionally also accepts "location"
    // (GeoJSON Polygon built from the same points) and "totalAreaHa" to update
    // the farm's boundary/area in the same request. When a new polygon
    // boundary is submitted here we also re-mint the GeoID (same geometry ->
    // same GeoID; updated boundary -> new GeoID).
    async addBoundaryEvidence(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const farm = await this.farmRepository.findOne({ where: { id } });
            if (!farm) return errorResponse(res, "Farm not found", [], 404);

            const { points, location, totalAreaHa } = req.body;
            if (!points) {
                return errorResponse(res, "Missing 'points' field (JSON array of {sequence, lat, lng})", [], 400);
            }

            let parsedPoints: any[];
            try {
                parsedPoints = typeof points === "string" ? JSON.parse(points) : points;
            } catch (e) {
                return errorResponse(res, "Invalid JSON in 'points' field", [], 400);
            }

            if (!Array.isArray(parsedPoints) || parsedPoints.length < 4) {
                return errorResponse(res, "At least 4 boundary points (with photos) are required", [], 400);
            }

            const files = (req as any).files as Express.Multer.File[] | undefined;

            // Validate every point has a matching photo BEFORE uploading anything
            // to Cloudinary, so we fail fast without wasting uploads.
            const filesByPoint = parsedPoints.map((p: any) => {
                const seq = p.sequence;
                const file = files?.find(f => f.fieldname === `boundaryPhoto_${seq}`);
                if (!file) {
                    throw new Error(`Missing photo for boundary point ${seq} (expected field 'boundaryPhoto_${seq}')`);
                }
                return { point: p, file };
            });

            const evidence = await Promise.all(
                filesByPoint.map(async ({ point: p, file }) => ({
                    sequence: p.sequence,
                    lat: parseFloat(p.lat),
                    lng: parseFloat(p.lng),
                    accuracy: p.accuracy !== undefined ? parseFloat(p.accuracy) : undefined,
                    timestamp: p.timestamp,
                    photoUrl: await uploadFileToCloudinary(file),
                }))
            );

            farm.boundaryEvidence = evidence;

            if (location) {
                const parsedLocation = typeof location === "string" ? JSON.parse(location) : location;
                farm.location = parsedLocation;
            }
            if (totalAreaHa) {
                farm.totalAreaHa = parseFloat(totalAreaHa);
            }

            await this.farmRepository.save(farm);

            // Re-mint GeoID for the updated boundary (best-effort) if the
            // boundary was actually replaced in this request.
            if (location) {
                await mintGeoIdForFarm(this.farmRepository, farm, "boundary-evidence update");
            }

            return successResponse(res, farm, "Boundary evidence saved successfully");
        } catch (error: any) {
            console.error("Error adding boundary evidence:", error);
            return errorResponse(res, error.message || "Error adding boundary evidence", [error.message], 400);
        }
    }

    async offlineSync(req: Request, res: Response) {
        try {
            const {
                farmerId, name, cropType, location, totalAreaHa,
                ownershipType, ownershipDocument, farmRegistrationStatus,
                numberOfTrees, yearsInCultivation, harvestSeason, averageYield,
                buyers, useChemicals, extensionServices, farmAddress, farmNotes,
                manualSizeInput, manualSizeUnit, commodities, gpsAccuracyM,
                farmLat, farmLng,
            } = req.body;
            // NOTE: cropType is no longer strictly required — a farm can now be
            // synced with a `commodities` array instead. At least one of the
            // two must be present so every farm still has SOME initial
            // commodity information (kept as a required-ish soft rule rather
            // than a hard validation error, to avoid breaking any
            // already-queued offline payload that only has cropType).
            if (!farmerId || !name || !location || (!cropType && !commodities)) {
                return errorResponse(res, "farmerId, name, location (GeoJSON) and either cropType or commodities are required", [], 400);
            }

            const farmerRepository = AppDataSource.getRepository("Farmer");
            const farmer = await farmerRepository.findOne({ where: { id: farmerId } });
            if (!farmer) return errorResponse(res, "Farmer not found", [], 404);

            const existing = await this.farmRepository.findOne({
                where: { farmer: { id: farmerId }, name }
            });
            if (existing) return errorResponse(res, `Farm "${name}" already exists for this farmer`, [], 400);

            const parsedLocation = typeof location === "string" ? JSON.parse(location) : location;

            const farm = new Farm();
            farm.name = name;
            farm.location = parsedLocation;
            farm.farmer = farmer as any;

            // Full farm-detail field set — same parity as create() and as
            // FarmerController's farmsData[] mapping, so offline-created
            // farms (added to an already-synced existing farmer) don't
            // lose detail once they reach the server.
            if (totalAreaHa !== undefined && totalAreaHa !== "") farm.totalAreaHa = parseFloat(totalAreaHa);
            if (ownershipType !== undefined) farm.ownershipType = ownershipType;
            if (ownershipDocument !== undefined) farm.ownershipDocument = ownershipDocument;
            if (farmRegistrationStatus !== undefined) farm.farmRegistrationStatus = farmRegistrationStatus;
            if (numberOfTrees !== undefined && numberOfTrees !== "") farm.numberOfTrees = parseInt(numberOfTrees);
            if (yearsInCultivation !== undefined && yearsInCultivation !== "") farm.yearsInCultivation = parseInt(yearsInCultivation);
            if (harvestSeason !== undefined) farm.harvestSeason = harvestSeason;
            if (averageYield !== undefined) farm.averageYield = averageYield;
            if (buyers !== undefined) farm.buyers = buyers;
            if (useChemicals !== undefined) farm.useChemicals = useChemicals === true || useChemicals === "true";
            if (extensionServices !== undefined) farm.extensionServices = extensionServices === true || extensionServices === "true";
            if (farmAddress !== undefined) farm.farmAddress = farmAddress;
            // Farm's own GPS reference point - same semantics as
            // AuthController.registerFarmer / FarmerController.offlineSync.
            if (farmLat !== undefined && farmLat !== null && farmLat !== '') {
                farm.farmLatitude = parseFloat(farmLat);
            }
            if (farmLng !== undefined && farmLng !== null && farmLng !== '') {
                farm.farmLongitude = parseFloat(farmLng);
            }
            if (farmNotes !== undefined) farm.farmNotes = farmNotes;
            if (manualSizeInput !== undefined && manualSizeInput !== "") farm.manualSizeInput = String(manualSizeInput);
            if (manualSizeUnit !== undefined) farm.manualSizeUnit = manualSizeUnit;

            // Same geometry-validation gate as create() — a farm queued
            // offline with invalid boundary geometry is rejected on sync
            // rather than silently accepted (never auto-deletes anything;
            // the mobile client still has the original queued data locally
            // and can correct/resubmit it).
            const geometryResult = await validateAndAnnotateFarm(farm, {
                gpsAccuracyM: gpsAccuracyM !== undefined ? parseFloat(gpsAccuracyM) : null,
            });
            assertGeometryNotBlocking(geometryResult);

            await this.farmRepository.save(farm);

            // Mint GeoID best-effort for offline-synced farms too
            await mintGeoIdForFarm(this.farmRepository, farm, "offline-sync");

            let commodityInputs: CommodityInput[] = parseCommodities(commodities);
            if (commodityInputs.length === 0 && cropType) {
                commodityInputs = [{ commodityName: cropType, role: CommodityRole.PRIMARY, croppingSystem: CroppingSystem.MONOCROP }];
            }
            if (commodityInputs.length > 0) {
                const { plots } = await buildPlotsForFarm(farm, commodityInputs);
                for (const plot of plots) {
                    plot.farm = farm;
                    plot.farmId = farm.id;
                }
                await this.plotRepository.save(plots);
                const { cropType: derivedCropType } = await refreshFarmPlotsAndLegacyCropType(farm.id);
                farm.cropType = derivedCropType;
                await this.farmRepository.save(farm);
            }

            const savedFarm = await this.farmRepository.findOne({ where: { id: farm.id }, relations: FARM_COMMODITY_RELATIONS });
            return successResponse(res, { ...savedFarm, geometryValidation: geometryResult }, "Farm synced successfully", 201);
        } catch (error: any) {
            console.error(error);
            if (error.isGeometryValidationError) {
                return errorResponse(res, error.message, [error.message], 400);
            }
            return errorResponse(res, "Error syncing farm", [error.message], 500);
        }
    }

    // --- Commodity management (add / update / deactivate WITHOUT deleting the farm) ---

    /**
     * Adds one new commodity to a farm. Body: a single CommodityInput
     * object (commodityName, role, croppingSystem, plantedAreaHa,
     * plantingYear, numberOfTrees, estimatedAnnualProduction,
     * unitOfMeasurement, productionStatus, expectedHarvestPeriod,
     * plotGroup/plotName/plotBoundary/plotAreaHa).
     *
     * If `plotGroup` matches an existing ACTIVE plot's group (matched by
     * plot name for simplicity, since plotGroup is a client-side-only
     * grouping key not persisted verbatim), the new commodity is attached
     * to that SAME plot (intercropped case — no new area is added). If it
     * references a new/absent group, a new Plot is created (separate
     * physical area case), and the "total subplot area exceeds farm area"
     * warning is (re-)evaluated across ALL of the farm's active plots.
     */
    async addCommodity(req: Request, res: Response) {
        try {
            const { id } = req.params; // farm id
            const farm = await this.farmRepository.findOne({ where: { id }, relations: ["plots", "plots.plotCommodities", "farmer"] });
            if (!farm) return errorResponse(res, "Farm not found", [], 404);

            const input: CommodityInput = req.body;
            if (!input.commodityName) return errorResponse(res, "commodityName is required", [], 400);

            let targetPlot: Plot | undefined;
            if (input.plotGroup) {
                targetPlot = (farm.plots || []).find(
                    (p) => p.isActive && p.name === input.plotName && input.plotGroup
                );
            }
            // Default: attach to the farm's default/shared plot if one exists
            // and no separate physical plot was requested (implements the
            // "intercropped -> shared farm polygon" rule for commodities
            // added one at a time after farm creation, not just at creation
            // time).
            if (!targetPlot && !input.plotBoundary && !input.plotAreaHa) {
                targetPlot = (farm.plots || []).find((p) => p.isActive && p.isDefault);
            }

            if (!targetPlot) {
                const { plots } = await buildPlotsForFarm(farm, [input]);
                const [newPlot] = plots;
                newPlot.farm = farm;
                newPlot.farmId = farm.id;
                await this.plotRepository.save(newPlot);
            } else {
                const commodity = await resolveCommodity(input.commodityName);
                const pc = new PlotCommodity();
                pc.plot = targetPlot;
                pc.plotId = targetPlot.id;
                pc.commodity = commodity;
                pc.commodityId = commodity.id;
                pc.commodityName = commodity.name;
                pc.role = (input.role as CommodityRole) || CommodityRole.SECONDARY;
                pc.croppingSystem = (input.croppingSystem as CroppingSystem) || CroppingSystem.INTERCROPPED;
                pc.plantedAreaHa = input.plantedAreaHa !== undefined ? parseFloat(String(input.plantedAreaHa)) : null;
                pc.plantingYear = input.plantingYear !== undefined ? parseInt(String(input.plantingYear)) : null;
                pc.numberOfTrees = input.numberOfTrees !== undefined ? parseInt(String(input.numberOfTrees)) : null;
                pc.estimatedAnnualProduction = input.estimatedAnnualProduction !== undefined ? parseFloat(String(input.estimatedAnnualProduction)) : null;
                pc.unitOfMeasurement = input.unitOfMeasurement || "";
                pc.productionStatus = (input.productionStatus as ProductionStatus) || ProductionStatus.NOT_YET_PRODUCTIVE;
                pc.expectedHarvestPeriod = input.expectedHarvestPeriod || "";
                pc.isActive = true;
                await this.plotCommodityRepository.save(pc);
            }

            const { plots: refreshedPlots, cropType } = await refreshFarmPlotsAndLegacyCropType(farm.id);
            farm.cropType = cropType;
            await this.farmRepository.save(farm);

            const warning = computeAreaWarning(farm, refreshedPlots);

            const user = (req as any).user;
            const auditRow = new FarmerAuditLog();
            auditRow.farmerId = (farm.farmer as any)?.id || (farm as any).farmerId;
            auditRow.action = FarmerAuditAction.COMMODITY_ADDED;
            auditRow.farmId = farm.id;
            auditRow.notes = `Commodity "${input.commodityName}" added to farm "${farm.name}".`;
            if (user?.id) auditRow.performedByUserId = user.id;
            if (user?.name) auditRow.performedByName = user.name;
            if (auditRow.farmerId) await this.auditLogRepository.save(auditRow);

            const savedFarm = await this.farmRepository.findOne({ where: { id: farm.id }, relations: FARM_COMMODITY_RELATIONS });
            return successResponse(res, { ...savedFarm, areaWarning: warning }, "Commodity added successfully", 201);
        } catch (error: any) {
            console.error("Error adding commodity:", error);
            return errorResponse(res, "Error adding commodity", [error.message], 500);
        }
    }

    /**
     * Updates an existing PlotCommodity row's details (does NOT change
     * which plot it belongs to). Body: any subset of CommodityInput's
     * per-planting fields.
     */
    async updateCommodity(req: Request, res: Response) {
        try {
            const { id, commodityId } = req.params; // farm id, plotCommodity id
            const pc = await this.plotCommodityRepository.findOne({
                where: { id: commodityId },
                relations: ["plot", "plot.farm"],
            });
            if (!pc || pc.plot?.farmId !== id) return errorResponse(res, "Commodity record not found for this farm", [], 404);

            const input: Partial<CommodityInput> = req.body;
            if (input.commodityName !== undefined) {
                const commodity = await resolveCommodity(input.commodityName);
                pc.commodity = commodity;
                pc.commodityId = commodity.id;
                pc.commodityName = commodity.name;
            }
            if (input.role !== undefined) pc.role = input.role as CommodityRole;
            if (input.croppingSystem !== undefined) pc.croppingSystem = input.croppingSystem as CroppingSystem;
            if (input.plantedAreaHa !== undefined) pc.plantedAreaHa = input.plantedAreaHa === null ? null : parseFloat(String(input.plantedAreaHa));
            if (input.plantingYear !== undefined) pc.plantingYear = input.plantingYear === null ? null : parseInt(String(input.plantingYear));
            if (input.numberOfTrees !== undefined) pc.numberOfTrees = input.numberOfTrees === null ? null : parseInt(String(input.numberOfTrees));
            if (input.estimatedAnnualProduction !== undefined) pc.estimatedAnnualProduction = input.estimatedAnnualProduction === null ? null : parseFloat(String(input.estimatedAnnualProduction));
            if (input.unitOfMeasurement !== undefined) pc.unitOfMeasurement = input.unitOfMeasurement;
            if (input.productionStatus !== undefined) pc.productionStatus = input.productionStatus as ProductionStatus;
            if (input.expectedHarvestPeriod !== undefined) pc.expectedHarvestPeriod = input.expectedHarvestPeriod;
            if (input.isActive !== undefined) pc.isActive = input.isActive;

            await this.plotCommodityRepository.save(pc);

            const farm = await this.farmRepository.findOne({ where: { id }, relations: ["farmer"] });
            if (farm) {
                const { plots: refreshedPlots, cropType } = await refreshFarmPlotsAndLegacyCropType(id);
                farm.cropType = cropType;
                await this.farmRepository.save(farm);

                const user = (req as any).user;
                const auditRow = new FarmerAuditLog();
                auditRow.farmerId = (farm.farmer as any)?.id;
                auditRow.action = FarmerAuditAction.COMMODITY_UPDATED;
                auditRow.farmId = farm.id;
                auditRow.notes = `Commodity "${pc.commodityName}" updated on farm "${farm.name}".`;
                if (user?.id) auditRow.performedByUserId = user.id;
                if (user?.name) auditRow.performedByName = user.name;
                if (auditRow.farmerId) await this.auditLogRepository.save(auditRow);

                const warning = computeAreaWarning(farm, refreshedPlots);
                const savedFarm = await this.farmRepository.findOne({ where: { id: farm.id }, relations: FARM_COMMODITY_RELATIONS });
                return successResponse(res, { ...savedFarm, areaWarning: warning }, "Commodity updated successfully");
            }

            return successResponse(res, pc, "Commodity updated successfully");
        } catch (error: any) {
            console.error("Error updating commodity:", error);
            return errorResponse(res, "Error updating commodity", [error.message], 500);
        }
    }

    /**
     * Soft-deactivates a commodity (isActive = false) WITHOUT deleting the
     * farm, the plot, or the PlotCommodity row itself — preserves history
     * per the spec's "allow a user to... deactivate a commodity without
     * deleting the farm" requirement. Use updateCommodity with
     * { isActive: true } to reactivate.
     */
    async deactivateCommodity(req: Request, res: Response) {
        try {
            const { id, commodityId } = req.params;
            const pc = await this.plotCommodityRepository.findOne({
                where: { id: commodityId },
                relations: ["plot"],
            });
            if (!pc || pc.plot?.farmId !== id) return errorResponse(res, "Commodity record not found for this farm", [], 404);

            pc.isActive = false;
            await this.plotCommodityRepository.save(pc);

            const farm = await this.farmRepository.findOne({ where: { id }, relations: ["farmer"] });
            if (farm) {
                const { cropType } = await refreshFarmPlotsAndLegacyCropType(id);
                farm.cropType = cropType;
                await this.farmRepository.save(farm);

                const user = (req as any).user;
                const auditRow = new FarmerAuditLog();
                auditRow.farmerId = (farm.farmer as any)?.id;
                auditRow.action = FarmerAuditAction.COMMODITY_DEACTIVATED;
                auditRow.farmId = farm.id;
                auditRow.notes = `Commodity "${pc.commodityName}" deactivated on farm "${farm.name}" (farm record preserved).`;
                if (user?.id) auditRow.performedByUserId = user.id;
                if (user?.name) auditRow.performedByName = user.name;
                if (auditRow.farmerId) await this.auditLogRepository.save(auditRow);
            }

            return successResponse(res, pc, "Commodity deactivated successfully");
        } catch (error: any) {
            console.error("Error deactivating commodity:", error);
            return errorResponse(res, "Error deactivating commodity", [error.message], 500);
        }
    }

    // --- Data Correction Queue (GPS polygon / farm-area validation) ---
    //
    // These endpoints implement the "existing records with invalid geometry
    // are placed in a Data Correction Queue" and "never automatically
    // delete existing coordinates" status rules: they are strictly
    // READ + RE-VALIDATE only. Neither endpoint below ever deletes,
    // clears, or overwrites a farm's `location` boundary — the ONLY thing
    // that can change a farm's actual coordinates is a farmer/inspector
    // deliberately re-drawing/re-submitting a boundary through the normal
    // create/edit flow (which itself goes through the same geometry-
    // validation gate).

    /**
     * Lists every farm whose most recently cached geometry validation
     * status is Invalid, Needs Review, or Missing (including farms that
     * predate this feature and have never been validated at all — they
     * default to "Missing"). This is the admin-facing "Data Correction
     * Queue": a worklist of farms whose GPS boundary needs attention
     * before that farm can be trusted for compliance analysis, WITHOUT
     * ever touching the farm's actual stored coordinates.
     */
    async getDataCorrectionQueue(req: Request, res: Response) {
        try {
            const statusFilter = (req.query.status as string) || null;
            const statuses = statusFilter
                ? [statusFilter]
                : ["Invalid", "Needs Review", "Missing"];

            const farms = await this.farmRepository
                .createQueryBuilder("farm")
                .leftJoinAndSelect("farm.farmer", "farmer")
                .where("farm.geometryStatus IN (:...statuses)", { statuses })
                .orderBy("farm.geometryStatus", "ASC")
                .addOrderBy("farm.updatedAt", "DESC")
                .getMany();

            const summary = {
                total: farms.length,
                byStatus: {
                    Invalid: farms.filter((f) => f.geometryStatus === "Invalid").length,
                    "Needs Review": farms.filter((f) => f.geometryStatus === "Needs Review").length,
                    Missing: farms.filter((f) => f.geometryStatus === "Missing").length,
                },
            };

            return successResponse(res, { summary, farms }, "Data Correction Queue fetched successfully");
        } catch (error: any) {
            console.error("Error fetching data correction queue:", error);
            return errorResponse(res, "Error fetching data correction queue", [error.message], 500);
        }
    }

    /**
     * Re-runs geometry validation for a single existing farm and updates
     * ONLY its cached validation columns (geometryStatus, calculatedAreaHa,
     * etc.) — the farm's `location` coordinates themselves are read-only
     * here and are never modified, cleared, or deleted by this endpoint.
     * Useful after a farmer/inspector has separately corrected a boundary
     * via the normal farm-edit flow, or simply to refresh a legacy farm's
     * status after this feature was first deployed (backfill).
     */
    async revalidateGeometry(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const farm = await this.farmRepository.findOne({ where: { id } });
            if (!farm) return errorResponse(res, "Farm not found", [], 404);

            const result = await validateAndAnnotateFarm(farm, { excludeFarmId: farm.id });
            await this.farmRepository.save(farm);

            return successResponse(res, { farmId: farm.id, geometryValidation: result }, "Geometry re-validated successfully");
        } catch (error: any) {
            console.error("Error re-validating farm geometry:", error);
            return errorResponse(res, "Error re-validating farm geometry", [error.message], 500);
        }
    }

    /**
     * Bulk variant of revalidateGeometry(): re-validates EVERY farm in the
     * database and refreshes their cached geometry-validation columns.
     * Intended as a one-off backfill/maintenance operation (e.g. run once
     * right after this feature is deployed, so pre-existing farms get a
     * real geometryStatus instead of sitting at the "Missing" default
     * forever) or periodically from an admin action. Strictly read+
     * re-validate — never modifies farm.location.
     */
    async revalidateAllGeometry(req: Request, res: Response) {
        try {
            const farms = await this.farmRepository.find();
            let validCount = 0, needsReviewCount = 0, invalidCount = 0, missingCount = 0;

            for (const farm of farms) {
                const result = await validateAndAnnotateFarm(farm, { excludeFarmId: farm.id });
                await this.farmRepository.save(farm);
                if (result.status === "Valid") validCount++;
                else if (result.status === "Needs Review") needsReviewCount++;
                else if (result.status === "Invalid") invalidCount++;
                else missingCount++;
            }

            return successResponse(
                res,
                { total: farms.length, validCount, needsReviewCount, invalidCount, missingCount },
                `Re-validated geometry for ${farms.length} farm(s).`
            );
        } catch (error: any) {
            console.error("Error re-validating all farm geometry:", error);
            return errorResponse(res, "Error re-validating all farm geometry", [error.message], 500);
        }
    }

    /**
     * ADMIN: Backfill GeoIDs for all existing farms that don't have one yet.
     * Safe to call repeatedly — skips farms that already have a geoId.
     * Also generates farmQrCode for farms missing it.
     *
     * Supports two response modes:
     *
     *  Default (no ?stream query param):
     *    Processes all farms and returns a single JSON summary at the end.
     *    Fine for small datasets (< ~200 farms). May time-out on large ones.
     *
     *  Streaming mode (?stream=1):
     *    Uses Server-Sent Events (SSE) to push a progress line after each farm
     *    is processed. The browser / curl client receives live updates and the
     *    connection only closes when the last farm is done.
     *    Ideal for production backfills on large datasets.
     *
     *    SSE event format (one JSON object per line):
     *      data: {"event":"progress","processed":1,"total":450,"minted":1,"skipped":0,"farmId":"...","geoid":"..."}
     *      data: {"event":"skip","processed":2,"total":450,"minted":1,"skipped":1,"farmId":"...","reason":"no valid geometry"}
     *      data: {"event":"error","processed":3,"total":450,"minted":1,"skipped":2,"farmId":"...","error":"..."}
     *      data: {"event":"done","total":450,"minted":350,"skipped":100,"errors":[...]}
     */
    async backfillGeoIds(req: Request, res: Response) {
        const stream = req.query.stream === "1" || req.query.stream === "true";

        // ── Helper: write one SSE event ────────────────────────────────────────
        const sse = (data: Record<string, unknown>) => {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
            // Flush immediately so the client sees each event as it arrives
            if (typeof (res as any).flush === "function") (res as any).flush();
        };

        try {
            const farms = await this.farmRepository
                .createQueryBuilder("farm")
                .where("farm.geoId IS NULL OR farm.geoId = ''")
                .orderBy("farm.createdAt", "ASC")   // oldest first — consistent ordering across retries
                .getMany();

            const geoIdSvc = getGeoIdService();
            let minted = 0;
            let skipped = 0;
            const errors: string[] = [];

            // ── Set up SSE headers if streaming ───────────────────────────────
            if (stream) {
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("X-Accel-Buffering", "no"); // Disable Nginx/Render buffering
                res.setHeader("Connection", "keep-alive");
                res.flushHeaders();

                // Send total count immediately so the frontend can show a progress bar
                sse({ event: "start", total: farms.length });
            }

            for (let i = 0; i < farms.length; i++) {
                const farm = farms[i];
                const processed = i + 1;

                try {
                    const geometry = GeoIdService.normaliseGeometry(farm.location);
                    if (!geometry) {
                        skipped++;
                        const reason = "no valid geometry";
                        errors.push(`Farm ${farm.id} (${farm.name}): ${reason}`);
                        if (stream) sse({ event: "skip", processed, total: farms.length, minted, skipped, farmId: farm.id, farmName: farm.name, reason });
                        continue;
                    }

                    const result = await geoIdSvc.mintGeoId(geometry, farm.id);
                    farm.geoId = result.geoid;
                    farm.geoIdUri = result.uri;

                    if (!farm.farmQrCode) {
                        const scanUrl = GeoIdService.farmScanUrl(farm.id);
                        farm.farmQrCode = await QRCode.toDataURL(scanUrl);
                    }

                    await this.farmRepository.save(farm);
                    minted++;
                    console.log(`[GeoID backfill] Minted ${result.geoid} for farm ${farm.id}`);
                    if (stream) sse({ event: "progress", processed, total: farms.length, minted, skipped, farmId: farm.id, farmName: farm.name, geoid: result.geoid });

                } catch (err: any) {
                    skipped++;
                    const errMsg = err.message ?? String(err);
                    errors.push(`Farm ${farm.id} (${farm.name}): ${errMsg}`);
                    console.warn(`[GeoID backfill] Failed for farm ${farm.id}: ${errMsg}`);
                    if (stream) sse({ event: "error", processed, total: farms.length, minted, skipped, farmId: farm.id, farmName: farm.name, error: errMsg });
                }
            }

            // ── Final summary ─────────────────────────────────────────────────
            const summary = {
                total: farms.length,
                minted,
                skipped,
                errors: errors.length > 0 ? errors : undefined,
            };

            if (stream) {
                sse({ event: "done", ...summary });
                res.end();
            } else {
                return successResponse(res, summary, `GeoID backfill complete: ${minted} minted, ${skipped} skipped`);
            }

        } catch (error: any) {
            console.error("Error in GeoID backfill:", error);
            if (stream) {
                sse({ event: "fatal", error: error.message });
                res.end();
            } else {
                return errorResponse(res, "GeoID backfill failed", [error.message], 500);
            }
        }
    }
}
