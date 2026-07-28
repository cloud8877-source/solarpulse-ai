// Fixture loader: parses the labeled demo CSVs into typed domain records.
// Robust CSV parsing (papaparse) handles the embedded JSON arrays in quality_flags_json.
// Critical: missing generation_kwh is preserved as null and must NEVER be coerced to 0.

import Papa from "papaparse";
import type {
  GridSnapshot,
  Observation,
  QualityFlag,
  Site,
  TariffCategory,
  Weather,
} from "../domain/types";
import { FIXTURE_CSV } from "./fixtures.gen";

function tariffCategory(s: string | undefined): TariffCategory {
  const t = (s ?? "").trim();
  if (t === "mv_general") return "mv_general";
  return "lv_general";
}

// CSV text is embedded at build time via `npm run embed:fixtures` so this module
// has no Node filesystem dependency and can run on Cloudflare Workers.

function readCsv(file: string): Record<string, string>[] {
  const text = FIXTURE_CSV[file];
  if (text === undefined) {
    throw new Error(
      `Missing embedded fixture "${file}". Run \`npm run embed:fixtures\` after adding or renaming CSVs in src/data/fixtures/.`,
    );
  }
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  return parsed.data;
}

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function bool(s: string | undefined): boolean {
  return (s ?? "").trim().toLowerCase() === "true";
}

function strOrNull(s: string | undefined): string | null {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
}

function flags(s: string | undefined): QualityFlag[] {
  const t = (s ?? "").trim();
  if (t === "") return [];
  try {
    const arr = JSON.parse(t);
    return Array.isArray(arr) ? (arr as QualityFlag[]) : [];
  } catch {
    return [];
  }
}

export function loadSites(): Site[] {
  return readCsv("solar_sites.csv").map((r) => ({
    id: r.id!,
    tenantId: r.tenant_id!,
    name: r.name!,
    region: r.region!,
    latitude: num(r.latitude),
    longitude: num(r.longitude),
    capacityKwp: num(r.capacity_kwp) ?? 0,
    inverterCount: num(r.inverter_count),
    commissioningDate: strOrNull(r.commissioning_date),
    tariffAssumptionRmPerKwh: num(r.tariff_assumption_rm_per_kwh),
    carbonFactorKgco2PerKwh: num(r.carbon_factor_kgco2_per_kwh),
    performanceRatio: num(r.performance_ratio) ?? 0.78,
    tariffCategory: tariffCategory(r.tariff_category),
    source: r.source!,
    isFixture: bool(r.is_fixture),
  }));
}

export function loadObservations(): Observation[] {
  return readCsv("solar_observations.csv").map((r) => ({
    id: r.id!,
    siteId: r.site_id!,
    timestamp: r.timestamp!,
    generationKwh: num(r.generation_kwh), // null when missing — preserved deliberately
    // load / import / export: empty CSV fields stay null (never coerced to 0)
    loadKwh: num(r.load_kwh),
    importKwh: num(r.import_kwh),
    exportKwh: num(r.export_kwh),
    inverterId: strOrNull(r.inverter_id),
    stringId: strOrNull(r.string_id),
    availability: num(r.availability),
    source: r.source!,
    isFixture: bool(r.is_fixture),
    qualityFlags: flags(r.quality_flags_json),
  }));
}

export function loadWeather(): Weather[] {
  return readCsv("weather_observations.csv").map((r) => ({
    id: r.id!,
    siteId: r.site_id!,
    timestamp: r.timestamp!,
    irradianceWm2: num(r.irradiance_wm2),
    temperatureC: num(r.temperature_c),
    cloudCover: num(r.cloud_cover),
    rainfallMm: num(r.rainfall_mm),
    source: r.source!,
    isFixture: bool(r.is_fixture),
    qualityFlags: flags(r.quality_flags_json),
  }));
}

export function loadGridSnapshots(): GridSnapshot[] {
  return readCsv("grid_demand_snapshots.csv").map((r) => ({
    id: r.id!,
    region: r.region!,
    timestamp: r.timestamp!,
    demandMw: num(r.demand_mw),
    forecastHorizon: r.forecast_horizon!,
    source: r.source!,
    fetchedAt: strOrNull(r.fetched_at),
    sourceUrl: strOrNull(r.source_url),
    qualityFlags: flags(r.quality_flags_json),
  }));
}
