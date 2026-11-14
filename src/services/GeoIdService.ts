/**
 * GeoIdService — FAO OpenForis GeoID API integration
 *
 * GeoID converts a GeoJSON geometry (Point or Polygon) into a globally unique,
 * stable, anonymous identifier (UUIDv8). The same geometry ALWAYS produces the
 * same GeoID (content-addressed), making it safe to share across systems
 * (WHIMO, EUDR auditors, downstream traders) without exposing raw coordinates
 * or farmer PII.
 *
 * API base (staging):    https://data.review.fao.org/geoid
 * API base (production): https://data.fao.org/geoid
 * Docs:                  {GEOID_BASE_URL}/docs
 *
 * The four core operations (mint, bulk-mint, resolve, bulk-resolve) are
 * currently public — no auth token required — per the FAO API spec.
 * When GEOID_COLLECTION_ID is set we register to that named collection
 * (recommended for production); when unset we fall back to the public
 * anonymous collection via /items (no collection scoping).
 */

import axios, { AxiosInstance } from 'axios';
import * as turf from '@turf/turf';
import QRCode from 'qrcode';

// ─── Types mirrored from the FAO openapi.json ────────────────────────────────

export interface MintResponse {
    geoid: string;       // UUIDv8, content-addressed from the geometry
    uri: string;         // Durable resolver URI, e.g. https://data.fao.org/geoid/<uuid>
    external_id?: string | null;
}

export interface BulkAccepted {
    index: number;
    geoid: string;
    uri: string;
    external_id?: string | null;
}

export interface BulkRejected {
    index: number;
    reason: string;
    detail?: string | null;
    external_id?: string | null;
}

export interface BulkReport {
    summary: { received: number; accepted: number; rejected: number };
    accepted?: BulkAccepted[];
    rejected?: BulkRejected[];
}

export interface GeoIdFeature {
    type: 'Feature';
    id: string;         // The geoid itself
    geometry: Record<string, unknown> | null;
    properties?: Record<string, unknown> | null;
}

export interface ResolveResponse {
    type: 'FeatureCollection';
    features: GeoIdFeature[];
    not_found: string[];
}

// ─── Result types for our callers ────────────────────────────────────────────

