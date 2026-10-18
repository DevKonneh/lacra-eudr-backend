/**
 * WhimoService — LACRA ↔ WHIMO deep integration
 *
 * WHIMO (Worldwide Harmonised Import/Export Management and Operations) is the
 * EU-designated platform for EUDR due-diligence statements. When a trader buys
 * a commodity from a LACRA-registered farmer, they create a "Producer
 * Transaction" in WHIMO. This service handles:
 *
 *  1. Commodity mapping — translates LACRA's free-text crop types to WHIMO's
 *     numeric commodity_id values (as defined in the EUDR Annex I + HS codes).
 *
 *  2. Transaction pre-fill — builds the exact TransactionProducerCreateRequest
 *     body that a trader's WHIMO client app needs to POST to WHIMO's API,
 *     using the farm's GeoID, centroid and GeoJSON polygon.
 *
 *  3. Transaction submission (optional / LACRA-org scoped) — when LACRA's own
 *     WHIMO organisation credentials are configured, the service can submit
 *     transactions on behalf of registered operator-traders.
 *
 *  4. Integration health-check — verifies that the WHIMO API is reachable and
 *     that our org credentials are valid.
 *
 * ── Environment variables ────────────────────────────────────────────────────
 *
 *   WHIMO_API_BASE_URL     WHIMO REST API base (default: https://api.whimo.net/v1)
 *   WHIMO_API_KEY          API key issued to LACRA's WHIMO organisation account
 *   WHIMO_ORG_ID           LACRA's organisation identifier within WHIMO
 *
 * ── WHIMO API reference (as of 2025) ────────────────────────────────────────
 *
 *   POST /transactions/producer
 *     Create a producer (farm-level) transaction
 *     Body: TransactionProducerCreateRequest
 *
 *   GET  /commodities
 *     List all EUDR-covered commodities with their IDs
 *
 *   GET  /health
 *     API health check
 *
 * ── Commodity IDs ────────────────────────────────────────────────────────────
 *
 * WHIMO uses numeric IDs for the 7 EUDR-covered commodities plus their main
 * processed derivatives. The mapping below is based on the EUDR Annex I and
 * WHIMO's published commodity list (2025 edition). IDs are best-effort and
 * should be confirmed against the live /commodities endpoint once LACRA has
 * an active WHIMO organisation account.
 *
 * ── Note on LACRA's primary commodities ─────────────────────────────────────
 *
 * Liberia's EUDR-relevant exports (registered through LACRA) are primarily:
 *   • Cocoa (cacao beans, paste, butter, powder, chocolate)
 *   • Coffee (green/roasted beans, extract)
 *   • Rubber (natural rubber, latex)
 *   • Palm oil (CPO, palm kernel oil, olein, stearin)
 *   • Wood / timber
 *
 * All are covered by EUDR Annex I and must have a WHIMO due-diligence
 * statement before export to the EU.
 */

import axios, { AxiosInstance } from "axios";

// ─── Commodity mapping ────────────────────────────────────────────────────────

/**
 * EUDR commodity IDs as used by WHIMO.
 *
 * Source: EUDR Annex I (Regulation (EU) 2023/1115) + WHIMO API commodity list.
 * Numeric IDs are WHIMO-internal; the HS codes are the global reference.
 *
 * FORMAT:
 *   commodityId   — WHIMO numeric ID (confirm against GET /commodities)
 *   eudrAnnexI    — Annex I reference commodity name
 *   hsCodes       — Relevant HS-2022 codes (6-digit prefix)
 *   aliases       — Lower-cased strings that map to this commodity from LACRA
 */
export interface WhimoCommodity {
    commodityId: number;
    eudrAnnexI: string;
    hsCodes: string[];
    aliases: string[];
}

