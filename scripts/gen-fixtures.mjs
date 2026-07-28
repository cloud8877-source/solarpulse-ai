// Deterministic multi-day solar + weather fixture generator (zero deps).
// Regenerates:
//   src/data/fixtures/solar_observations.csv
//   src/data/fixtures/weather_observations.csv
// Leaves solar_sites.csv and grid_demand_snapshots.csv untouched
// (except site_c capacity is edited in solar_sites.csv separately).
//
// Run: node scripts/gen-fixtures.mjs
// Then: npm run embed:fixtures
//
// NO Math.random / Date.now — every value is a pure function of (site, day, hour).
//
// I2b-1: 24-hour rows (00–23). Night irradiance/generation are real zeros (sun down),
// not null. Missing telemetry remains exclusively site_c days 3–4 daylight story.
// Continuous load profiles give night import so ATAP offsettable export is realistic.

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
const HOURS = Array.from({ length: 24 }, (_, h) => h); // 0..23
const DAYLIGHT_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const DAYLIGHT_INDEX = Object.fromEntries(DAYLIGHT_HOURS.map((h, i) => [h, i]));

const SITES = {
  site_a: { capacityKwp: 850, cloud: 0.2 },
  site_b: { capacityKwp: 2500, cloud: 0.2 },
  // Resized 1200 → 950 so site_c is ATAP-eligible under the 1,000 kWac cap.
  site_c: { capacityKwp: 950, cloud: 0.35 },
};

// Historical site_c day-4 values were for 1200 kWp; scale so residual % is unchanged.
const SITE_C_CAPACITY_SCALE = 950 / 1200;

// Base weather profile for daylight hours 08–18 (identical to historical day-4 shape).
const BASE_IRRADIANCE = [245.9, 475.0, 671.8, 822.7, 917.6, 950.0, 917.6, 822.7, 671.8, 475.0, 245.9];
const BASE_TEMP = [29.3, 30.5, 31.5, 32.3, 32.8, 33.0, 32.8, 32.3, 31.5, 30.5, 29.3];

// Night temperatures (plausible tropical night; irradiance is always 0).
const NIGHT_TEMP = {
  0: 27.2,
  1: 26.8,
  2: 26.5,
  3: 26.3,
  4: 26.2,
  5: 26.4,
  6: 27.0,
  7: 28.0,
  19: 29.0,
  20: 28.5,
  21: 28.0,
  22: 27.6,
  23: 27.4,
};

// Mild day-to-day irradiance scale (site_b always matches site_a weather shape on
// non-cloud-override days — shortfall is not weather).
const DAY_IRRADIANCE_SCALE = {
  "2026-06-18": 0.98,
  "2026-06-19": 1.01,
  "2026-06-20": 0.97,
  "2026-06-21": 1.0,
};

// Exact day-4 (2026-06-21) daylight generation values from the previous single-day
// fixture (11 daylight hours). site_c scaled 1200→950; missing peak hours expanded
// to 11–14 so missingFraction = 4/24 > 0.15 under the engine's all-interval denominator.
const DAY4_GENERATION = {
  site_a: [164.82, 305.18, 422.83, 541.3, 599.83, 594.64, 596.19, 534.59, 426.06, 316.55, 157.15],
  site_b: [471.23, 905.87, 1275.67, 1276.96, 1421.34, 1470.44, 1421.34, 1276.96, 1275.67, 905.87, 471.23],
  // Scaled from 1200 kWp historical; hour 11 (index 3) now null for 4 missing of 24.
  site_c: [
    round(205.14 * SITE_C_CAPACITY_SCALE),
    round(414.61 * SITE_C_CAPACITY_SCALE),
    round(582.58 * SITE_C_CAPACITY_SCALE),
    null, // hour 11 — extra missing so data_issue survives 24h window
    null, // hour 12
    null, // hour 13
    null, // hour 14
    round(745.59 * SITE_C_CAPACITY_SCALE),
    round(548.84 * SITE_C_CAPACITY_SCALE),
    round(428.81 * SITE_C_CAPACITY_SCALE),
    round(216.82 * SITE_C_CAPACITY_SCALE),
  ],
};

// site_b peak-hour inverter shortfall factor (hours 11–15) on anomaly days.
// Calibrated so daily residual lands ~-11% (anomaly band -10%..-20%).
const SITE_B_PEAK_FACTOR = 0.82;
const SITE_B_PEAK_HOURS = new Set([11, 12, 13, 14, 15]);

// site_b day-2 watch: uniform residual ~-7% (watch band -5%..-10%).
const SITE_B_WATCH_FACTOR = 0.93;

