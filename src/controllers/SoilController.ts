import { Request, Response } from "express";
import * as turf from "@turf/turf";
import { AppDataSource } from "../data-source";
import { Farm } from "../entities/Farm";
import { SoilService } from "../services/SoilService";
import { successResponse, errorResponse } from "../utils/response";

export class SoilController {
    private farmRepository = AppDataSource.getRepository(Farm);
    private soilService = new SoilService();

    /**
     * Soil profile for an arbitrary lat/lon (query params), e.g. for a
     * not-yet-saved location during farm registration.
     */
    async getByCoordinates(req: Request, res: Response) {
        try {
            const lat = parseFloat(req.query.lat as string);
            const lon = parseFloat(req.query.lon as string);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                return errorResponse(res, "Valid lat and lon query params are required", [], 400);
            }
            const result = await this.soilService.getSoilProfile(lat, lon);
            return successResponse(res, result);
        } catch (error: any) {
            return errorResponse(res, "Error fetching soil profile", [error.message], 502);
        }
    }

    /** Soil profile for an existing farm, using its saved GPS location (Point or Polygon centroid). */
    async getByFarm(req: Request, res: Response) {
        try {
            const { farmId } = req.params;
            const farm = await this.farmRepository.findOne({ where: { id: farmId } });
            if (!farm) return errorResponse(res, "Farm not found", [], 404);
            if (!farm.location) return errorResponse(res, "This farm has no GPS location captured yet", [], 400);

            let lat: number, lon: number;
            const geom = farm.location as any;
            if (geom.type === "Point") {
                [lon, lat] = geom.coordinates;
            } else {
                // Polygon (or any other geometry) — use the centroid, same
                // approach WeatherController.ts / FarmMap / MapView use.
                const centroid = turf.centroid(geom as any);
                [lon, lat] = centroid.geometry.coordinates;
            }

            const result = await this.soilService.getSoilProfile(lat, lon);
            return successResponse(res, result);
        } catch (error: any) {
            return errorResponse(res, "Error fetching soil profile", [error.message], 502);
        }
    }
}
