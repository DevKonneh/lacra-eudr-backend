import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Farm } from "../entities/Farm";
import { UserRole } from "../entities/User";
import { successResponse, errorResponse } from "../utils/response";
import { uploadFilesToCloudinary, uploadFileToCloudinary } from "../utils/cloudUpload";
import { getGeoIdService, GeoIdService } from "../services/GeoIdService";
import QRCode from "qrcode";

export class FarmController {
    private farmRepository = AppDataSource.getRepository(Farm);

    async getAll(req: Request, res: Response) {
        try {
            const user = (req as any).user;
            let whereClause = {};

            if (user && user.role === UserRole.FARMER) {
                // Find Farmer profile linked to this user
                const farmerRepository = AppDataSource.getRepository("Farmer");
                const farmer = await farmerRepository.findOne({ where: { user: { id: user.id } } });

                if (farmer) {
                    whereClause = { farmer: { id: (farmer as any).id } };
                } else {
                    return successResponse(res, []);
                }
            }

            const farms = await this.farmRepository.find({
                where: whereClause,
                relations: ["farmer"],
                order: { name: "ASC" }
            });
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
                relations: ["farmer"]
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

            const { name, cropType, lat, lng, farmerId, location, totalAreaHa } = req.body;
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
            farm.cropType = cropType;
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

            // ── Save farm first to get a real UUID ──────────────────────────
            await this.farmRepository.save(farm);

            // ── Mint GeoID (non-blocking — farm is already saved) ───────────
            // We use the farm's UUID as the external_id so the GeoID API can
            // link back to our record if needed. GeoID is safe to share publicly:
            // it contains NO farmer PII, only the geometry.
            try {
                const geometry = GeoIdService.normaliseGeometry(farm.location);
                if (geometry) {
                    const geoIdSvc = getGeoIdService();
                    const result = await geoIdSvc.mintGeoId(geometry, farm.id);
                    farm.geoId = result.geoid;
                    farm.geoIdUri = result.uri;

                    // Generate per-farm QR code encoding the farm-scan public endpoint.
                    // This is what WHIMO and traders scan — completely separate from the
                    // farmer-level QR on the Farmer entity.
                    const scanUrl = GeoIdService.farmScanUrl(farm.id);
                    farm.farmQrCode = await QRCode.toDataURL(scanUrl);

                    await this.farmRepository.save(farm);
                    console.log(`[GeoID] Minted ${result.geoid} for farm ${farm.id}`);
                }
            } catch (geoErr: any) {
                // GeoID minting is best-effort: a network hiccup should NOT block
                // farm registration. The backfill endpoint can recover these later.
                console.warn(`[GeoID] Mint failed for farm ${farm.id} (non-fatal): ${geoErr.message}`);
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

            return successResponse(res, farm, "Farm created successfully", 201);
        } catch (error: any) {
            console.error("Error creating farm:", error);
            return errorResponse(res, "Error creating farm", [error.message], 500);
        }
    }

    // Attach one or more photos to an existing farm (multipart, field name "farmPhotos").
    // Appends to any photos already stored on the farm rather than replacing them.
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

    // Attach EUDR-standard boundary evidence (per-GPS-point geotagged photos).
    // When a new polygon boundary is submitted here we also re-mint the GeoID
    // (same geometry → same GeoID; updated boundary → new GeoID).
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

                // Re-mint GeoID for the updated boundary (best-effort)
                try {
                    const geometry = GeoIdService.normaliseGeometry(farm.location);
                    if (geometry) {
                        const geoIdSvc = getGeoIdService();
                        const result = await geoIdSvc.mintGeoId(geometry, farm.id);
                        if (result.geoid !== farm.geoId) {
                            console.log(`[GeoID] Boundary updated → new GeoID ${result.geoid} for farm ${farm.id}`);
                        }
                        farm.geoId = result.geoid;
                        farm.geoIdUri = result.uri;

                        // Regenerate QR if not already set
                        if (!farm.farmQrCode) {
                            const scanUrl = GeoIdService.farmScanUrl(farm.id);
                            farm.farmQrCode = await QRCode.toDataURL(scanUrl);
                        }
                    }
                } catch (geoErr: any) {
                    console.warn(`[GeoID] Re-mint failed for farm ${farm.id} (non-fatal): ${geoErr.message}`);
                }
            }

            if (totalAreaHa) {
                farm.totalAreaHa = parseFloat(totalAreaHa);
            }

            await this.farmRepository.save(farm);
            return successResponse(res, farm, "Boundary evidence saved successfully");
        } catch (error: any) {
            console.error("Error adding boundary evidence:", error);
            return errorResponse(res, error.message || "Error adding boundary evidence", [error.message], 400);
        }
    }

    async offlineSync(req: Request, res: Response) {
        try {
            const { farmerId, name, cropType, location } = req.body;
            if (!farmerId || !name || !cropType || !location) {
                return errorResponse(res, "farmerId, name, cropType and location (GeoJSON) required", [], 400);
            }

            const farmerRepository = AppDataSource.getRepository("Farmer");
            const farmer = await farmerRepository.findOne({ where: { id: farmerId } });
            if (!farmer) return errorResponse(res, "Farmer not found", [], 404);

            const existing = await this.farmRepository.findOne({
                where: { farmer: { id: farmerId }, name }
            });
            if (existing) return errorResponse(res, `Farm "${name}" already exists for this farmer`, [], 400);

            const parsedLocation = typeof location === "string" ? JSON.parse(location) : location;

            const farm = this.farmRepository.create({
                name,
                cropType,
                location: parsedLocation,
                farmer
            });
            await this.farmRepository.save(farm);

            // Mint GeoID best-effort for offline-synced farms too
            try {
                const geometry = GeoIdService.normaliseGeometry(parsedLocation);
                if (geometry) {
                    const geoIdSvc = getGeoIdService();
                    const result = await geoIdSvc.mintGeoId(geometry, farm.id);
                    farm.geoId = result.geoid;
                    farm.geoIdUri = result.uri;
                    const scanUrl = GeoIdService.farmScanUrl(farm.id);
                    farm.farmQrCode = await QRCode.toDataURL(scanUrl);
                    await this.farmRepository.save(farm);
                    console.log(`[GeoID] Minted ${result.geoid} for offline-synced farm ${farm.id}`);
                }
            } catch (geoErr: any) {
                console.warn(`[GeoID] Mint failed for offline farm ${farm.id} (non-fatal): ${geoErr.message}`);
            }

            return successResponse(res, farm, "Farm synced successfully", 201);
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error syncing farm", [error.message], 500);
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