// site_c data_issue days: missing daylight hours (4 of 24 → 16.7% > 0.15 threshold).
const SITE_C_MISSING_HOURS = new Set([11, 12, 13, 14]);

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
  return `${day.replace(/-/g, "")}_${String(hour).padStart(2, "0")}`;
}

function csvEscape(value) {
  if (value === null || value === undefined || value === "") return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function flagsJson(flags) {
  return JSON.stringify(flags);
}

function row(cells) {
  return cells.map(csvEscape).join(",");
}

function isDaylight(hour) {
  return hour >= 8 && hour <= 18;
}

/** Site-day cloud cover. site_a day 2 is distinctly cloudier (R3). */
function cloudFor(siteId, day) {
  if (siteId === "site_a" && day === "2026-06-19") return 0.45;
  return SITES[siteId].cloud;
}

/**
 * Irradiance scale for a site-day. site_a day 2 is reduced consistently with
 * higher cloud so residual stays healthy (weather explains the lower generation).
 */
function irradianceScale(siteId, day) {
  let scale = DAY_IRRADIANCE_SCALE[day];
  if (siteId === "site_a" && day === "2026-06-19") {
    // Cloud 0.45 vs usual 0.20 → ~22% lower clear-sky-equivalent irradiance.
    scale *= 0.78;
  }
  return scale;
}

function weatherAt(siteId, day, hour) {
  const scale = irradianceScale(siteId, day);
  if (!isDaylight(hour)) {
    return { irr: 0, temp: NIGHT_TEMP[hour], cloud: cloudFor(siteId, day) };
  }
  const i = DAYLIGHT_INDEX[hour];
  return {
    irr: round(BASE_IRRADIANCE[i] * scale, 1),
    temp: BASE_TEMP[i],
    cloud: cloudFor(siteId, day),
  };
}

/**
 * Absolute load profile (kWh/h). Continuous 24h; deterministic.
 * site_a: C&I rooftop — weekday daytime ~260–330, night baseload ~90–120; weekend drop days 3–4.
 * site_b: utility plant — small auxiliary load only (exports nearly everything).
 * site_c: industrial profile scaled to 950 kWp.
 */
function loadKwhFor(siteId, day, hour) {
  if (siteId === "site_a") {
    const weekend = day === "2026-06-20" || day === "2026-06-21";
    if (weekend) {
      // Weekend drop (days 3–4): lower daytime, night baseload still present.
      // Mean load kept below mean gen so ATAP shows a modest export-forfeiture headline
      // (not the old ~80% daylight-only balloon).
      const weekendLoad = [
        90, 85, 82, 80, 82, 88, 100, 115, // 0–7
        130, 140, 150, 155, 150, 145, 140, 135, 130, 125, 120, // 8–18
        110, 100, 95, 92, 90, // 19–23
      ];
      return weekendLoad[hour];
    }
    // Weekday C&I: daytime ~260–330 kWh/h, night baseload ~90–120.
    // Night import (gen=0) ≈ 13 × 105 ≈ 1.4 MWh. Sized so 4-day mean is a net
    // exporter with import-capped offsettable credit (forfeiture ~RM 2.5–5k/mo).
    const weekdayLoad = [
      110, 105, 98, 95, 98, 105, 150, 200, // 0–7
      260, 290, 310, 325, 320, 315, 305, 295, 280, 270, 260, // 8–18
      190, 155, 135, 120, 112, // 19–23
    ];
    return weekdayLoad[hour];
  }

  if (siteId === "site_b") {
    // Utility plant auxiliary only — tiny vs multi-MWh generation.
    const aux = [
      35, 32, 30, 30, 32, 35, 40, 45, // 0–7
      55, 60, 65, 70, 70, 68, 65, 60, 55, 50, 45, // 8–18
      42, 40, 38, 36, 35, // 19–23
    ];
    return aux[hour];
  }

  // site_c industrial — scaled roughly with capacity (950/1200 of a larger plant).
  // Night baseload stays material; daytime continuous process load.
  const industrial = [
    150, 145, 140, 140, 145, 155, 180, 220, // 0–7
    300, 340, 370, 390, 400, 395, 385, 370, 350, 320, 280, // 8–18
    240, 210, 190, 170, 155, // 19–23
  ];
  return industrial[hour];
}

/**
 * Energy-balance from absolute load + generation.
 * Identity: round(gen − export, 3) === round(load − import, 3) ≥ 0.
 * Constraints: export ≤ gen, import ≤ load.
 */
function energyFromLoadAndGen(generationKwh, loadKwh) {
  if (generationKwh == null) {
    // Telemetry gap: load present; full import; export unknown/null.
    return { loadKwh, importKwh: loadKwh, exportKwh: null };
  }
  const gen = generationKwh;
  const load = loadKwh;
  const self = Math.min(gen, load);
  let exportKwh = round(gen - self);
  // Re-derive self from rounded export so balance holds after rounding.
  const selfFromGen = round(gen - exportKwh);
  let importKwh = round(load - selfFromGen);
  if (importKwh < 0) importKwh = 0;
  // Keep load consistent with self + import after clamps.
  const loadFinal = round(selfFromGen + importKwh);
  // Re-clamp export ≤ gen (already true) and import ≤ load.
  if (importKwh > loadFinal) importKwh = loadFinal;
  return {
    loadKwh: loadFinal,
    importKwh,
    exportKwh,
  };
}

// --- Weather ---
function weatherRows() {
  const out = [];
  for (const siteId of Object.keys(SITES)) {
    for (const day of DAYS) {
      for (const hour of HOURS) {
        const { irr, temp, cloud } = weatherAt(siteId, day, hour);
        out.push(
          row([
            `wx_${siteId}_${idSuffix(day, hour)}`,
            siteId,
            ts(day, hour),
            irr,
            temp,
            cloud,
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
function generationFor(siteId, day, hour, exp) {
  // Night: real zero generation (sun down) — NOT null.
  if (!isDaylight(hour)) return 0;

  const hourIndex = DAYLIGHT_INDEX[hour];

  // Day 4: exact historical daylight values (site_c nulls included).
  if (day === "2026-06-21") {
    return DAY4_GENERATION[siteId][hourIndex];
  }

  if (siteId === "site_a") {
    // Healthy: slight deterministic wobble within ±3% (incl. cloudier day 2).
    const wobble = [1.02, 0.99, 0.98, 1.015, 1.01, 0.985, 1.008, 1.005, 0.99, 1.02, 0.985][hourIndex];
    return round(exp * wobble);
  }

  if (siteId === "site_b") {
    if (day === "2026-06-18") {
      return round(exp * 1.0);
    }
    if (day === "2026-06-19") {
      return round(exp * SITE_B_WATCH_FACTOR);
    }
    // Days 3 (day 4 handled above): anomaly peak-hour inverter shortfall.
    if (SITE_B_PEAK_HOURS.has(hour)) {
      return round(exp * SITE_B_PEAK_FACTOR);
    }
    return round(exp * 1.0);
  }

  // site_c
  if (day === "2026-06-18" || day === "2026-06-19") {
    const wobble = [0.98, 0.99, 0.97, 1.0, 1.01, 0.99, 1.0, 0.98, 0.96, 0.99, 0.98][hourIndex];
    return round(exp * wobble);
  }
  // Day 3 (2026-06-20): same missing/noisy pattern as day 4 (expanded missing).
  if (SITE_C_MISSING_HOURS.has(hour)) return null;
  const noisyWobble = [0.907, 0.953, 0.951, 1.0, 1.0, 1.0, 1.0, 0.997, 0.896, 0.986, 0.958][hourIndex];
  return round(exp * noisyWobble);
}

function qualityAndInverter(siteId, day, hour, generationKwh) {
  const flags = ["fixture_data"];
  let inverterId = "";

  if (siteId === "site_b") {
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
      } else if (isDaylight(hour)) {
        // Noisy only on daylight non-missing intervals (not night zeros).
        flags.push("generation_noisy");
      }
    }
  }

  return { flags, inverterId };
}

function observationRows() {
  const out = [];
  for (const [siteId, site] of Object.entries(SITES)) {
    for (const day of DAYS) {
      for (const hour of HOURS) {
        const { irr, temp } = weatherAt(siteId, day, hour);
        const exp = expectedKwh(site.capacityKwp, irr, temp);
        const gen = generationFor(siteId, day, hour, exp);
        const { flags, inverterId } = qualityAndInverter(siteId, day, hour, gen);
        const loadTarget = loadKwhFor(siteId, day, hour);
        const split = energyFromLoadAndGen(gen, loadTarget);

        out.push(
          row([
            `obs_${siteId}_${idSuffix(day, hour)}`,
            siteId,
            ts(day, hour),
            gen === null ? "" : gen,
            split.loadKwh === null || split.loadKwh === undefined ? "" : split.loadKwh,
            split.importKwh === null || split.importKwh === undefined ? "" : split.importKwh,
            split.exportKwh === null || split.exportKwh === undefined ? "" : split.exportKwh,
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
console.log(`Expected: 3 sites × 24 hours × 4 days = 288 each`);