export const WHIMO_COMMODITIES: WhimoCommodity[] = [
    // ── Cocoa ─────────────────────────────────────────────────────────────────
    {
        commodityId: 1,
        eudrAnnexI: "Cocoa",
        hsCodes: ["1801", "1802", "1803", "1804", "1805", "1806"],
        aliases: ["cocoa", "cacao", "cocoa beans", "cacao beans", "cocoa paste",
                  "cocoa butter", "cocoa powder", "chocolate"],
    },
    // ── Coffee ────────────────────────────────────────────────────────────────
    {
        commodityId: 2,
        eudrAnnexI: "Coffee",
        hsCodes: ["0901", "2101"],
        aliases: ["coffee", "coffee beans", "arabica", "robusta", "liberica",
                  "green coffee", "roasted coffee", "coffee extract"],
    },
    // ── Palm oil ──────────────────────────────────────────────────────────────
    {
        commodityId: 3,
        eudrAnnexI: "Palm oil",
        hsCodes: ["1511", "1513"],
        aliases: ["palm oil", "palm", "cpo", "crude palm oil", "palm kernel oil",
                  "pko", "palm olein", "palm stearin", "rbd palm oil",
                  "palm kernel", "oil palm"],
    },
    // ── Soya ─────────────────────────────────────────────────────────────────
    {
        commodityId: 4,
        eudrAnnexI: "Soya",
        hsCodes: ["1201", "1208", "1507", "2304"],
        aliases: ["soya", "soy", "soybean", "soybeans", "soya bean",
                  "soybean oil", "soya oil", "soy meal", "soybean cake"],
    },
    // ── Rubber ───────────────────────────────────────────────────────────────
    {
        commodityId: 5,
        eudrAnnexI: "Natural rubber",
        hsCodes: ["4001", "4002", "4005", "4006", "4007", "4008"],
        aliases: ["rubber", "natural rubber", "latex", "rubber latex",
                  "hevea", "hevea brasiliensis", "smoked rubber sheet",
                  "technically specified rubber", "tsr", "rss"],
    },
    // ── Cattle ───────────────────────────────────────────────────────────────
    {
        commodityId: 6,
        eudrAnnexI: "Cattle",
        hsCodes: ["0102", "0201", "0202", "0206", "0210", "4101", "4104", "4107"],
        aliases: ["cattle", "beef", "cow", "livestock", "bovine",
                  "hide", "leather", "beef leather"],
    },
    // ── Wood ─────────────────────────────────────────────────────────────────
    {
        commodityId: 7,
        eudrAnnexI: "Wood",
        hsCodes: ["4403", "4406", "4407", "4408", "4409", "4410", "4411",
                  "4412", "4413", "4415", "4416", "4418", "9401", "9403"],
        aliases: ["wood", "timber", "logs", "lumber", "sawn wood", "plywood",
                  "veneer", "hardwood", "softwood", "fuelwood", "charcoal",
                  "wood charcoal", "furniture"],
    },
];

// ── Lookup helper ─────────────────────────────────────────────────────────────

/**
 * Resolve a LACRA free-text crop type to the closest WHIMO commodity.
 *
 * Matching rules (in priority order):
 *  1. Exact alias match (case-insensitive, trimmed)
 *  2. Alias starts-with the crop type
 *  3. Crop type is a substring of an alias
 *  4. Returns null when no match is found (trader must select manually)
 *
 * @param lacracroCropType   Raw cropType string from FarmRecord (e.g. "Cocoa Beans")
 * @returns                  Matched WhimoCommodity, or null
 */
export function resolveCommodity(lacracroCropType: string | null | undefined): WhimoCommodity | null {
    if (!lacracroCropType) return null;

    const normalised = lacracroCropType.trim().toLowerCase();

    // Pass 1 — exact alias match
    for (const commodity of WHIMO_COMMODITIES) {
        if (commodity.aliases.includes(normalised)) return commodity;
    }

    // Pass 2 — alias starts with crop type
    for (const commodity of WHIMO_COMMODITIES) {
        if (commodity.aliases.some(a => a.startsWith(normalised))) return commodity;
    }

    // Pass 3 — crop type is a substring of an alias
    for (const commodity of WHIMO_COMMODITIES) {
        if (commodity.aliases.some(a => a.includes(normalised) || normalised.includes(a.split(" ")[0]))) {
            return commodity;
        }
    }

    return null;
}

// ─── WHIMO API types ──────────────────────────────────────────────────────────

/**
 * WHIMO TransactionLocation enum values (as of WHIMO API v1, 2025).
 * "qr" is the value LACRA always uses — it means the location was captured
 * by scanning a QR code whose data-URL includes a GeoJSON polygon.
 */
export type WhimoTransactionLocation = "qr" | "gps" | "manual";

/**
 * Matches WHIMO's TransactionProducerCreateRequest body schema.
 * Field names must exactly match the WHIMO API spec (snake_case).
 */
