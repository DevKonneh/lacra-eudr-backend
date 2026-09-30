/**
 * FarmScanController — Public farm-scan endpoint
 *
 * This is the single endpoint that the farm QR code resolves to.
 * It is consumed by two different clients:
 *
 *  1. WHIMO (trader app, unauthenticated)
 *     GET /api/public/farm-scan/:farmId
 *     → Returns geo-only payload: GeoID, centroid, GeoJSON polygon, crop type,
 *       area, compliance status. NO farmer PII.
 *     → WHIMO pre-fills its Producer Transaction with farm_latitude,
 *       farm_longitude, location="qr", and location_file (the polygon).
 *
 *  2. LACRA internal app (authenticated inspector / admin / buyer)
 *     GET /api/public/farm-scan/:farmId?view=full
 *     → Returns full farmer profile + farm details + GeoID + compliance.
 *
 * Rate-limiting note: this endpoint is intentionally unauthenticated so that
 * any WHIMO user can scan without creating a LACRA account. Add rate-limiting
 * middleware (e.g. express-rate-limit) in front of it in production.
 */

import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Farm } from "../entities/Farm";
import { Farmer } from "../entities/Farmer";
import { GeoIdService } from "../services/GeoIdService";
import { getWhimoService } from "../services/WhimoService";

export class FarmScanController {
    private farmRepository = AppDataSource.getRepository(Farm);
    private farmerRepository = AppDataSource.getRepository(Farmer);

    /**
     * GET /api/public/farm-scan/:farmId
     *
     * Query params:
     *   view=geo   (default) — safe, PII-free payload for WHIMO / external systems
     *   view=full             — full farmer + farm data for LACRA internal app
     */
    async scan(req: Request, res: Response) {
        try {
            const { farmId } = req.params;
            const view = (req.query.view as string) || "geo";

            // Load farm with its farmer relation (we may need it for view=full)
            const farm = await this.farmRepository.findOne({
                where: { id: farmId },
                relations: ["farmer"],
            });

            if (!farm) {
                return res.status(404).json({
                    success: false,
                    message: "Farm not found",
                });
            }

            // ── Compute centroid from stored geometry ─────────────────────────
            const geometry = GeoIdService.normaliseGeometry(farm.location);
            const centroid = geometry ? GeoIdService.centroidFromGeometry(geometry) : null;

            // ── GEO-ONLY payload (WHIMO / public) ─────────────────────────────
            // Contains NO farmer PII. Safe to return to any unauthenticated caller.
            // Fields are aligned to what WHIMO's Producer Transaction creation needs:
            //   farm_latitude    → centroid.lat
            //   farm_longitude   → centroid.lng
            //   location         → "qr"  (WHIMO TransactionLocation enum)
            //   location_file    → geojson (upload to WHIMO as GeoJSON file)
            const geoPayload = {
                // ── Identity (anonymous) ──────────────────────────────────────
                farmId: farm.id,
                geoId: farm.geoId ?? null,
                geoIdUri: farm.geoIdUri ?? null,

                // ── Location (for WHIMO transaction pre-fill) ─────────────────
                centroid: centroid
                    ? { lat: centroid.lat, lng: centroid.lng }
                    : null,
                // Full GeoJSON polygon — WHIMO uploads this as location_file
                geojson: geometry
                    ? {
                        type: "Feature",
                        id: farm.geoId ?? farm.id,
                        geometry,
                        properties: {
                            // Only non-PII attributes safe to share publicly
                            farmId: farm.id,
                            geoId: farm.geoId ?? null,
                            cropType: farm.cropType,
                            totalAreaHa: farm.totalAreaHa ?? null,
                            riskLevel: farm.riskLevel,
                        },
                    }
                    : null,

                // ── Commodity info (needed for WHIMO commodity selection) ──────
                cropType: farm.cropType,
                totalAreaHa: farm.totalAreaHa ?? null,

                // ── EUDR compliance snapshot (safe to share, no PII) ──────────
                riskLevel: farm.riskLevel,
                lastRiskAssessmentDate: farm.lastRiskAssessmentDate ?? null,
                farmRegistrationStatus: farm.farmRegistrationStatus ?? null,

                // ── Scan metadata ─────────────────────────────────────────────
                scannedAt: new Date().toISOString(),
                locationSource: "qr", // Maps directly to WHIMO TransactionLocation enum
            };

            if (view !== "full") {
                return res.status(200).json({
                    success: true,
                    data: geoPayload,
                });
            }

            // ── FULL payload (LACRA internal app) ─────────────────────────────
            // Includes farmer PII — only return when explicitly requested.
            // In production, protect this with authMiddleware before exposing
            // to non-LACRA clients.
            const farmer = farm.farmer;
            const fullPayload = {
                ...geoPayload,

                // ── Farm details ──────────────────────────────────────────────
                farmName: farm.name,
                ownershipType: farm.ownershipType ?? null,
                numberOfTrees: farm.numberOfTrees ?? null,
                yearsInCultivation: farm.yearsInCultivation ?? null,
                harvestSeason: farm.harvestSeason ?? null,
                averageYield: farm.averageYield ?? null,
                useChemicals: farm.useChemicals,
                extensionServices: farm.extensionServices,
                farmAddress: farm.farmAddress ?? null,
                farmPhotos: farm.farmPhotos ?? [],
                boundaryEvidence: farm.boundaryEvidence ?? [],
                farmQrCode: farm.farmQrCode ?? null,
                createdAt: farm.createdAt,
                updatedAt: farm.updatedAt,

                // ── Farmer profile ────────────────────────────────────────────
                farmer: farmer
                    ? {
                        id: farmer.id,
                        farmerId: farmer.farmerId,
                        firstName: farmer.firstName,
                        lastName: farmer.lastName,
                        phoneNumber: farmer.phoneNumber,
                        email: farmer.email ?? null,
                        gender: farmer.gender ?? null,
                        nationality: farmer.nationality ?? null,
                        address: farmer.address ?? null,
                        community: farmer.community ?? null,
                        district: farmer.district ?? null,
                        region: farmer.region ?? null,
                        cooperativeName: farmer.cooperativeName ?? null,
                        cooperativeId: farmer.cooperativeId ?? null,
                        identityStatus: farmer.identityStatus,
                        consent: farmer.consent,
                        profilePhoto: farmer.profilePhoto ?? null,
                        qrCode: farmer.qrCode ?? null,
                        directions: farmer.directions ?? null,
                        latitude: farmer.latitude ?? null,
                        longitude: farmer.longitude ?? null,
                        createdAt: farmer.createdAt,
                    }
                    : null,
            };

            return res.status(200).json({
                success: true,
                data: fullPayload,
            });
        } catch (error: any) {
            console.error("[FarmScan] Error:", error);
            return res.status(500).json({
                success: false,
                message: "Error loading farm scan data",
                errors: [error.message],
            });
        }
    }