export interface MintResult {
    geoid: string;
    uri: string;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class GeoIdService {
    private client: AxiosInstance;
    private baseUrl: string;
    /** Named collection ID (e.g. "lacra-farms"). Null → public /items route. */
    private collectionId: string | null;

    constructor() {
        this.baseUrl = (process.env.GEOID_BASE_URL ?? 'https://data.review.fao.org/geoid')
            .trim()
            .replace(/\/$/, '');

        this.collectionId = process.env.GEOID_COLLECTION_ID?.trim() || null;

        this.client = axios.create({
            baseURL: this.baseUrl,
            timeout: 15_000,
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
        });

        // Attach bearer token when provided (for named-collection writes)
        const token = process.env.GEOID_API_TOKEN?.trim();
        if (token) {
            this.client.defaults.headers.common['Authorization'] = `Bearer ${token}`;
        }
    }

    // ─── Mint ────────────────────────────────────────────────────────────────

    /**
     * Mint a GeoID for a single farm geometry.
     *
     * @param geometry   GeoJSON geometry object (Point or Polygon from Farm.location)
     * @param externalId Optional stable identifier to attach (we use Farm UUID)
     *
     * The mint is idempotent: submitting the same geometry twice always returns
     * the same GeoID. No PII is ever sent — only the raw geometry.
     */
    async mintGeoId(
        geometry: Record<string, unknown>,
        externalId?: string,
    ): Promise<MintResult> {
        const feature: Record<string, unknown> = {
            type: 'Feature',
            geometry,
            properties: null,
            ...(externalId ? { id: externalId } : {}),
        };

        try {
            if (this.collectionId) {
                // Named collection route (production / recommended)
                const url = `/collections/${encodeURIComponent(this.collectionId)}/items`;
                const res = await this.client.post<MintResponse>(url, feature);
                return { geoid: res.data.geoid, uri: res.data.uri };
            } else {
                // Public anonymous route (no auth, no collection)
                const res = await this.client.post<MintResponse>('/items', feature);
                return { geoid: res.data.geoid, uri: res.data.uri };
            }
        } catch (err: any) {
            const detail = err?.response?.data?.detail ?? err?.response?.data?.message ?? err.message;
            throw new Error(`GeoID mint failed: ${detail}`);
        }
    }

    /**
     * Mint GeoIDs for multiple features at once (bulk endpoint).
     * Returns one geoid per accepted feature.
     */
    async mintBulk(
        features: Array<{ geometry: Record<string, unknown>; externalId?: string }>,
    ): Promise<MintResult[]> {
        const featureCollection = {
            type: 'FeatureCollection',
            features: features.map(f => ({
                type: 'Feature',
                geometry: f.geometry,
                properties: null,
                ...(f.externalId ? { id: f.externalId } : {}),
            })),
        };

        try {
            let data: BulkReport;
            if (this.collectionId) {
                const url = `/collections/${encodeURIComponent(this.collectionId)}/items/bulk`;
                const res = await this.client.post<BulkReport>(url, featureCollection);
                data = res.data;
            } else {
                const res = await this.client.post<BulkReport>('/items/bulk', featureCollection);
                data = res.data;
            }

            if (!data.accepted || data.accepted.length === 0) {
                const reason = data.rejected?.[0]?.detail ?? data.rejected?.[0]?.reason ?? 'Unknown error';
                throw new Error(`GeoID bulk mint: no features accepted. Reason: ${reason}`);
            }

            return data.accepted.map(a => ({ geoid: a.geoid, uri: a.uri }));
        } catch (err: any) {
            if (err.message.startsWith('GeoID bulk mint:')) throw err;
            const detail = err?.response?.data?.detail ?? err?.response?.data?.message ?? err.message;
            throw new Error(`GeoID bulk mint failed: ${detail}`);
        }
    }

    // ─── Resolve ─────────────────────────────────────────────────────────────

    /**
     * Resolve a single GeoID back to its GeoJSON Feature.
     * Useful for verifying a stored GeoID or fetching geometry on-demand.
     */
    async resolveGeoId(geoid: string): Promise<GeoIdFeature> {
        try {
            const res = await this.client.get<GeoIdFeature>(
                `/${encodeURIComponent(geoid)}`,
                { headers: { Accept: 'application/geo+json, application/json' } },
            );
            return res.data;
        } catch (err: any) {
            const detail = err?.response?.data?.detail ?? err?.response?.data?.message ?? err.message;
            throw new Error(`GeoID resolve failed for ${geoid}: ${detail}`);
        }
    }

    /**
     * Resolve multiple GeoIDs at once (bulk resolve endpoint).
     * Returns a GeoJSON FeatureCollection plus a list of not-found IDs.
     */
    async resolveBulk(geoids: string[]): Promise<ResolveResponse> {
        try {
            const res = await this.client.post<ResolveResponse>('/resolve', { geoids });
            return res.data;
        } catch (err: any) {
            const detail = err?.response?.data?.detail ?? err?.response?.data?.message ?? err.message;
            throw new Error(`GeoID bulk resolve failed: ${detail}`);
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /**
     * Extract the centroid {lat, lng} from a stored Farm.location geometry.
     * Farm.location can be a Point or a Polygon (GeoJSON geometry object).
     */
    static centroidFromGeometry(geometry: Record<string, unknown>): { lat: number; lng: number } | null {
        try {
            const feature = turf.feature(geometry as any);
            const centroid = turf.centroid(feature as any);
            const [lng, lat] = centroid.geometry.coordinates;
            return { lat, lng };
        } catch {
            return null;
        }
    }

    /**
     * Convert Farm.location (geometry stored in PostGIS) to a clean GeoJSON
     * geometry object. PostGIS sometimes returns the geometry as a nested
     * object; this normalises it to a plain GeoJSON geometry.
     */
    static normaliseGeometry(location: unknown): Record<string, unknown> | null {
        if (!location || typeof location !== 'object') return null;
        const loc = location as Record<string, unknown>;

        // Already a valid GeoJSON geometry
        if (typeof loc.type === 'string' && loc.coordinates) return loc;

        // Geometry wrapped in a Feature
        if (loc.type === 'Feature' && loc.geometry) {
            return loc.geometry as Record<string, unknown>;
        }

        return null;
    }

    /**
     * Build the public farm-scan URL. Still used by LACRA's own tooling
     * (admin panel "Add Farm to Existing Farmer" lookups, CSV exports) to
     * cross-reference a farm back to our own system — but NOTE this URL is
     * no longer what gets encoded into Farm.farmQrCode (see
     * buildFarmGeoJsonFeature below). WHIMO's own open-source scanner
     * (EuropeanForestInstitute/whimo-android, QrScanViewModel.kt) reads the
     * raw QR text and runs it straight through a GeoJSON parser — it never
     * makes an HTTP request against a scanned URL at all, and rejects
     * anything that isn't itself valid GeoJSON with "QR code must contain
     * GeoJSON data" (FAO GeoID resolution is not implemented on their side
     * yet). A URL-only QR will always fail that check, regardless of what
     * our backend would have returned if it had been fetched.
     */
    static farmScanUrl(farmId: string): string {
        const base = (process.env.API_BASE_URL ?? process.env.FRONTEND_URL ?? 'http://localhost:3000')
            .trim()
            .replace(/\/$/, '');
        return `${base}/api/public/farm-scan/${farmId}`;
    }

    /**
     * Build the single-farm GeoJSON Feature that gets encoded (as raw JSON
     * text, not a URL) into Farm.farmQrCode — this is what WHIMO's QR
     * scanner (see farmScanUrl's note above) actually needs: a Feature
     * whose `geometry` it can hand straight to its GeoJsonParser, with our
     * GeoID + compliance attributes riding along in `properties` (WHIMO's
     * parser tolerates and ignores extra/unknown fields — confirmed from
     * its own unit tests). No farmer PII anywhere in this payload.
     */
    static buildFarmGeoJsonFeature(farm: {
        id: string;
        geoId?: string | null;
        cropType?: string | null;
        totalAreaHa?: number | null;
        riskLevel?: string | null;
        location: unknown;
    }): Record<string, unknown> | null {
        const geometry = GeoIdService.normaliseGeometry(farm.location);
        if (!geometry) return null;
        return {
            type: 'Feature',
            id: farm.geoId ?? farm.id,
            geometry,
            properties: {
                farmId: farm.id,
                geoId: farm.geoId ?? null,
                cropType: farm.cropType ?? null,
                totalAreaHa: farm.totalAreaHa ?? null,
                riskLevel: farm.riskLevel ?? null,
            },
        };
    }

    /**
     * Build the GeoJSON FeatureCollection that gets encoded into
     * Farmer.qrCode (the ID-card QR) — one Feature per registered farm, so
     * WHIMO's scanner (see farmScanUrl's note above) finds real GeoJSON
     * the moment it reads the card, regardless of which of the farmer's
     * farms a trader is actually transacting against. `farmerId` and
     * `profileUrl` ride at the collection root purely for LACRA's own
     * tooling (search-by-QR, internal app routing) — WHIMO's parser
     * ignores unrecognised root fields.
     */
    static buildFarmerGeoJsonFeatureCollection(farmer: {
        id: string;
        farmerId?: string | null;
        farms: Array<{
            id: string;
            geoId?: string | null;
            cropType?: string | null;
            totalAreaHa?: number | null;
            riskLevel?: string | null;
            location: unknown;
        }>;
    }, profileUrl: string): Record<string, unknown> {
        const features = (farmer.farms || [])
            .map((f) => GeoIdService.buildFarmGeoJsonFeature(f))
            .filter((f): f is Record<string, unknown> => f !== null);
        return {
            type: 'FeatureCollection',
            farmerId: farmer.farmerId ?? null,
            profileUrl,
            features,
        };
    }

    /**
     * Render a QR data-URL for a GeoJSON payload, with a graceful,
     * multi-tier fallback for farmers/farms whose geometry (or sheer number
     * of farms) is too large to fit in a scannable QR code:
     *   1. Full geometry, as given.
     *   2. `simplify()` — each farm's geometry collapsed to its centroid
     *      Point (still valid, still parseable GeoJSON, just lower
     *      precision).
     *   3. If that STILL doesn't fit (e.g. a farmer with a large number of
     *      farms, even at centroid resolution — confirmed possible via
     *      direct testing of the `qrcode` library's ~2953-byte hard cap at
     *      error-correction level L), and the payload is a
     *      FeatureCollection, progressively drop the last feature(s) from
     *      the array (keeping type/farmerId/profileUrl intact) until it
     *      fits. A farmer's ID-card QR always encodes AT LEAST one of
     *      their farms this way rather than failing outright; the farmer's
     *      full farm list remains available via profileUrl/farmerId for
     *      LACRA's own tooling regardless of how many features the QR
     *      itself could fit.
     */
    static async encodeGeoJsonQr(
        geojson: Record<string, unknown>,
        simplify: () => Record<string, unknown>,
    ): Promise<string> {
        try {
            return await QRCode.toDataURL(JSON.stringify(geojson), { errorCorrectionLevel: 'L' });
        } catch (err: any) {
            console.warn(`[GeoID] Full-resolution QR too large, falling back to centroid-only: ${err.message}`);
            const simplified = simplify();
            try {
                return await QRCode.toDataURL(JSON.stringify(simplified), { errorCorrectionLevel: 'L' });
            } catch (err2: any) {
                const features = (simplified as any)?.features;
                if (simplified.type !== 'FeatureCollection' || !Array.isArray(features) || features.length === 0) {
                    throw err2;
                }
                console.warn(`[GeoID] Centroid-only QR still too large (${features.length} features), truncating: ${err2.message}`);
                let truncated = { ...simplified, features: [...features] } as { features: unknown[] } & Record<string, unknown>;
                while (truncated.features.length > 1) {
                    truncated = { ...truncated, features: truncated.features.slice(0, -1) };
                    try {
                        return await QRCode.toDataURL(JSON.stringify(truncated), { errorCorrectionLevel: 'L' });
                    } catch {
                        // keep truncating
                    }
                }
                // Last resort: a single feature plus the collection root fields.
                return QRCode.toDataURL(JSON.stringify(truncated), { errorCorrectionLevel: 'L' });
            }
        }
    }

    /**
     * Centroid-only fallback for a single farm Feature (Point geometry
     * instead of the full Polygon) — used by encodeGeoJsonQr when the
     * full-resolution payload doesn't fit in a QR code.
     */
    static buildFarmGeoJsonFeatureCentroidOnly(farm: {
        id: string;
        geoId?: string | null;
        cropType?: string | null;
        totalAreaHa?: number | null;
        riskLevel?: string | null;
        location: unknown;
    }): Record<string, unknown> | null {
        const geometry = GeoIdService.normaliseGeometry(farm.location);
        const centroid = geometry ? GeoIdService.centroidFromGeometry(geometry) : null;
        if (!centroid) return null;
        return {
            type: 'Feature',
            id: farm.geoId ?? farm.id,
            geometry: { type: 'Point', coordinates: [centroid.lng, centroid.lat] },
            properties: {
                farmId: farm.id,
                geoId: farm.geoId ?? null,
                cropType: farm.cropType ?? null,
                totalAreaHa: farm.totalAreaHa ?? null,
                riskLevel: farm.riskLevel ?? null,
                simplified: true,
            },
        };
    }

    /**
     * Centroid-only fallback FeatureCollection for a farmer's ID card QR —
     * used by encodeGeoJsonQr when the full-resolution FeatureCollection
     * doesn't fit in a QR code.
     */
    static buildFarmerGeoJsonFeatureCollectionCentroidOnly(farmer: {
        id: string;
        farmerId?: string | null;
        farms: Array<{
            id: string;
            geoId?: string | null;
            cropType?: string | null;
            totalAreaHa?: number | null;
            riskLevel?: string | null;
            location: unknown;
        }>;
    }, profileUrl: string): Record<string, unknown> {
        const features = (farmer.farms || [])
            .map((f) => GeoIdService.buildFarmGeoJsonFeatureCentroidOnly(f))
            .filter((f): f is Record<string, unknown> => f !== null);
        return {
            type: 'FeatureCollection',
            farmerId: farmer.farmerId ?? null,
            profileUrl,
            features,
        };
    }

    /**
     * Quick health-check — returns true if the GeoID API is reachable.
     */
    async isHealthy(): Promise<boolean> {
        try {
            const res = await this.client.get('/health', { timeout: 5000 });
            return res.data?.status === 'ok';
        } catch {
            return false;
        }
    }
}

// Singleton — re-use across requests (axios instance is stateless per request)
let _instance: GeoIdService | null = null;
export function getGeoIdService(): GeoIdService {
    if (!_instance) _instance = new GeoIdService();
    return _instance;
}