export interface WhimoTransactionProducerCreateRequest {
    /** WHIMO commodity ID (from GET /commodities). Required. */
    commodity_id: number;
    /** Volume traded, in the commodity's default unit (kg for most). Required. */
    volume: number;
    /** Centroid latitude of the farm polygon. */
    farm_latitude: number;
    /** Centroid longitude of the farm polygon. */
    farm_longitude: number;
    /** How the farm location was captured. Always "qr" for LACRA QR scans. */
    location: WhimoTransactionLocation;
    /**
     * GeoJSON FeatureCollection representing the farm polygon.
     * Uploaded as the location_file. WHIMO stores this for EUDR due diligence.
     */
    location_file: Record<string, unknown> | null;
    /** Always true for LACRA — we buy direct from registered farmers. */
    is_buying_from_farmer: boolean;
    /** Optional: LACRA's WHIMO organisation ID (injected by backend). */
    operator_id?: string;
    /** Optional: FAO GeoID for traceability cross-reference. Not a WHIMO field;
     *  stored in the transaction's notes/metadata if WHIMO supports it. */
    notes?: string;
}

/**
 * WHIMO transaction creation response (successful 201).
 */
export interface WhimoTransactionResponse {
    id: string;
    status: "pending" | "submitted" | "approved" | "rejected";
    commodity_id: number;
    created_at: string;
    due_diligence_statement_id?: string;
}

/**
 * WHIMO commodity list item (from GET /commodities).
 */
export interface WhimoCommodityApiItem {
    id: number;
    name: string;
    hs_codes: string[];
    eudr_annex: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class WhimoService {
    private client: AxiosInstance;
    private baseUrl: string;
    private orgId: string | null;

    constructor() {
        this.baseUrl = (process.env.WHIMO_API_BASE_URL ?? "https://api.whimo.net/v1")
            .trim()
            .replace(/\/$/, "");

        this.orgId = process.env.WHIMO_ORG_ID?.trim() || null;

        const apiKey = process.env.WHIMO_API_KEY?.trim();

        this.client = axios.create({
            baseURL: this.baseUrl,
            timeout: 20_000,
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                ...(this.orgId ? { "X-Org-Id": this.orgId } : {}),
            },
        });
    }

    // ── Commodity resolution ─────────────────────────────────────────────────

    /**
     * Resolve a LACRA crop type to a WHIMO commodity (local lookup — no API call).
     * Returns { commodityId, eudrAnnexI, confidence } or null.
     *
     * "confidence" is:
     *   "exact"    — alias matched exactly
     *   "partial"  — substring/prefix match
     *   null       — no match
     */
    resolveCommodity(cropType: string | null | undefined): {
        commodity: WhimoCommodity;
        confidence: "exact" | "partial";
    } | null {
        if (!cropType) return null;

        const normalised = cropType.trim().toLowerCase();

        for (const commodity of WHIMO_COMMODITIES) {
            if (commodity.aliases.includes(normalised)) {
                return { commodity, confidence: "exact" };
            }
        }

        for (const commodity of WHIMO_COMMODITIES) {
            if (commodity.aliases.some(a => a.startsWith(normalised) || normalised.startsWith(a.split(" ")[0]))) {
                return { commodity, confidence: "partial" };
            }
        }

        for (const commodity of WHIMO_COMMODITIES) {
            if (commodity.aliases.some(a => a.includes(normalised) || normalised.includes(a.split(" ")[0]))) {
                return { commodity, confidence: "partial" };
            }
        }

        return null;
    }

    /**
     * Build the full WhimoTransactionProducerCreateRequest payload for a farm.
     *
     * This is what a trader's WHIMO client app POSTs to:
     *   POST {WHIMO_API_BASE_URL}/transactions/producer
     *
     * Volume must be supplied by the trader (LACRA does not know the traded
     * quantity); a placeholder of 0 is used so the trader only needs to fill
     * in the volume before submitting.
     *
     * Returns null when the farm has no valid centroid (geometry missing or
     * malformed) — the caller should surface an error to the trader.
     */
    buildTransactionPayload(params: {
        farmId: string;
        geoId: string | null;
        cropType: string | null;
        centroid: { lat: number; lng: number } | null;
        geojson: Record<string, unknown> | null;
        totalAreaHa: number | null;
    }): WhimoTransactionProducerCreateRequest | null {
        if (!params.centroid) return null;

        const resolved = this.resolveCommodity(params.cropType);

        // GeoJSON FeatureCollection for location_file
        const locationFile = params.geojson
            ? {
                type: "FeatureCollection",
                features: [
                    {
                        type: "Feature",
                        id: params.geoId ?? params.farmId,
                        geometry: params.geojson,
                        properties: {
                            // Only non-PII properties safe to include
                            producer_name: null,
                            producer_country: "LR",  // Liberia ISO 3166-1 alpha-2
                            production_place: null,
                            geoid: params.geoId ?? null,
                            crop_type: params.cropType ?? null,
                            area_ha: params.totalAreaHa ?? null,
                        },
                    },
                ],
            }
            : null;

        const notes = [
            params.geoId ? `FAO GeoID: ${params.geoId}` : null,
            `LACRA Farm ID: ${params.farmId}`,
            resolved ? `Commodity auto-resolved (${resolved.confidence})` : "Commodity not auto-resolved — please select manually",
        ].filter(Boolean).join(" | ");

        return {
            commodity_id: resolved?.commodity.commodityId ?? 0,  // 0 = trader must select
            volume: 0,   // Trader fills in at transaction time
            farm_latitude: params.centroid.lat,
            farm_longitude: params.centroid.lng,
            location: "qr",
            location_file: locationFile,
            is_buying_from_farmer: true,
            ...(this.orgId ? { operator_id: this.orgId } : {}),
            notes,
        };
    }