    /**
     * GET /api/public/farm-scan/geoid/:geoid
     *
     * Resolve a GeoID back to its farm scan payload.
     * Useful when a trader has a GeoID (e.g. from a previous transaction)
     * and wants to look up the farm without the QR code.
     */
    async scanByGeoId(req: Request, res: Response) {
        try {
            const { geoid } = req.params;
            const view = (req.query.view as string) || "geo";

            const farm = await this.farmRepository.findOne({
                where: { geoId: geoid },
                relations: ["farmer"],
            });

            if (!farm) {
                return res.status(404).json({
                    success: false,
                    message: `No farm found for GeoID: ${geoid}`,
                });
            }

            // Delegate to scan() by rewriting the params and re-using the same logic
            req.params.farmId = farm.id;
            return this.scan(req, res);
        } catch (error: any) {
            console.error("[FarmScan] GeoID lookup error:", error);
            return res.status(500).json({
                success: false,
                message: "Error resolving GeoID",
                errors: [error.message],
            });
        }
    }

    /**
     * GET /api/public/farm-scan/:farmId/whimo-payload
     *
     * Convenience endpoint that returns EXACTLY what WHIMO needs to
     * pre-fill a Producer Transaction, with field names matching the
     * WHIMO API spec (TransactionProducerCreateRequest).
     *
     * WHIMO creates a transaction like:
     *   POST https://whimo.net/api/v1/transactions/producer
     *   {
     *     commodity_id: <trader selects from WHIMO commodity list>,
     *     volume: <trader enters>,
     *     farm_latitude: <from this endpoint>,
     *     farm_longitude: <from this endpoint>,
     *     location: "qr",
     *     location_file: <geojson blob from this endpoint>,
     *     is_buying_from_farmer: true
     *   }
     */
    async whimoPayload(req: Request, res: Response) {
        try {
            const { farmId } = req.params;

            const farm = await this.farmRepository.findOne({
                where: { id: farmId },
            });

            if (!farm) {
                return res.status(404).json({
                    success: false,
                    message: "Farm not found",
                });
            }

            const geometry = GeoIdService.normaliseGeometry(farm.location);
            const centroid = geometry ? GeoIdService.centroidFromGeometry(geometry) : null;

            if (!centroid) {
                return res.status(422).json({
                    success: false,
                    message: "Farm has no valid geometry for WHIMO pre-fill",
                });
            }

            // ── Commodity resolution ──────────────────────────────────────────
            const whimoSvc = getWhimoService();
            const commodityResolution = whimoSvc.resolveCommodity(farm.cropType);

            // ── Build full transaction payload via WhimoService ───────────────
            const transactionPayload = whimoSvc.buildTransactionPayload({
                farmId: farm.id,
                geoId: farm.geoId ?? null,
                cropType: farm.cropType ?? null,
                centroid,
                geojson: geometry,
                totalAreaHa: farm.totalAreaHa ?? null,
            });

            // ── Response ──────────────────────────────────────────────────────
            return res.status(200).json({
                success: true,
                data: {
                    // ── Ready-to-POST WHIMO transaction body ──────────────────
                    // Trader fills in `volume` then POSTs this to:
                    //   POST {WHIMO_API_BASE_URL}/transactions/producer
                    transaction_payload: transactionPayload,

                    // ── Commodity resolution metadata ─────────────────────────
                    commodity: commodityResolution
                        ? {
                            commodity_id: commodityResolution.commodity.commodityId,
                            eudr_annex_name: commodityResolution.commodity.eudrAnnexI,
                            hs_codes: commodityResolution.commodity.hsCodes,
                            confidence: commodityResolution.confidence,
                            note: commodityResolution.confidence === "exact"
                                ? "Commodity matched exactly — pre-fill commodity_id is reliable."
                                : "Commodity matched partially — please verify before submitting.",
                        }
                        : {
                            commodity_id: null,
                            eudr_annex_name: null,
                            hs_codes: [],
                            confidence: null,
                            note: "Could not auto-resolve crop type to an EUDR commodity — trader must select commodity_id manually in WHIMO.",
                        },

                    // ── GeoID / farm identity ─────────────────────────────────
                    geoid: farm.geoId ?? null,
                    geoid_uri: farm.geoIdUri ?? null,

                    // ── EUDR compliance snapshot ──────────────────────────────
                    risk_level: farm.riskLevel,
                    last_risk_assessment: farm.lastRiskAssessmentDate ?? null,

                    // ── Integration guide (for developer reference) ───────────
                    _integration: {
                        step1: "Use `transaction_payload` as the request body.",
                        step2: "Trader fills in `volume` (in kg or commodity unit).",
                        step3: "Verify `commodity.commodity_id` is correct for this crop.",
                        step4: `POST to: ${process.env.WHIMO_API_BASE_URL ?? "https://api.whimo.net/v1"}/transactions/producer`,
                        step5: "Store the returned transaction.id on the LACRA batch/shipment record.",
                        whimo_docs: "https://api.whimo.net/v1/docs",
                    },
                },
            });
        } catch (error: any) {
            console.error("[FarmScan] WHIMO payload error:", error);
            return res.status(500).json({
                success: false,
                message: "Error generating WHIMO payload",
                errors: [error.message],
            });
        }
    }

