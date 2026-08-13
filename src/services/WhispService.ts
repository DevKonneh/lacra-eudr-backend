import axios from "axios";

/**
 * Open Foris Whisp API integration.
 *
 * Whisp (https://whisp.openforis.org) is a FAO/Open Foris geospatial service built on
 * Google Earth Engine that returns satellite-derived EUDR (EU Deforestation Regulation)
 * risk indicators for a submitted plot polygon.
 *
 * Endpoint: POST {WHISP_API_URL}/submit/geojson
 * Auth: x-api-key header
 * Request body MUST be a full GeoJSON FeatureCollection (not a bare Feature array).
 * Response envelope: { code, message, cause?, data?, context?: { token } }
 *   - code === "analysis_completed" -> data.features[0].properties holds the real indicators (sync case)
 *   - code === "analysis_queued" | "analysis_processing" -> must poll GET /status/{token} using context.token
 *   - code starting with "validation_" / "auth_" / "system_" -> real error
 */

/** A single year with any measurable disturbance/loss/alert signal (ha), only non-zero years included. */
export interface WhispYearlyEvent {
    year: number;
    gfcLossHa?: number;      // Hansen/Global Forest Change tree-cover loss for that year
    tmfDeforestationHa?: number; // JRC Tropical Moist Forest - deforestation
    tmfDegradationHa?: number;   // JRC Tropical Moist Forest - degradation
    raddAlertHa?: number;    // RADD near-real-time disturbance alerts
    gladLAlertHa?: number;   // GLAD-Landsat alerts
    gladS2AlertHa?: number;  // GLAD-Sentinel2 alerts
}

/** Overlap (ha) between the plot and a specific commodity-risk dataset. */
export interface WhispCommodityOverlap {
    commodity: string;   // human readable, e.g. "Cocoa"
    datasetKey: string;  // raw Whisp field name, e.g. "Cocoa_FDaP"
    overlapHa: number;
}

/** Pre-computed EUDR compliance indicator flags returned directly by Whisp. */
export interface WhispIndicators {
    treecover?: 'yes' | 'no';
    commodities?: 'yes' | 'no';
    disturbanceBefore2020?: 'yes' | 'no';
    disturbanceAfter2020?: 'yes' | 'no';
    primary2020?: 'yes' | 'no';
    natRegForest2020?: 'yes' | 'no';
    plantedPlantations2020?: 'yes' | 'no';
    plantedPlantationsAfter2020?: 'yes' | 'no';
    treecoverAfter2020?: 'yes' | 'no';
    agriAfter2020?: 'yes' | 'no';
    loggingConcessionBefore2020?: 'yes' | 'no';
}

export type WhispRiskLabel = 'high' | 'low' | 'unknown';

export interface WhispAnalysisResult {
    resultId: string;           // Whisp job token (context.token) or plotId fallback
    plotId?: string;
    areaHa: number;              // Area (Whisp-computed, from satellite geometry)
    unit: string;                // Unit, typically "ha"
    country?: string;             // Country (ISO3)
    producerCountry?: string;     // ProducerCountry (ISO2)
    adminLevel1?: string;         // Admin_Level_1 (region/state)
    centroid?: { lon: number; lat: number };
    inWaterbody?: boolean;

    // --- Forest-cover baselines (ha overlap) ---
    eufo2020Ha: number;          // EUFO_2020: EU 2020 forest-cover baseline overlap - THE key EUDR deforestation indicator
    gfcTreeCover2020Ha?: number; // GFC_TC_2020
    esaTreeCover2020Ha?: number; // ESA_TC_2020
    forestFdapHa?: number;       // Forest_FDaP
    tmfUndisturbedHa?: number;   // TMF_undist

    // --- Annual disturbance/loss/alert timeline (only years with signal) ---
    annualEvents: WhispYearlyEvent[];

    // --- Commodity-specific overlap datasets (only non-zero entries) ---
    commodityOverlaps: WhispCommodityOverlap[];

    // --- Pre-computed EUDR indicator flags (Ind_01 .. Ind_11) ---
    indicators: WhispIndicators;

    // --- Pre-computed commodity-category risk classification ---
    riskPerennialCrop: WhispRiskLabel; // risk_pcrop
    riskAnnualCrop: WhispRiskLabel;    // risk_acrop
    riskTimber: WhispRiskLabel;       // risk_timber

    whispVersion?: string;
    processedAt?: string;

    /** Full raw properties object returned by Whisp, kept for completeness/debugging. */
    raw?: Record<string, any>;
}

/** Known commodity-overlap dataset fields -> human readable commodity name. */
const COMMODITY_FIELD_MAP: Record<string, string> = {
    Cocoa_FDaP: "Cocoa",
    Cocoa_ETH: "Cocoa",
    Cocoa_2024_FDaP: "Cocoa",
    Rubber_FDaP: "Rubber",
    Rubber_RBGE: "Rubber",
    Rubber_2024_FDaP: "Rubber",
    Oil_palm_Descals: "Oil palm",
    Oil_palm_FDaP: "Oil palm",
    Oil_palm_2024_FDaP: "Oil palm",
    Coffee_FDaP: "Coffee",
    Coffee_FDaP_2024: "Coffee",
    Soy_Song_2020: "Soy",
};