    // ── WHIMO API calls ──────────────────────────────────────────────────────

    /**
     * Fetch the live commodity list from WHIMO.
     * Use this to verify or update the commodity IDs in WHIMO_COMMODITIES.
     *
     * Requires WHIMO_API_KEY to be set.
     */
    async getCommodities(): Promise<WhimoCommodityApiItem[]> {
        const res = await this.client.get<WhimoCommodityApiItem[]>("/commodities");
        return res.data;
    }

    /**
     * Submit a Producer Transaction to WHIMO on behalf of a trader.
     *
     * ⚠️  This creates a real EUDR due-diligence record in WHIMO.
     *     Only call when LACRA is acting as the operator and the trader has
     *     explicitly authorised LACRA to submit on their behalf.
     *
     * Requires WHIMO_API_KEY and WHIMO_ORG_ID to be set.
     */
    async submitProducerTransaction(
        payload: WhimoTransactionProducerCreateRequest,
    ): Promise<WhimoTransactionResponse> {
        if (!process.env.WHIMO_API_KEY) {
            throw new Error("WHIMO_API_KEY not configured — cannot submit transaction");
        }
        const res = await this.client.post<WhimoTransactionResponse>(
            "/transactions/producer",
            payload,
        );
        return res.data;
    }

    /**
     * Health check — verifies that the WHIMO API is reachable.
     * Returns true when reachable, false otherwise (network error, down, etc.).
     */
    async isHealthy(): Promise<boolean> {
        try {
            const res = await this.client.get("/health", { timeout: 5_000 });
            return res.status === 200;
        } catch {
            return false;
        }
    }

    /**
     * Dry-run integration test — validates our commodity map against the
     * live WHIMO commodity list (without creating any real transactions).
     *
     * Returns a report of matches, mismatches and unmapped LACRA crop types.
     * Run this from the GeoID admin page or as a one-off CLI task.
     */
    async dryRunCommodityValidation(lacracroCropTypes: string[]): Promise<{
        whimoReachable: boolean;
        liveCommodities: WhimoCommodityApiItem[] | null;
        results: Array<{
            lacra: string;
            resolved: { commodityId: number; eudrAnnexI: string; confidence: string } | null;
            liveMatch: boolean | null;
        }>;
    }> {
        let whimoReachable = false;
        let liveCommodities: WhimoCommodityApiItem[] | null = null;

        try {
            liveCommodities = await this.getCommodities();
            whimoReachable = true;
        } catch {
            whimoReachable = false;
        }

        const results = lacracroCropTypes.map(cropType => {
            const resolved = this.resolveCommodity(cropType);

            let liveMatch: boolean | null = null;
            if (resolved && liveCommodities) {
                liveMatch = liveCommodities.some(c => c.id === resolved.commodity.commodityId);
            }

            return {
                lacra: cropType,
                resolved: resolved
                    ? {
                        commodityId: resolved.commodity.commodityId,
                        eudrAnnexI: resolved.commodity.eudrAnnexI,
                        confidence: resolved.confidence,
                    }
                    : null,
                liveMatch,
            };
        });

        return { whimoReachable, liveCommodities, results };
    }
}

// Singleton
let _instance: WhimoService | null = null;
export function getWhimoService(): WhimoService {
    if (!_instance) _instance = new WhimoService();
    return _instance;
}
