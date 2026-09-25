import axios from "axios";

/**
 * Open-Meteo integration (https://open-meteo.com).
 *
 * Provides current conditions + a 7-day forecast for a given farm's GPS
 * coordinates - used to help field officers and farmers plan
 * planting/harvest/spraying around rain, and to flag heat/drought stress.
 *
 * Chosen over paid providers (OpenWeatherMap, etc.) because it requires
 * NO API key and has a generous free-for-non-commercial-use policy with
 * confirmed live coverage for Liberia (verified by direct testing against
 * real farm coordinates - correctly resolves timezone to Africa/Monrovia).
 * If usage ever needs a commercial license, Open-Meteo also sells one at
 * https://open-meteo.com/en/pricing without requiring any code changes
 * (same endpoint/response shape).
 */

export interface WeatherDailyForecast {
    date: string;               // ISO date, e.g. "2026-09-26"
    weatherCode: number;        // WMO weather code (see WMO_WEATHER_CODES below)
    weatherLabel: string;       // human-readable, e.g. "Slight rain"
    tempMaxC: number;
    tempMinC: number;
    precipitationSumMm: number;
    precipitationProbabilityMax: number | null; // %, null if unavailable
}

export interface WeatherCurrentConditions {
    time: string;                // ISO timestamp
    temperatureC: number;
    relativeHumidityPercent: number;
    precipitationMm: number;
    weatherCode: number;
    weatherLabel: string;
    windSpeedKmh: number;
}

export interface FarmWeatherResult {
    latitude: number;
    longitude: number;
    timezone: string;
    elevationM: number;
    current: WeatherCurrentConditions;
    daily: WeatherDailyForecast[];
    /** Simple derived flags useful for farm-management UI, computed from the raw forecast. */
    advisories: {
        heavyRainExpected: boolean;   // any day in the 7-day window has >20mm rain
        droughtRisk: boolean;         // 7 consecutive days with <1mm rain each
        heatStress: boolean;          // any day's max temp >= 35C (stress threshold for cocoa/coffee)
    };
}

// WMO Weather interpretation codes (WW), as used by Open-Meteo.
// https://open-meteo.com/en/docs (see "WMO Weather interpretation codes")
const WMO_WEATHER_CODES: Record<number, string> = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    56: "Light freezing drizzle",
    57: "Dense freezing drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    66: "Light freezing rain",
    67: "Heavy freezing rain",
    71: "Slight snow fall",
    73: "Moderate snow fall",
    75: "Heavy snow fall",
    77: "Snow grains",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Slight snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail",
};

const weatherLabel = (code: number): string => WMO_WEATHER_CODES[code] || "Unknown";

export class WeatherService {
    private baseUrl = process.env.OPEN_METEO_API_URL || "https://api.open-meteo.com/v1/forecast";

    async getFarmWeather(lat: number, lon: number): Promise<FarmWeatherResult> {
        const response = await axios.get(this.baseUrl, {
            params: {
                latitude: lat,
                longitude: lon,
                current: "temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
                daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max",
                timezone: "auto",
                forecast_days: 7,
            },
            timeout: 10000,
        });

        const d = response.data;

        const current: WeatherCurrentConditions = {
            time: d.current.time,
            temperatureC: d.current.temperature_2m,
            relativeHumidityPercent: d.current.relative_humidity_2m,
            precipitationMm: d.current.precipitation,
            weatherCode: d.current.weather_code,
            weatherLabel: weatherLabel(d.current.weather_code),
            windSpeedKmh: d.current.wind_speed_10m,
        };

        const daily: WeatherDailyForecast[] = (d.daily.time as string[]).map((date, i) => ({
            date,
            weatherCode: d.daily.weather_code[i],
            weatherLabel: weatherLabel(d.daily.weather_code[i]),
            tempMaxC: d.daily.temperature_2m_max[i],
            tempMinC: d.daily.temperature_2m_min[i],
            precipitationSumMm: d.daily.precipitation_sum[i],
            precipitationProbabilityMax: d.daily.precipitation_probability_max?.[i] ?? null,
        }));

        const heavyRainExpected = daily.some((day) => day.precipitationSumMm > 20);
        const droughtRisk = daily.length >= 7 && daily.every((day) => day.precipitationSumMm < 1);
        const heatStress = daily.some((day) => day.tempMaxC >= 35);

        return {
            latitude: d.latitude,
            longitude: d.longitude,
            timezone: d.timezone,
            elevationM: d.elevation,
            current,
            daily,
            advisories: { heavyRainExpected, droughtRisk, heatStress },
        };
    }
}