const YEAR_FIELD_PREFIXES: Array<{ key: keyof WhispYearlyEvent; prefix: string }> = [
    { key: "gfcLossHa", prefix: "GFC_loss_year_" },
    { key: "tmfDeforestationHa", prefix: "TMF_def_" },
    { key: "tmfDegradationHa", prefix: "TMF_deg_" },
    { key: "raddAlertHa", prefix: "RADD_year_" },
    { key: "gladLAlertHa", prefix: "GLAD-L_year_" },
    { key: "gladS2AlertHa", prefix: "GLAD-S2_year_" },
];

export class WhispService {
    private baseUrl = process.env.WHISP_API_URL || 'http://localhost:8000/api';
    private apiKey = process.env.WHISP_API_KEY;

    async analyzeFarm(farmId: string, geojson: any): Promise<WhispAnalysisResult | null> {
        if (!this.apiKey) {
            console.warn("Whisp API Key not configured. Using Mock Whisp Logic.");
            return this.mockAnalysis();
        }

        try {
            const payload = {
                type: "FeatureCollection",
                features: [{
                    type: "Feature",
                    geometry: geojson,
                    properties: { id: farmId }
                }],
                analysisOptions: {
                    unitType: "ha",
                    // Always request async processing rather than relying on the connection
                    // staying open for a synchronous response. Verified via live testing on
                    // 2026-08-13: a large/complex polygon submitted with async:false simply hung
                    // until our 30s axios timeout fired (a client-side read timeout, NOT a Whisp
                    // error) - meaning a legitimately large real farm polygon could be
                    // misclassified as a failed assessment purely because the HTTP request
                    // timed out, even though Earth Engine might have finished given more time.
                    // With async:true the submit call returns almost immediately (~0.5s) with a
                    // queued/processing token, and we control the wait via our own pollStatus()
                    // loop (now up to ~90s) instead of a single all-or-nothing HTTP timeout.
                    async: true
                }
            };

            const response = await axios.post(`${this.baseUrl}/submit/geojson`, payload, {
                headers: { 'x-api-key': this.apiKey, 'Content-Type': 'application/json' },
                timeout: 30000
            });

            let envelope = response.data;
            let jobToken: string | undefined = envelope?.data?.token || envelope?.context?.token;

            // Async fallback: some large/complex geometries (or a busy queue via
            // analysisOptions.async / analysis_too_many_concurrent backpressure) return a
            // queued/processing job instead of completing synchronously.
            // Poll the status endpoint until the analysis completes (or we give up).
            // NOTE: the job token is nested under `data.token` (with a companion `data.statusUrl`),
            // NOT under `context.token` - verified against a live analysis_queued response from
            // the real Whisp API on 2026-08-13. The previous `envelope?.context?.token` lookup
            // always evaluated to undefined, silently skipping pollStatus() entirely whenever a
            // queued/processing response was returned. The completed envelope returned by
            // /status/{token} does NOT itself repeat the token, so we must capture it here
            // (from the initial submit response) and carry it forward for the result mapping.
            if (envelope?.code === 'analysis_queued' || envelope?.code === 'analysis_processing') {
                if (jobToken) {
                    envelope = await this.pollStatus(jobToken);
                } else {
                    console.error("Whisp API returned a queued/processing response with no token to poll:", JSON.stringify(envelope).slice(0, 500));
                }
            }

            if (envelope?.code !== 'analysis_completed') {
                console.error("Whisp API did not complete analysis:", envelope?.code, envelope?.message, envelope?.cause);
                return null;
            }

            const feature = envelope?.data?.features?.[0];
            const properties = feature?.properties;
            if (!properties) {
                console.error("Whisp API response missing feature properties:", JSON.stringify(envelope).slice(0, 500));
                return null;
            }

            return this.mapWhispProperties(properties, jobToken);

        } catch (error: any) {
            const details = error.response?.data ? JSON.stringify(error.response.data) : error.message;
            console.error("Whisp API Error:", details);
            return null; // Let caller handle fallback or error
        }
    }

