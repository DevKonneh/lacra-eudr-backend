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
     * Build the public farm-scan URL that gets encoded into the farm QR code.
     * This URL is what WHIMO (and LACRA internal app) scan.
     */
    static farmScanUrl(farmId: string): string {
        const base = (process.env.API_BASE_URL ?? process.env.FRONTEND_URL ?? 'http://localhost:3000')
            .trim()
            .replace(/\/$/, '');
        return `${base}/api/public/farm-scan/${farmId}`;
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