    /**
     * GET /api/public/farm-scan/whimo/commodities
     *
     * Returns the LACRA → WHIMO commodity map so the frontend admin page can
     * display it. Also triggers a live validation against the WHIMO API if
     * credentials are configured.
     *
     * Protected by the general public rate-limiter (see public.routes.ts).
     */
    async whimoCommodities(req: Request, res: Response) {
        try {
            const whimoSvc = getWhimoService();

            // List of crop types that exist in the DB — for dry-run validation
            const rawCropTypes: Array<{ cropType: string }> = await this.farmRepository
                .createQueryBuilder("farm")
                .select("DISTINCT farm.cropType", "cropType")
                .where("farm.cropType IS NOT NULL")
                .getRawMany();

            const uniqueCropTypes = rawCropTypes
                .map(r => r.cropType)
                .filter(Boolean);

            const dryRun = await whimoSvc.dryRunCommodityValidation(uniqueCropTypes);

            return res.status(200).json({
                success: true,
                data: {
                    whimo_reachable: dryRun.whimoReachable,
                    live_commodities: dryRun.liveCommodities,
                    validation_results: dryRun.results,
                    commodity_map_summary: {
                        total_lacra_crop_types: uniqueCropTypes.length,
                        resolved: dryRun.results.filter(r => r.resolved !== null).length,
                        unresolved: dryRun.results.filter(r => r.resolved === null).length,
                        exact_matches: dryRun.results.filter(r => r.resolved?.confidence === "exact").length,
                        partial_matches: dryRun.results.filter(r => r.resolved?.confidence === "partial").length,
                    },
                },
            });
        } catch (error: any) {
            console.error("[FarmScan] WHIMO commodities error:", error);
            return res.status(500).json({
                success: false,
                message: "Error fetching WHIMO commodity data",
                errors: [error.message],
            });
        }
    }
}