    /**
     * Poll GET /status/{token} until the job leaves the queued/processing state.
     * Default window increased to ~90s (30 attempts x 3000ms) based on live testing against
     * the real Whisp API on 2026-08-13: a large/complex 300-vertex test polygon spent 8+
     * seconds in analysis_processing before terminating (with a memory-limit error in that
     * particular case), while normal farm-sized polygons complete within a few seconds. The
     * previous 24s window (8 x 3000ms) was too short to safely cover legitimately large/complex
     * real farm polygons that don't hit resource limits and simply take longer to process.
     */
    private async pollStatus(token: string, maxAttempts = 30, delayMs = 3000): Promise<any> {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
            try {
                const statusResponse = await axios.get(`${this.baseUrl}/status/${token}`, {
                    headers: { 'x-api-key': this.apiKey as string },
                    timeout: 15000
                });
                const code = statusResponse.data?.code;
                if (code && code !== 'analysis_queued' && code !== 'analysis_processing') {
                    return statusResponse.data;
                }
            } catch (error: any) {
                console.error("Whisp status poll error:", error.message);
            }
        }
        console.error(`Whisp analysis for token ${token} did not complete after ${maxAttempts} polling attempts.`);
        return { code: 'analysis_timeout', message: 'Polling exhausted' };
    }

    /** Maps raw Whisp `properties` object into our structured WhispAnalysisResult. */
    private mapWhispProperties(props: Record<string, any>, token?: string): WhispAnalysisResult {
        const num = (v: any): number => (typeof v === 'number' ? v : 0);

        // Build annual disturbance/loss/alert timeline (only years with any non-zero signal)
        const yearMap = new Map<number, WhispYearlyEvent>();
        for (const { key, prefix } of YEAR_FIELD_PREFIXES) {
            for (const propKey of Object.keys(props)) {
                if (!propKey.startsWith(prefix)) continue;
                const yearStr = propKey.slice(prefix.length);
                const year = parseInt(yearStr, 10);
                if (isNaN(year)) continue;
                const value = num(props[propKey]);
                if (value <= 0) continue;
                const existing = yearMap.get(year) || { year };
                (existing as any)[key] = value;
                yearMap.set(year, existing);
            }
        }
        const annualEvents = Array.from(yearMap.values()).sort((a, b) => a.year - b.year);

        // Build commodity overlap list (only non-zero entries)
        const commodityOverlaps: WhispCommodityOverlap[] = [];
        for (const [fieldKey, commodityName] of Object.entries(COMMODITY_FIELD_MAP)) {
            const value = num(props[fieldKey]);
            if (value > 0) {
                commodityOverlaps.push({ commodity: commodityName, datasetKey: fieldKey, overlapHa: value });
            }
        }

        const indicators: WhispIndicators = {
            treecover: props.Ind_01_treecover,
            commodities: props.Ind_02_commodities,
            disturbanceBefore2020: props.Ind_03_disturbance_before_2020,
            disturbanceAfter2020: props.Ind_04_disturbance_after_2020,
            primary2020: props.Ind_05_primary_2020,
            natRegForest2020: props.Ind_06_nat_reg_forest_2020,
            plantedPlantations2020: props.Ind_07_planted_plantations_2020,
            plantedPlantationsAfter2020: props.Ind_08_planted_plantations_after_2020,
            treecoverAfter2020: props.Ind_09_treecover_after_2020,
            agriAfter2020: props.Ind_10_agri_after_2020,
            loggingConcessionBefore2020: props.Ind_11_logging_concession_before_2020,
        };

        return {
            resultId: token || props.plotId || `WHISP-${Date.now()}`,
            plotId: props.plotId,
            areaHa: num(props.Area),
            unit: props.Unit || "ha",
            country: props.Country,
            producerCountry: props.ProducerCountry,
            adminLevel1: props.Admin_Level_1,
            centroid: (props.Centroid_lon != null && props.Centroid_lat != null)
                ? { lon: props.Centroid_lon, lat: props.Centroid_lat }
                : undefined,
            inWaterbody: props.In_waterbody,

            eufo2020Ha: num(props.EUFO_2020),
            gfcTreeCover2020Ha: num(props.GFC_TC_2020),
            esaTreeCover2020Ha: num(props.ESA_TC_2020),
            forestFdapHa: num(props.Forest_FDaP),
            tmfUndisturbedHa: num(props.TMF_undist),

            annualEvents,
            commodityOverlaps,
            indicators,

            riskPerennialCrop: (props.risk_pcrop as WhispRiskLabel) || 'unknown',
            riskAnnualCrop: (props.risk_acrop as WhispRiskLabel) || 'unknown',
            riskTimber: (props.risk_timber as WhispRiskLabel) || 'unknown',

            whispVersion: props.whisp_processing_metadata?.whisp_version,
            processedAt: props.whisp_processing_metadata?.processing_timestamp_utc,

            raw: props,
        };
    }

    /** Used only when WHISP_API_KEY is not configured, so local dev/testing doesn't hard-fail. */
    private mockAnalysis(): WhispAnalysisResult {
        const isHighRisk = Math.random() > 0.8;
        return {
            resultId: `MOCK-WHISP-${Date.now()}`,
            areaHa: 1,
            unit: "ha",
            eufo2020Ha: isHighRisk ? 1 : 0,
            annualEvents: isHighRisk ? [{ year: 2024, gfcLossHa: 0.1 }] : [],
            commodityOverlaps: [{ commodity: "Cocoa", datasetKey: "Cocoa_FDaP", overlapHa: 1 }],
            indicators: {},
            riskPerennialCrop: isHighRisk ? 'high' : 'low',
            riskAnnualCrop: 'unknown',
            riskTimber: 'unknown',
            raw: { mock: true },
        };
    }
}
