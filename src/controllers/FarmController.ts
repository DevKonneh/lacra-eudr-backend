import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Farm } from "../entities/Farm";
import { UserRole } from "../entities/User";
import { successResponse, errorResponse } from "../utils/response";
import { toPublicFileUrls } from "../utils/fileUrl";

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
                    whereClause = { farmer: { id: farmer.id } };
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
                    // Admin creating farm without specifying farmer? Maybe allowed if we had a select list, 
                    // but for this flow let's require it or fallback to user's farmer profile if they have one (unlikely for admin)
                    // For now, let's assume if Admin, they MUST specify farmerId or we error, 
                    // UNLESS they also happen to have a farmer profile (e.g. dual role system? unlikely here).
                    // Let's stick to: If Admin, require farmerId.
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

            await this.farmRepository.save(farm);

            const { documentType, documentUrl } = req.body;
            if (documentType && documentUrl) {
                const docRepository = AppDataSource.getRepository("FarmDocument");
                const doc = docRepository.create({
                    farm,
                    farmId: farm.id,
                    type: documentType,
                    documentUrl,
                    status: "Pending" // DocumentStatus.PENDING
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

            const newUrls = toPublicFileUrls(photoFiles.map(f => f.path));
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
    // the farm's boundary/area in the same request.
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

            const evidence = parsedPoints.map((p: any) => {
                const seq = p.sequence;
                const file = files?.find(f => f.fieldname === `boundaryPhoto_${seq}`);
                if (!file) {
                    throw new Error(`Missing photo for boundary point ${seq} (expected field 'boundaryPhoto_${seq}')`);
                }
                return {
                    sequence: seq,
                    lat: parseFloat(p.lat),
                    lng: parseFloat(p.lng),
                    accuracy: p.accuracy !== undefined ? parseFloat(p.accuracy) : undefined,
                    timestamp: p.timestamp,
                    photoUrl: toPublicFileUrls([file.path])[0],
                };
            });

            farm.boundaryEvidence = evidence;

            if (location) {
                const parsedLocation = typeof location === "string" ? JSON.parse(location) : location;
                farm.location = parsedLocation;
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

            const farm = this.farmRepository.create({
                name,
                cropType,
                location: typeof location === "string" ? JSON.parse(location) : location,
                farmer
            });
            await this.farmRepository.save(farm);
            return successResponse(res, farm, "Farm synced successfully", 201);
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error syncing farm", [error.message], 500);
        }
    }
}
