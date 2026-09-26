import axios from "axios";

/**
 * ISRIC SoilGrids integration (https://soilgrids.org).
 *
 * Provides soil properties (texture, pH, organic carbon, bulk density,
 * cation exchange capacity) for any lat/lon, globally, at 250m resolution.
 * Free, no API key required — same "no-key, free-for-research" pattern as
 * Open-Meteo (WeatherService.ts).
 *
 * IMPORTANT HONESTY NOTE: SoilGrids is a machine-learning PREDICTION built
 * from global soil samples + satellite covariates, not a direct on-the-
 * ground lab test of the exact farm plot. It is a reasonable estimate for
 * planning purposes (fits the same use case as e.g. a national soil map),
 * not a substitute for an actual soil sample analysis. This is reflected
 * in the UI copy ("Estimated soil profile") rather than presenting it as
 * a certified lab result.
 */

export interface SoilProfileResult {
    latitude: number;
    longitude: number;
    /** e.g. "Sandy Clay Loam" — derived from clay/sand/silt % via the USDA texture triangle. */
    textureClass: string;
    clayPercent: number;
    sandPercent: number;
    siltPercent: number;
    /** pH in water, 0-14 scale. */
    phH2O: number;
    /** Soil organic carbon, g/kg. */
    organicCarbonGKg: number;
    /** Cation exchange capacity, cmol(+)/kg — a proxy for nutrient-holding capacity. */
    cationExchangeCapacity: number | null;
    /** Bulk density, kg/dm3 (i.e. g/cm3) — a proxy for compaction/aeration. */
    bulkDensityKgDm3: number | null;
    /** Depth range these values represent, e.g. "0-5cm" (topsoil, most relevant to rooting/planting decisions). */
    depthLabel: string;
    /** Simple, farm-relevant interpretation notes derived from the raw values. */
    notes: string[];
}

/**
 * Classify a soil sample into one of the 12 standard USDA soil texture
 * classes given %clay, %sand, %silt (which should sum to ~100).
 * Reference: USDA soil texture triangle.
 */
function classifyTexture(clay: number, sand: number, silt: number): string {
    if (clay >= 40 && sand <= 45 && silt < 40) return "Clay";
    if (clay >= 40 && silt >= 40) return "Silty Clay";
    if (clay >= 35 && sand >= 45) return "Sandy Clay";
    if (clay >= 27 && clay < 40 && sand > 20 && sand <= 45) return "Clay Loam";
    if (clay >= 27 && clay < 40 && sand <= 20) return "Silty Clay Loam";
    if (clay >= 20 && clay < 35 && sand > 45 && silt < 28) return "Sandy Clay Loam";
    if (clay >= 7 && clay < 27 && silt >= 28 && silt < 50 && sand <= 52) return "Loam";
    if (silt >= 50 && clay >= 12 && clay < 27) return "Silt Loam";
    if (silt >= 80 && clay < 12) return "Silt";
    if (sand >= 43 && sand < 85 && clay < 20 && silt < 50) return "Sandy Loam";
    if (sand >= 70 && sand < 91 && clay < 15) return "Loamy Sand";
    if (sand >= 85 && clay < 10) return "Sand";
    // Fallback for edge cases that don't cleanly fall in one bucket.
    return "Loam";
}

function buildNotes(result: Omit<SoilProfileResult, "notes">): string[] {
    const notes: string[] = [];

    if (result.clayPercent >= 40) {
        notes.push("High clay content — retains water and nutrients well but can be prone to waterlogging and slow drainage; raised beds or drainage channels help for wet-season planting.");
    } else if (result.sandPercent >= 70) {
        notes.push("Sandy soil — drains quickly and warms fast, but retains less water and fewer nutrients; more frequent irrigation/fertilization may be needed.");
    } else {
        notes.push("Balanced loam-type soil — generally good workability, moisture retention and drainage for most tree/root crops.");
    }

    if (result.phH2O < 5.5) {
        notes.push(`Acidic soil (pH ${result.phH2O.toFixed(1)}) — suitable for cocoa/coffee/rubber, which tolerate acidic soils, but may limit crops needing more neutral pH.`);
    } else if (result.phH2O > 7.5) {
        notes.push(`Alkaline soil (pH ${result.phH2O.toFixed(1)}) — uncommon for humid tropical zones; verify with a local soil test if planning acid-loving perennials.`);
    } else {
        notes.push(`Near-neutral pH (${result.phH2O.toFixed(1)}) — suitable for a wide range of commodity and food crops.`);
    }

    if (result.organicCarbonGKg < 10) {
        notes.push("Low organic carbon — soil may benefit from organic matter (compost, mulch, cover crops) to improve fertility over time.");
    } else if (result.organicCarbonGKg >= 30) {
        notes.push("High organic carbon — generally fertile topsoil, favorable for most crops.");
    }

    return notes;
}

