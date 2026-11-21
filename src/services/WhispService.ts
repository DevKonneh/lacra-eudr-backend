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

/**
 * Open question for FAO about `Ind_02_commodities` - do NOT resolve this
 * locally and do NOT let CMIS answer "are commodities present?" from it.
 *
 * OBSERVED (live, 2026-11-21): a ~60 ha parcel on the western edge of Gola
 * Forest, Grand Cape Mount, returned
 *
 *     Ind_02_commodities = "no"
 *     Cocoa_FDaP         = 3.357 ha
 *     Cocoa_2024_FDaP    = 17.170 ha
 *     risk_pcrop         = "high"
 *
 * i.e. WHISP's own summary flag said "no commodities" for a parcel where its
 * own commodity-overlap layers measured 17 ha of cocoa. Two readings are
 * possible and CMIS cannot tell them apart from the outside:
 *
 *   (a) the flag is scoped more narrowly than its name suggests - perhaps only
 *       UNICC-coded / officially-designated commodity areas, or only
 *       post-2020 commodity expansion; or
 *   (b) it is a defect in WHISP's indicator derivation.
 *
 * Either way, using it to tell a user "no commodities on this plot" would be
 * wrong on this evidence, so `commodityOverlaps` remains the authoritative
 * source for that question in CMIS. The flag is still stored (we do not
 * suppress upstream data), but no CMIS surface may act on it.
 *
 * THE QUESTION TO PUT TO FAO / Open Foris:
 *   "What exactly does Ind_02_commodities test, and why does it return 'no'
 *    when the commodity-specific overlap layers (Cocoa_FDaP / Cocoa_2024_FDaP)
 *    report non-zero overlap for the same plot?"
 */
export const IND_02_COMMODITIES_CLARIFICATION = {
    field: 'Ind_02_commodities',
    status: 'awaiting_fao_clarification',
    observedOn: '2026-11-21',
    observedCase: 'Gola Forest (West), Grand Cape Mount, Liberia, ~60 ha',
    contradiction: {
        Ind_02_commodities: 'no',
        Cocoa_FDaP_ha: 3.357,
        Cocoa_2024_FDaP_ha: 17.17,
        risk_pcrop: 'high',
    },
    /** The only field CMIS may use to answer "are commodities present?". */
    authoritativeField: 'commodityOverlaps',
} as const;

