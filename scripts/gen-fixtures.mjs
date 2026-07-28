// Deterministic multi-day solar + weather fixture generator (zero deps).
// Regenerates:
//   src/data/fixtures/solar_observations.csv
//   src/data/fixtures/weather_observations.csv
// Leaves solar_sites.csv and grid_demand_snapshots.csv untouched.
//
// Run: node scripts/gen-fixtures.mjs
// Then: npm run embed:fixtures
//
// NO Math.random / Date.now — every value is a pure function of (site, day, hour).

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = join(root, "src", "data", "fixtures");

// --- Engine constants (mirror src/config/assumptions.ts + src/engine/forecast.ts) ---
const PR = 0.78;
const GAMMA_PER_C = -0.004;
const TEMP_REF_C = 25;
const IRRADIANCE_REF = 1000;
const IRRADIANCE_FACTOR_MAX = 1.2;

const DAYS = ["2026-06-18", "2026-06-19", "2026-06-20", "2026-06-21"];
const HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];

const SITES = {
  site_a: { capacityKwp: 850, cloud: 0.2 },
  site_b: { capacityKwp: 2500, cloud: 0.2 },
  site_c: { capacityKwp: 1200, cloud: 0.35 },
};

// Base weather profile (identical to the historical single-day fixture for day 4).
const BASE_IRRADIANCE = [245.9, 475.0, 671.8, 822.7, 917.6, 950.0, 917.6, 822.7, 671.8, 475.0, 245.9];
const BASE_TEMP = [29.3, 30.5, 31.5, 32.3, 32.8, 33.0, 32.8, 32.3, 31.5, 30.5, 29.3];

// Mild day-to-day irradiance scale (site_b always matches site_a — shortfall is not weather).
const DAY_IRRADIANCE_SCALE = {
  "2026-06-18": 0.98,
  "2026-06-19": 1.01,
  "2026-06-20": 0.97,
  "2026-06-21": 1.0,
};

// Exact day-4 (2026-06-21) generation values from the previous single-day fixture.
// Preserves green-report literal assertions when asOfDate defaults to this day.
const DAY4_GENERATION = {
  site_a: [164.82, 305.18, 422.83, 541.3, 599.83, 594.64, 596.19, 534.59, 426.06, 316.55, 157.15],
  site_b: [471.23, 905.87, 1275.67, 1276.96, 1421.34, 1470.44, 1421.34, 1276.96, 1275.67, 905.87, 471.23],
  site_c: [205.14, 414.61, 582.58, 747.57, null, null, null, 745.59, 548.84, 428.81, 216.82],
};

// site_b peak-hour inverter shortfall factor (hours 11–15, indices 3–7) on anomaly days.
// Calibrated so daily residual lands ~-11% (anomaly band -10%..-20%).
const SITE_B_PEAK_FACTOR = 0.82;
const SITE_B_PEAK_HOURS = new Set([11, 12, 13, 14, 15]);

// site_b day-2 watch: uniform residual ~-7% (watch band -5%..-10%).
const SITE_B_WATCH_FACTOR = 0.93;

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function irradianceFactor(irr) {
  return Math.min(Math.max(irr / IRRADIANCE_REF, 0), IRRADIANCE_FACTOR_MAX);
}

function temperatureDerate(tempC) {
  return 1 + GAMMA_PER_C * Math.max(tempC - TEMP_REF_C, 0);
}

function expectedKwh(capacityKwp, irradianceWm2, temperatureC) {
  return (
    capacityKwp *
    1 *
    irradianceFactor(irradianceWm2) *
    PR *
    temperatureDerate(temperatureC)
  );
}

function ts(day, hour) {
  return `${day}T${String(hour).padStart(2, "0")}:00:00+08:00`;
}

function idSuffix(day, hour) {
  // Day-unique: obs_site_a_20260618_08
  return `${day.replace(/-/g, "")}_${String(hour).padStart(2, "0")}`;
}

