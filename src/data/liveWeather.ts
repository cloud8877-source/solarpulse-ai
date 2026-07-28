// Live Open-Meteo irradiance/weather overlay for SolarPulse.
// Fixture weather remains the demo spine; this module only ADDS rows for hours
// not already covered by fixtures. Never throws — any failure returns null.

import type { Site, Weather } from "../domain/types";

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
/** Fixture cloud_cover is 0–1 (see weather_observations.csv: 0.2 / 0.35 / 0.65). */
const OPEN_METEO_CLOUD_SCALE = 100;

export type FetchLiveWeatherOpts = {
  /** Recent history days (Open-Meteo past_days, 0–92). Default 0. */
  pastDays?: number;
};

type OpenMeteoHourly = {
  time?: unknown;
  shortwave_radiation?: unknown;
  temperature_2m?: unknown;
  cloud_cover?: unknown;
};

type OpenMeteoResponse = {
  utc_offset_seconds?: number;
  hourly?: OpenMeteoHourly;
};

/**
 * Fetch hourly shortwave radiation + temperature + cloud cover for a site.
 * Returns null on any failure (missing coords, network, non-200, malformed JSON).
 * Never throws. At most one console.warn on failure.
 */
export async function fetchLiveWeather(
  site: Site,
  opts?: FetchLiveWeatherOpts,
): Promise<Weather[] | null> {
  if (site.latitude == null || site.longitude == null) {
    return null;
  }
  if (!Number.isFinite(site.latitude) || !Number.isFinite(site.longitude)) {
    return null;
  }

  const pastDays = clampPastDays(opts?.pastDays ?? 0);
  const url = buildOpenMeteoUrl(site.latitude, site.longitude, pastDays);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(
        `[liveWeather] Open-Meteo non-200 for site ${site.id}: ${res.status}`,
      );
      return null;
    }
    const body = (await res.json()) as OpenMeteoResponse;
    return mapOpenMeteoToWeather(site.id, body);
  } catch {
    console.warn(`[liveWeather] Open-Meteo fetch failed for site ${site.id}`);
    return null;
  }
}

/**
 * Merge live rows into fixture weather. Fixture timestamps always win —
 * live only fills hours not already covered (demo days 2026-06-18..21 stay intact).
 * Does not mutate either input. Result is sorted by timestamp.
 */
export function mergeWeatherPreferFixture(
  fixture: Weather[],
  live: Weather[],
): Weather[] {
  const hourKey = (ts: string) => ts.slice(0, 13); // YYYY-MM-DDTHH
  const covered = new Set(fixture.map((w) => hourKey(w.timestamp)));
  const additions = live.filter((w) => !covered.has(hourKey(w.timestamp)));
  if (additions.length === 0) return [...fixture];
  return [...fixture, ...additions].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );
}

// --- internals ---

function clampPastDays(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(92, Math.floor(n));
}

function buildOpenMeteoUrl(lat: number, lon: number, pastDays: number): string {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: "shortwave_radiation,temperature_2m,cloud_cover",
    timezone: "Asia/Kuala_Lumpur",
    past_days: String(pastDays),
    forecast_days: "1",
  });
  return `${OPEN_METEO_URL}?${params.toString()}`;
}

function mapOpenMeteoToWeather(
  siteId: string,
  body: OpenMeteoResponse,
): Weather[] | null {
  const hourly = body?.hourly;
  if (!hourly || !Array.isArray(hourly.time) || hourly.time.length === 0) {
    return null;
  }

  const times = hourly.time;
  const sw = asNumberArray(hourly.shortwave_radiation, times.length);
  const temp = asNumberArray(hourly.temperature_2m, times.length);
  const cloud = asNumberArray(hourly.cloud_cover, times.length);
  if (!sw || !temp || !cloud) return null;

  const offsetSec =
    typeof body.utc_offset_seconds === "number"
      ? body.utc_offset_seconds
      : 8 * 60 * 60;

  const out: Weather[] = [];
  for (let i = 0; i < times.length; i++) {
    const raw = times[i];
    if (typeof raw !== "string" || raw.length < 13) return null;
    const timestamp = normalizeLocalTimestamp(raw, offsetSec);
    // id: live_<siteId>_<YYYYMMDDHH> from wall-clock hour
    const hourTag = timestamp.slice(0, 13).replace(/[-T:]/g, "");
    out.push({
      id: `live_${siteId}_${hourTag}`,
      siteId,
      timestamp,
      irradianceWm2: finiteOrNull(sw[i]!),
      temperatureC: finiteOrNull(temp[i]!),
      // Open-Meteo cloud_cover is percent 0–100; fixtures use fraction 0–1.
      cloudCover: scaleCloudCover(cloud[i]!),
      rainfallMm: null,
      source: "open-meteo",
      isFixture: false,
      qualityFlags: [],
    });
  }
  return out;
}

function asNumberArray(value: unknown, len: number): (number | null)[] | null {
  if (!Array.isArray(value) || value.length !== len) return null;
  return value.map((v) => {
    if (v == null) return null;
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    return v;
  });
}

function finiteOrNull(v: number | null): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

/** Map Open-Meteo % cloud cover → fixture 0–1 fraction. null stays null. */
function scaleCloudCover(v: number | null): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v / OPEN_METEO_CLOUD_SCALE;
}

/**
 * Open-Meteo timezone=auto / Asia/Kuala_Lumpur returns naive local wall-clock
 * strings like "2026-07-28T00:00". Fixtures use "+08:00" ISO with seconds —
 * append the response offset so string filters stay consistent.
 */
function normalizeLocalTimestamp(apiTime: string, utcOffsetSeconds: number): string {
  // Already has Z or numeric offset — pass through.
  if (/[zZ]$/.test(apiTime) || /[+-]\d{2}:\d{2}$/.test(apiTime)) {
    return apiTime;
  }
  let base = apiTime;
  // "YYYY-MM-DDTHH:mm" → add seconds
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(base)) {
    base = `${base}:00`;
  }
  const sign = utcOffsetSeconds >= 0 ? "+" : "-";
  const abs = Math.abs(utcOffsetSeconds);
  const oh = String(Math.floor(abs / 3600)).padStart(2, "0");
  const om = String(Math.floor((abs % 3600) / 60)).padStart(2, "0");
  return `${base}${sign}${oh}:${om}`;
}