/** A single year with any measurable disturbance/loss/alert signal (ha), only non-zero years included. */export interface WhispYearlyEvent {
    year: number;
    gfcLossHa?: number;      // Hansen/Global Forest Change tree-cover loss for that year
    tmfDeforestationHa?: number; // JRC Tropical Moist Forest - deforestation
    tmfDegradationHa?: number;   // JRC Tropical Moist Forest - degradation
    raddAlertHa?: number;    // RADD near-real-time disturbance alerts
    gladLAlertHa?: number;   // GLAD-Landsat alerts
    gladS2AlertHa?: number;  // GLAD-Sentinel2 alerts
    /**
     * DIST_year_<yyyy> - the composite disturbance dataset.
     *
     * ADDED AFTER LIVE VERIFICATION (2026-11-21). A real response for a Gola
     * Forest parcel carried `DIST_year_2026 > 0` and `DIST_after_2020 = 0.374
     * ha`, while every prefix this map previously knew about (GFC_loss_year_,
     * TMF_def_, TMF_deg_, RADD_year_, GLAD-L_year_, GLAD-S2_year_) contributed
     * nothing for that year. WhISP was reporting disturbance we silently
     * discarded. Unlike GFC loss - whose post-2020 total can be reconstructed
     * by summing the yearly fields we already parse - DIST had no yearly
     * mapping at all, so the evidence was unrecoverable downstream.
     */
    distHa?: number;         // DIST_year_ - composite disturbance
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

// 'more_info_needed' is a real value Whisp's decision-tree engine returns (visible in the
// commodity-specific risk_pcrop/risk_acrop/risk_timber fields and confirmed via an official
// Whisp HTML risk report exported directly from whisp.openforis.org on 2026-08-28). It means
// Whisp's own tree could not reach a definitive low/high verdict for that commodity category -
// NOT the same as "low risk". Treating it as equivalent to low (as an earlier version of this
// code implicitly did, by only checking `=== 'high'`) understates real uncertainty that Whisp
// itself is flagging. 'unknown' remains our own fallback for when Whisp didn't return a label at
// all (e.g. cropType not mapped, or Whisp unavailable).
export type WhispRiskLabel = 'high' | 'low' | 'more_info_needed' | 'unknown';

/**
 * Machine-readable reasons a Whisp assessment could not be obtained.
 *
 * Every one of these means "no verified satellite result exists for this
 * farm". None of them may ever be persisted or displayed as a successful
 * assessment - see RiskService.analyzeFarm().
 */
export type WhispFailureCode =
    | 'not_configured'      // WHISP_API_KEY absent - integration switched off
    | 'auth_failed'         // auth_* envelope code or HTTP 401/403 - bad/revoked key
    | 'validation_failed'   // validation_* envelope code or HTTP 400/422 - bad geometry
    | 'service_unavailable' // HTTP 5xx / network error / system_* code / rate limit
    | 'timeout'             // async job never left queued/processing
    | 'incomplete_result'   // analysis_completed but no usable result properties
    | 'request_failed';     // anything else

/**
 * Thrown instead of returning a falsy or mocked result.
 *
 * Rationale for this class existing at all: the previous implementation
 * returned `null` on every failure AND a randomised mock object when the API
 * key was missing. RiskService could not tell those apart from a genuine
 * result, so it wrote a RiskAssessment row and stamped farm.riskLevel +
 * farm.lastRiskAssessmentDate - converting a failure (or pure randomness) into
 * a permanent, official-looking compliance verdict.
 */
export class WhispUnavailableError extends Error {
    readonly code: WhispFailureCode;
    readonly httpStatus?: number;
    readonly retryable: boolean;
    /** Raw upstream detail, kept for server logs/audit - not shown to end users. */
    readonly detail?: string;

    constructor(
        code: WhispFailureCode,
        message: string,
        opts: { httpStatus?: number; retryable?: boolean; detail?: string } = {}
    ) {
        super(message);
        this.name = 'WhispUnavailableError';
        this.code = code;
        this.httpStatus = opts.httpStatus;
        this.retryable = opts.retryable ?? (code === 'timeout' || code === 'service_unavailable');
        this.detail = opts.detail;
    }
}

/**
 * Where a result actually came from. ONLY 'whisp_live' is audit-grade
 * evidence; 'mock' must never be presented to staff as an assessment.
 */
export type WhispProvenance = 'whisp_live' | 'mock';

export interface WhispAnalysisResult {
    /** Provenance of this result. Stored on the RiskAssessment row for later audit. */
    provenance: WhispProvenance;
    /** True only for a completed response from the live Whisp/Earth Engine service. */
    verified: boolean;
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

    /**
     * DIST_after_2020 / DIST_before_2020 - WhISP's own pre-aggregated
     * composite-disturbance totals (ha), added 2026-11-21.
     *
     * Kept as separate scalar totals rather than folded into `annualEvents`
     * because WhISP computes them itself; recomputing a total from the yearly
     * series could silently disagree with WhISP's own figure if its baseline
     * years ever change. The due-diligence file should show WhISP's number.
     */
    distAfter2020Ha?: number;
    distBefore2020Ha?: number;
    /** GFC_loss_after_2020 / GFC_loss_before_2020 - Hansen loss totals (ha). */
    gfcLossAfter2020Ha?: number;
    gfcLossBefore2020Ha?: number;

    // --- Commodity-specific overlap datasets (only non-zero entries) ---
    commodityOverlaps: WhispCommodityOverlap[];

    // --- Pre-computed EUDR indicator flags (Ind_01 .. Ind_11) ---
    indicators: WhispIndicators;

    // --- Pre-computed commodity-category risk classification ---
    riskPerennialCrop: WhispRiskLabel; // risk_pcrop
    riskAnnualCrop: WhispRiskLabel;    // risk_acrop
    riskTimber: WhispRiskLabel;       // risk_timber

    /**
     * WHISP's OWN verdicts, preserved verbatim.
     *
     * Why this exists separately from the three fields above: those are passed
     * through `WhispRiskLabel`, which silently coerces anything unrecognised to
     * 'unknown'. CMIS must never overstate or rewrite a regulator-adjacent
     * verdict, so the raw upstream strings are kept here untouched. If WhISP
     * ever adds a fourth label, or renames one, this field is the evidence of
     * what it actually said - the typed field would just say 'unknown'.
     *
     * CMIS's computed `overallRisk` is a DERIVED judgement (it folds in
     * legality, traceability and overlap). It must always be stored ALONGSIDE
     * this, never in place of it.
     */
    rawVerdict?: {
        risk_pcrop?: string;
        risk_acrop?: string;
        risk_timber?: string;
        /** Any additional risk_* keys WhISP returns that we don't model. */
        extraRiskFields?: Record<string, string>;
    };

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
    // Added 2026-11-21 after live verification: the composite DIST dataset was
    // being returned by WhISP but had no mapping, so disturbance it reported was
    // dropped on the floor. See WhispYearlyEvent.distHa.
    { key: "distHa", prefix: "DIST_year_" },
];

export class WhispService {
    private baseUrl = process.env.WHISP_API_URL || 'http://localhost:8000/api';
    private apiKey = process.env.WHISP_API_KEY;

    /**
     * Submits a farm geometry to Whisp and returns a COMPLETED, verified result.
     *
     * Contract change (assessment-integrity fix): this method no longer returns
     * `null` and no longer fabricates a mock result. Every condition where a
     * real satellite verdict is unavailable throws a typed WhispUnavailableError,
     * so callers are structurally unable to mistake a failure for a success.
     * Callers MUST NOT persist an assessment when this throws.
     *
     * @throws {WhispUnavailableError} always, if no verified result could be obtained
     */
    async analyzeFarm(farmId: string, geojson: any): Promise<WhispAnalysisResult> {
        if (!this.apiKey) {
            // No mock fallback. A missing key means the integration is switched
            // off, which is a configuration error the operator must see - not a
            // reason to invent a random high/low verdict for a real farm.
            throw new WhispUnavailableError(
                'not_configured',
                'Satellite assessment is unavailable: the Whisp integration is not configured on this server (WHISP_API_KEY is not set). No assessment has been recorded.',
                { retryable: false }
            );
        }

        try {
            const payload = this.buildSubmitPayload(farmId, geojson);

            const submitted = await this.submitPayload(payload);
            let envelope = submitted.envelope;
            const jobToken = submitted.token;

            // Async fallback: some large/complex geometries (or a busy queue via
            // analysisOptions.async / analysis_too_many_concurrent backpressure) return a
            // queued/processing job instead of completing synchronously.
            //
            // This is the BLOCKING path, retained for RiskService.analyzeFarm() and any
            // caller that genuinely wants to wait. The queue worker does NOT use it: it
            // submits, persists the token, and polls in later ticks (see
            // submitAndReturnToken / checkStatus below).
            if (envelope?.code === 'analysis_queued' || envelope?.code === 'analysis_processing') {
                if (jobToken) {
                    envelope = await this.pollUntilComplete(jobToken, submitted.deadline);
                } else {
                    console.error("Whisp API returned a queued/processing response with no token to poll:", JSON.stringify(envelope).slice(0, 500));
                }
            }

            this.assertCompleted(envelope);

            const feature = envelope?.data?.features?.[0];
            const properties = feature?.properties;
            if (!properties) {
                console.error("Whisp API response missing feature properties:", JSON.stringify(envelope).slice(0, 500));
                // 'analysis_completed' with no properties is an INCOMPLETE result -
                // explicitly NOT a success. Previously this returned null and the
                // caller silently fell through to a name-based fake.
                throw new WhispUnavailableError(
                    'incomplete_result',
                    'Satellite assessment incomplete: Whisp reported completion but returned no result fields for this parcel. No assessment has been recorded - please retry.',
                    { httpStatus: 502, retryable: true }
                );
            }

            return this.mapWhispProperties(properties, jobToken);

        } catch (error: any) {
            // Re-throw our own typed failures untouched; classify transport errors.
            if (error instanceof WhispUnavailableError) throw error;

            const httpStatus = error.response?.status;
            const details = error.response?.data ? JSON.stringify(error.response.data) : error.message;
            console.error("Whisp API Error:", details);

            // Never leak the API key or the raw upstream body to the client;
            // the classified `detail` stays server-side for logs/audit.
            if (httpStatus === 401 || httpStatus === 403) {
                throw new WhispUnavailableError(
                    'auth_failed',
                    'Satellite assessment failed: the Whisp service rejected our credentials. No assessment has been recorded.',
                    { httpStatus: 502, retryable: false, detail: details }
                );
            }
            if (httpStatus === 400 || httpStatus === 422) {
                throw new WhispUnavailableError(
                    'validation_failed',
                    'Satellite assessment failed: Whisp rejected this farm\'s geometry. Correct the boundary and retry. No assessment has been recorded.',
                    { httpStatus: 400, retryable: false, detail: details }
                );
            }
            if (httpStatus === 429) {
                throw new WhispUnavailableError(
                    'service_unavailable',
                    'Satellite assessment not started: the Whisp service is rate limiting requests right now. No assessment has been recorded - please retry in a minute.',
                    { httpStatus: 429, retryable: true, detail: details }
                );
            }
            if (error.code === 'ECONNABORTED' || /timeout/i.test(String(error.message))) {
                throw new WhispUnavailableError(
                    'timeout',
                    'Satellite assessment timed out before Whisp responded. No assessment has been recorded - please retry.',
                    { httpStatus: 504, retryable: true, detail: details }
                );
            }
            throw new WhispUnavailableError(
                'service_unavailable',
                'Satellite assessment failed: the Whisp service could not be reached. No assessment has been recorded - please retry later.',
                { httpStatus: 502, retryable: true, detail: details }
            );
        }
    }

    /**
     * Poll GET /status/{token} until the job leaves the queued/processing state.
     *
     * WINDOW: now driven by the SERVER, not by a hard-coded 90s guess.
     *
     * The previous implementation gave up after 30 attempts x 3s = 90s while
     * `/api/config` reports `analysisTimeoutAsyncSeconds: 1800`. A large or
     * complex parcel could therefore be declared failed by OUR client while
     * WhISP was still legitimately working - and because each queue retry
     * re-submitted the polygon, that produced duplicate Earth Engine jobs.
     *
     * `deadline` is the absolute epoch-ms after which we stop. It is supplied
     * by `submitPayload`, which derives it from the server-reported window, so
     * this method no longer decides the budget on its own.
     *
     * This is the BLOCKING variant, used by analyzeFarm(). The queue worker uses
     * `checkStatus` (single non-blocking probe) instead.
     */
    private async pollUntilComplete(token: string, deadline: number, delayMs = 3000): Promise<any> {
        while (Date.now() < deadline) {
            const remaining = deadline - Date.now();
            await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, Math.max(remaining, 0))));
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
        console.error(`Whisp analysis for token ${token} did not complete before its server-reported deadline.`);
        return {
            code: 'analysis_timeout',
            message: 'The server-reported analysis window elapsed without completion.',
        };
    }

    /**
     * ONE non-blocking status probe.
     *
     * The queue worker calls this instead of waiting. Whatever it returns is
     * written back to the job row, so a worker restart, a deploy, or a retry
     * resumes polling the SAME analysis token rather than re-submitting the
     * polygon. That is the whole point: a slow parcel must not cost us a second
     * Earth Engine job, and must not occupy a worker for 30 minutes.
     */
    async checkStatus(token: string): Promise<{
        code: string;
        message?: string;
        envelope: any;
    }> {
        if (!this.apiKey) {
            throw new WhispUnavailableError(
                'not_configured',
                'Satellite assessment is unavailable: the Whisp integration is not configured on this server (WHISP_API_KEY is not set).',
                { retryable: false },
            );
        }
        try {
            const res = await axios.get(`${this.baseUrl}/status/${token}`, {
                headers: { 'x-api-key': this.apiKey as string },
                timeout: 15000,
            });
            const envelope = res.data;
            return {
                code: String(envelope?.code || 'unknown'),
                message: envelope?.message,
                envelope,
            };
        } catch (error: any) {
            const httpStatus = error?.response?.status;
            if (httpStatus === 401 || httpStatus === 403) {
                throw new WhispUnavailableError(
                    'auth_failed',
                    'Satellite assessment failed: the Whisp service rejected our credentials.',
                    { httpStatus: 502, retryable: false, detail: error?.message },
                );
            }
            if (httpStatus === 404) {
                // Token unknown to the server: the analysis is gone (expired or
                // purged). Retrying the token can never succeed, so this is a
                // terminal signal rather than a transient one.
                throw new WhispUnavailableError(
                    'incomplete_result',
                    'The satellite analysis this plot was waiting on is no longer available on Whisp. A new check is required.',
                    { httpStatus: 502, retryable: false, detail: error?.message },
                );
            }
            // Anything else (network, 5xx, rate limit) is transient: let the
            // queue's backoff decide, without touching the token.
            const err = new WhispUnavailableError(
                'service_unavailable',
                'Could not reach the Whisp service to check the analysis status. The analysis is still tracked and will be checked again.',
                { httpStatus: 502, retryable: true, detail: error?.message },
            );
            (err as any).transientStatusProbe = true;
            throw err;
        }
    }

    /**
     * Submits a polygon and returns the analysis token WITHOUT waiting.
     *
     * Used by the queue worker. The caller persists the token, so the analysis
     * survives a worker restart and is polled by `checkStatus` in later ticks.
     */
    async submitAndReturnToken(farmId: string, geojson: any): Promise<{
        token: string | null;
        /** Completed synchronously (no polling needed). */
        completed: boolean;
        envelope: any;
        deadline: number;
    }> {
        if (!this.apiKey) {
            throw new WhispUnavailableError(
                'not_configured',
                'Satellite assessment is unavailable: the Whisp integration is not configured on this server (WHISP_API_KEY is not set). No assessment has been recorded.',
                { retryable: false },
            );
        }
        const payload = this.buildSubmitPayload(farmId, geojson);
        const submitted = await this.submitPayload(payload);
        return {
            token: submitted.token ?? null,
            completed: submitted.envelope?.code === 'analysis_completed',
            envelope: submitted.envelope,
            deadline: submitted.deadline,
        };
    }

    /**
     * Maps a terminal `/status/{token}` envelope into a verified result.
     *
     * Exposed so the queue worker can complete a RESUMED analysis using the same
     * validation and mapping as a fresh one - there is exactly one code path
     * that decides "this is a real verdict", which is what keeps the
     * no-fabrication guarantee intact.
     */
    mapCompletedEnvelope(envelope: any, token?: string): WhispAnalysisResult {
        this.assertCompleted(envelope);
        const properties = envelope?.data?.features?.[0]?.properties;
        if (!properties) {
            throw new WhispUnavailableError(
                'incomplete_result',
                'Satellite assessment incomplete: Whisp reported completion but returned no result fields for this parcel. No assessment has been recorded - please retry.',
                { httpStatus: 502, retryable: true },
            );
        }
        return this.mapWhispProperties(properties, token);
    }

    /**
     * The server's own async analysis window, in milliseconds.
     *
     * Read from `/api/config` (`analysisTimeoutAsyncSeconds`) with a small
     * safety margin, and cached for the process. Falls back to 30 minutes -
     * the value the live service reported on 2026-11-21 - if the config call
     * fails, so a config outage can never shorten the window below the server's
     * real allowance.
     */
    async getServerAnalysisWindowMs(): Promise<number> {
        if (this.cachedWindowMs != null) return this.cachedWindowMs;
        const FALLBACK_SECONDS = 1800;
        try {
            const res = await axios.get(`${this.baseUrl}/config`, { timeout: 10000 });
            const seconds = Number(res.data?.analysisTimeoutAsyncSeconds);
            const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : FALLBACK_SECONDS;
            // +30s margin: the server's clock starts before our response arrives.
            this.cachedWindowMs = safe * 1000 + 30_000;
        } catch {
            this.cachedWindowMs = FALLBACK_SECONDS * 1000 + 30_000;
        }
        return this.cachedWindowMs;
    }

    private cachedWindowMs: number | null = null;

    /** Builds the submit body. Single definition for both call paths. */
    private buildSubmitPayload(farmId: string, geojson: any) {
        return {
            type: "FeatureCollection",
            features: [{
                type: "Feature",
                geometry: geojson,
                properties: { id: farmId }
            }],
            analysisOptions: {
                unitType: "ha",
                // Always async: a large/complex polygon submitted with async:false
                // simply hung until the 30s axios timeout fired (verified live
                // 2026-08-13), which made the client - not WhISP - the thing that
                // failed. With async:true the submit returns in ~0.2s with a token.
                async: true
            }
        };
    }

    /** POSTs the payload and captures the analysis token + deadline. */
    private async submitPayload(payload: any): Promise<{
        envelope: any;
        token?: string;
        deadline: number;
    }> {
        const response = await axios.post(`${this.baseUrl}/submit/geojson`, payload, {
            headers: { 'x-api-key': this.apiKey, 'Content-Type': 'application/json' },
            timeout: 30000
        });
        const envelope = response.data;
        // Token is nested at data.token (with data.statusUrl), NOT context.token -
        // verified against a live analysis_queued response on 2026-08-13.
        const token = envelope?.data?.token || envelope?.context?.token;
        const windowMs = await this.getServerAnalysisWindowMs();
        return { envelope, token, deadline: Date.now() + windowMs };
    }

    /** Classifies a non-completed envelope into a typed failure. */
    private assertCompleted(envelope: any): void {
        if (envelope?.code === 'analysis_completed') return;

        const code = String(envelope?.code || 'unknown');
        const message = envelope?.message || 'no message';
        console.error("Whisp API did not complete analysis:", code, message, envelope?.cause);

        if (code.startsWith('auth_')) {
            throw new WhispUnavailableError(
                'auth_failed',
                'Satellite assessment failed: the Whisp service rejected our credentials. No assessment has been recorded.',
                { httpStatus: 502, retryable: false, detail: `${code}: ${message}` }
            );
        }
        if (code.startsWith('validation_')) {
            throw new WhispUnavailableError(
                'validation_failed',
                `Satellite assessment failed: Whisp rejected this farm's geometry (${message}). Correct the boundary and retry. No assessment has been recorded.`,
                { httpStatus: 400, retryable: false, detail: `${code}: ${message}` }
            );
        }
        if (code === 'analysis_timeout') {
            throw new WhispUnavailableError(
                'timeout',
                'Satellite assessment timed out: Whisp did not finish processing this parcel in time. No assessment has been recorded - please retry.',
                { httpStatus: 504, retryable: true, detail: `${code}: ${message}` }
            );
        }
        throw new WhispUnavailableError(
            'service_unavailable',
            'Satellite assessment failed: the Whisp service returned an error. No assessment has been recorded - please retry later.',
            { httpStatus: 502, retryable: true, detail: `${code}: ${message}` }
        );
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
            // NOTE (2026-11-21): kept as a passthrough of WhISP's own flag, but
            // do NOT use it to answer "does this plot contain commodities?".
            // Live verification found Ind_02_commodities = 'no' on a Gola Forest
            // parcel whose Cocoa_2024_FDaP overlap was 17.17 ha. Until FAO
            // clarifies what this flag scopes, `commodityOverlaps` is the
            // authoritative evidence. See IND_02_COMMODITIES_CLARIFICATION.
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
            // Reaching this point means a live Whisp response carried a completed
            // analysis WITH usable properties - the only path that may be persisted
            // as audit-grade evidence.
            provenance: 'whisp_live',
            verified: true,
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

            distAfter2020Ha: props.DIST_after_2020 != null ? num(props.DIST_after_2020) : undefined,
            distBefore2020Ha: props.DIST_before_2020 != null ? num(props.DIST_before_2020) : undefined,
            gfcLossAfter2020Ha: props.GFC_loss_after_2020 != null ? num(props.GFC_loss_after_2020) : undefined,
            gfcLossBefore2020Ha: props.GFC_loss_before_2020 != null ? num(props.GFC_loss_before_2020) : undefined,

            riskPerennialCrop: (props.risk_pcrop as WhispRiskLabel) || 'unknown',
            riskAnnualCrop: (props.risk_acrop as WhispRiskLabel) || 'unknown',
            riskTimber: (props.risk_timber as WhispRiskLabel) || 'unknown',
            // Preserved verbatim so CMIS can never be accused of restating or
            // rounding WHISP's verdict. See WhispAnalysisResult.rawVerdict.
            rawVerdict: this.extractRawVerdict(props),

            whispVersion: props.whisp_processing_metadata?.whisp_version,
            processedAt: props.whisp_processing_metadata?.processing_timestamp_utc,

            raw: props,
        };
    }

    /**
     * Copies WHISP's own `risk_*` verdicts through untouched.
     *
     * Deliberately no coercion and no defaulting: a missing label stays absent
     * rather than becoming 'unknown', so "WHISP did not say" and "WHISP said
     * something we do not model" remain distinguishable in the audit record.
     * Any unrecognised `risk_*` key is captured in `extraRiskFields` rather than
     * dropped, so a future WhISP label surfaces in the stored evidence instead
     * of disappearing.
     */
    private extractRawVerdict(props: Record<string, any>): WhispAnalysisResult['rawVerdict'] {
        const KNOWN = new Set(['risk_pcrop', 'risk_acrop', 'risk_timber']);
        const extraRiskFields: Record<string, string> = {};
        for (const key of Object.keys(props)) {
            if (!key.startsWith('risk_')) continue;
            if (KNOWN.has(key)) continue;
            const value = props[key];
            if (typeof value === 'string') extraRiskFields[key] = value;
        }

        return {
            risk_pcrop: typeof props.risk_pcrop === 'string' ? props.risk_pcrop : undefined,
            risk_acrop: typeof props.risk_acrop === 'string' ? props.risk_acrop : undefined,
            risk_timber: typeof props.risk_timber === 'string' ? props.risk_timber : undefined,
            extraRiskFields: Object.keys(extraRiskFields).length > 0 ? extraRiskFields : undefined,
        };
    }
}