export class SoilService {
    private baseUrl = process.env.SOILGRIDS_API_URL || "https://rest.isric.org/soilgrids/v2.0/properties/query";

    async getSoilProfile(lat: number, lon: number): Promise<SoilProfileResult> {
        const response = await axios.get(this.baseUrl, {
            params: {
                lon,
                lat,
                property: ["clay", "sand", "silt", "phh2o", "soc", "cec", "bdod"],
                depth: "0-5cm",
                value: "mean",
            },
            paramsSerializer: {
                // axios would otherwise serialize repeated keys as
                // property[]=x — SoilGrids expects repeated bare
                // ?property=x&property=y instead.
                indexes: null,
            },
            timeout: 15000,
        });

        const layers: any[] = response.data?.properties?.layers || [];
        const readLayer = (name: string): { value: number | null; dFactor: number; unit: string } => {
            const layer = layers.find((l) => l.name === name);
            const depthEntry = layer?.depths?.[0];
            const raw = depthEntry?.values?.mean;
            return {
                value: raw === undefined || raw === null ? null : raw,
                dFactor: layer?.unit_measure?.d_factor || 1,
                unit: layer?.unit_measure?.target_units || "",
            };
        };

        const clayRaw = readLayer("clay");
        const sandRaw = readLayer("sand");
        const siltRaw = readLayer("silt");
        const phRaw = readLayer("phh2o");
        const socRaw = readLayer("soc");
        const cecRaw = readLayer("cec");
        const bdodRaw = readLayer("bdod");

        if (clayRaw.value === null || sandRaw.value === null || siltRaw.value === null || phRaw.value === null || socRaw.value === null) {
            throw new Error("SoilGrids returned incomplete data for this location (possibly over water or outside coverage).");
        }

        const clayPercent = clayRaw.value / clayRaw.dFactor;
        const sandPercent = sandRaw.value / sandRaw.dFactor;
        const siltPercent = siltRaw.value / siltRaw.dFactor;
        const phH2O = phRaw.value / phRaw.dFactor;
        // soc is reported in dg/kg (d_factor 10) -> convert to g/kg for readability.
        const organicCarbonGKg = socRaw.value / socRaw.dFactor;
        const cationExchangeCapacity = cecRaw.value !== null ? cecRaw.value / cecRaw.dFactor : null;
        const bulkDensityKgDm3 = bdodRaw.value !== null ? bdodRaw.value / bdodRaw.dFactor : null;

        const textureClass = classifyTexture(clayPercent, sandPercent, siltPercent);

        const base: Omit<SoilProfileResult, "notes"> = {
            latitude: lat,
            longitude: lon,
            textureClass,
            clayPercent: Math.round(clayPercent * 10) / 10,
            sandPercent: Math.round(sandPercent * 10) / 10,
            siltPercent: Math.round(siltPercent * 10) / 10,
            phH2O: Math.round(phH2O * 10) / 10,
            organicCarbonGKg: Math.round(organicCarbonGKg * 10) / 10,
            cationExchangeCapacity: cationExchangeCapacity !== null ? Math.round(cationExchangeCapacity * 10) / 10 : null,
            bulkDensityKgDm3: bulkDensityKgDm3 !== null ? Math.round(bulkDensityKgDm3 * 100) / 100 : null,
            depthLabel: "0-5cm",
        };

        return { ...base, notes: buildNotes(base) };
    }
}