function csvEscape(value) {
  if (value === null || value === undefined || value === "") return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function flagsJson(flags) {
  // Return raw JSON; row() applies CSV escaping once.
  return JSON.stringify(flags);
}

function row(cells) {
  return cells.map(csvEscape).join(",");
}

/** Energy-balance: self = gen - export = load - import. Round to 2 dp, check 3 dp. */
function energySplit(generationKwh, selfConsumptionFraction, loadOverSelf = 1.15) {
  if (generationKwh == null) {
    // Telemetry gap: load may still be present; full import, no export.
    return { loadKwh: null, importKwh: null, exportKwh: null };
  }
  const self = generationKwh * selfConsumptionFraction;
  const exportKwh = round(generationKwh - self);
  // Re-derive self from rounded export so balance holds after rounding.
  const selfRounded = round(generationKwh - exportKwh);
  const loadKwh = round(selfRounded * loadOverSelf);
  const importKwh = round(loadKwh - selfRounded);
  // Clamp import >= 0 after rounding.
  const importClamped = Math.max(0, importKwh);
  const loadFinal = round(selfRounded + importClamped);
  const exportFinal = round(generationKwh - selfRounded);
  return {
    loadKwh: loadFinal,
    importKwh: importClamped,
    exportKwh: exportFinal,
  };
}

function energyWhenGenerationMissing(hourIndex) {
  // Plausible mid-day site load while generation telemetry is null.
  const baseLoad = [90, 110, 130, 140, 150, 145, 140, 130, 110, 95, 80][hourIndex];
  return { loadKwh: baseLoad, importKwh: baseLoad, exportKwh: null };
}

// --- Weather ---
function weatherRows() {
  const out = [];
  for (const [siteId, site] of Object.entries(SITES)) {
    for (const day of DAYS) {
      const scale = DAY_IRRADIANCE_SCALE[day];
      for (let i = 0; i < HOURS.length; i++) {
        const hour = HOURS[i];
        const irr = round(BASE_IRRADIANCE[i] * scale, 1);
        const temp = BASE_TEMP[i];
        out.push(
          row([
            `wx_${siteId}_${idSuffix(day, hour)}`,
            siteId,
            ts(day, hour),
            irr,
            temp,
            site.cloud,
            "0.0",
            "demo_fixture",
            "True",
            flagsJson(["fixture_data"]),
          ]),
        );
      }
    }
  }
  return out;
}

// --- Solar observations ---
function generationFor(siteId, day, hourIndex, hour, exp) {
  // Day 4: exact historical values (site_c nulls included).
  if (day === "2026-06-21") {
    return DAY4_GENERATION[siteId][hourIndex];
  }

  if (siteId === "site_a") {
    // Healthy: slight deterministic wobble within ±3%.
    const wobble = [1.02, 0.99, 0.98, 1.015, 1.01, 0.985, 1.008, 1.005, 0.99, 1.02, 0.985][hourIndex];
    return round(exp * wobble);
  }

  if (siteId === "site_b") {
    if (day === "2026-06-18") {
      // Healthy day 1.
      return round(exp * 1.0);
    }
    if (day === "2026-06-19") {
      // Watch ~-7%.
      return round(exp * SITE_B_WATCH_FACTOR);
    }
    // Days 3 (and 4 handled above): anomaly peak-hour inverter shortfall.
    if (SITE_B_PEAK_HOURS.has(hour)) {
      return round(exp * SITE_B_PEAK_FACTOR);
    }
    return round(exp * 1.0);
  }

  // site_c
  if (day === "2026-06-18" || day === "2026-06-19") {
    // Clean days — mild noise within healthy band, no quality flags beyond fixture_data.
    const wobble = [0.98, 0.99, 0.97, 1.0, 1.01, 0.99, 1.0, 0.98, 0.96, 0.99, 0.98][hourIndex];
    return round(exp * wobble);
  }
  // Day 3 (2026-06-20): same missing/noisy pattern as day 4.
  // Missing peak hours 12,13,14 (indices 4,5,6).
  if (hour === 12 || hour === 13 || hour === 14) return null;
  const noisyWobble = [0.907, 0.953, 0.951, 1.0, 1.0, 1.0, 1.0, 0.997, 0.896, 0.986, 0.958][hourIndex];
  return round(exp * noisyWobble);
}

function qualityAndInverter(siteId, day, hour, generationKwh) {
  const flags = ["fixture_data"];
  let inverterId = "";

  if (siteId === "site_b") {
    // Seed inverter signal on anomaly days for peak shortfall hours.
    if (
      (day === "2026-06-20" || day === "2026-06-21") &&
      SITE_B_PEAK_HOURS.has(hour) &&
      generationKwh != null
    ) {
      inverterId = "inverter_3";
      flags.push("seeded_inverter_underperformance");
    }
  }

  if (siteId === "site_c") {
    if (day === "2026-06-20" || day === "2026-06-21") {
      if (generationKwh == null) {
        flags.push("missing_generation", "stale_telemetry");
      } else {
        flags.push("generation_noisy");
      }
    }
  }

  return { flags, inverterId };
}

function loadProfile(siteId, day) {
  // site_a: high weekday self-consumption days 1–2 (~70%), low weekend days 3–4 (~37%).
  // site_b: steady mid load (~50% self-consumption).
  // site_c: mid-high industrial load (~60% when generating).
  if (siteId === "site_a") {
    if (day === "2026-06-18" || day === "2026-06-19") {
      return { selfFraction: 0.7, loadOverSelf: 1.2 };
    }
    return { selfFraction: 0.37, loadOverSelf: 1.08 };
  }
  if (siteId === "site_b") {
    return { selfFraction: 0.5, loadOverSelf: 1.2 };
  }
  return { selfFraction: 0.6, loadOverSelf: 1.15 };
}

function observationRows() {
  const out = [];
  for (const [siteId, site] of Object.entries(SITES)) {
    for (const day of DAYS) {
      const scale = DAY_IRRADIANCE_SCALE[day];
      const profile = loadProfile(siteId, day);
      for (let i = 0; i < HOURS.length; i++) {
        const hour = HOURS[i];
        const irr = round(BASE_IRRADIANCE[i] * scale, 1);
        const temp = BASE_TEMP[i];
        const exp = expectedKwh(site.capacityKwp, irr, temp);
        const gen = generationFor(siteId, day, i, hour, exp);
        const { flags, inverterId } = qualityAndInverter(siteId, day, hour, gen);

        let loadKwh;
        let importKwh;
        let exportKwh;
        if (gen == null) {
          const missing = energyWhenGenerationMissing(i);
          loadKwh = missing.loadKwh;
          importKwh = missing.importKwh;
          exportKwh = missing.exportKwh; // empty CSV field
        } else {
          const split = energySplit(gen, profile.selfFraction, profile.loadOverSelf);
          loadKwh = split.loadKwh;
          importKwh = split.importKwh;
          exportKwh = split.exportKwh;
        }

        out.push(
          row([
            `obs_${siteId}_${idSuffix(day, hour)}`,
            siteId,
            ts(day, hour),
            gen === null ? "" : gen,
            loadKwh === null || loadKwh === undefined ? "" : loadKwh,
            importKwh === null || importKwh === undefined ? "" : importKwh,
            exportKwh === null || exportKwh === undefined ? "" : exportKwh,
            inverterId,
            "", // string_id
            "1.0",
            "demo_fixture",
            "True",
            flagsJson(flags),
          ]),
        );
      }
    }
  }
  return out;
}

const solarHeader =
  "id,site_id,timestamp,generation_kwh,load_kwh,import_kwh,export_kwh,inverter_id,string_id,availability,source,is_fixture,quality_flags_json";
const weatherHeader =
  "id,site_id,timestamp,irradiance_wm2,temperature_c,cloud_cover,rainfall_mm,source,is_fixture,quality_flags_json";

const solarCsv = [solarHeader, ...observationRows()].join("\n") + "\n";
const weatherCsv = [weatherHeader, ...weatherRows()].join("\n") + "\n";

writeFileSync(join(fixturesDir, "solar_observations.csv"), solarCsv, "utf8");
writeFileSync(join(fixturesDir, "weather_observations.csv"), weatherCsv, "utf8");

const nObs = observationRows().length;
const nWx = weatherRows().length;
console.log(`Wrote solar_observations.csv (${nObs} rows) and weather_observations.csv (${nWx} rows)`);
console.log(`Expected: 3 sites × 11 hours × 4 days = 132 each`);
