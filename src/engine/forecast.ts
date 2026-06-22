// Forecast engine v1 — transparent baseline (PDR-004 §2, ADR-0004).
// expected = capacity · interval_hours · irradiance_factor · PR · temperature_derate
// (availability is held at the ideal 1.0 for the EXPECTED baseline so that real
//  availability/equipment losses surface as a residual in the anomaly detector.)

import { assumptions as A, MODEL_VERSION } from "../config/assumptions";
import type {
  Assumption,
  ExpectedInterval,
  ForecastResult,
  Horizon,
  Observation,
  QualityFlag,
  Site,
  Weather,
} from "../domain/types";
import { median, round, sum } from "./math";

export function irradianceFactor(irradianceWm2: number): number {
  return Math.min(Math.max(irradianceWm2 / A.irradianceRefWm2, 0), A.irradianceFactorMax);
}

export function temperatureDerate(temperatureC: number): number {
  return 1 + A.gammaPerC * Math.max(temperatureC - A.tempRefC, 0);
}

export function expectedIntervalKwh(
  capacityKwp: number,
  irradianceWm2: number,
  temperatureC: number,
  performanceRatio: number = A.performanceRatioDefault,
): number {
  return (
    capacityKwp *
    A.intervalHours *
    irradianceFactor(irradianceWm2) *
    performanceRatio *
    temperatureDerate(temperatureC)
  );
}

/** Per-interval expected generation. Missing irradiance falls back to the median
 *  irradiance factor of the available intervals and flags the interval. */
export function expectedProfile(site: Site, weatherList: Weather[]): ExpectedInterval[] {
  const factors = weatherList
    .filter((w) => w.irradianceWm2 != null)
    .map((w) => irradianceFactor(w.irradianceWm2!));
  const fallbackFactor = median(factors);

  return weatherList.map((w) => {
    if (w.irradianceWm2 == null || w.temperatureC == null) {
      const expectedKwh = site.capacityKwp * A.intervalHours * fallbackFactor * site.performanceRatio;
      return { timestamp: w.timestamp, expectedKwh, weatherAvailable: false };
    }
    return {
      timestamp: w.timestamp,
      expectedKwh: expectedIntervalKwh(
        site.capacityKwp,
        w.irradianceWm2,
        w.temperatureC,
        site.performanceRatio,
      ),
      weatherAvailable: true,
    };
  });
}

// Intervals excluded from the forecast-accuracy backtest: they reflect a real
// anomaly or a data-quality problem, not forecast error.
const DIRTY_FLAGS = new Set<QualityFlag>([
  "seeded_inverter_underperformance",
  "generation_noisy",
  "missing_generation",
  "generation_outlier",
]);

/** In-sample fixture backtest WAPE over CLEAN intervals only (honest forecast accuracy).
 *  Returns null when a site has no clean intervals to measure against (e.g. Site C). */
export function fixtureWape(observations: Observation[], intervals: ExpectedInterval[]): number | null {
  const expByTs = new Map(intervals.map((i) => [i.timestamp, i.expectedKwh]));
  let sumAbs = 0;
  let sumObs = 0;
  let n = 0;
  for (const o of observations) {
    if (o.generationKwh == null) continue;
    if (o.qualityFlags.some((f) => DIRTY_FLAGS.has(f))) continue;
    const exp = expByTs.get(o.timestamp);
    if (exp == null) continue;
    sumAbs += Math.abs(o.generationKwh - exp);
    sumObs += o.generationKwh;
    n += 1;
  }
  if (n === 0 || sumObs === 0) return null;
  return sumAbs / sumObs;
}

export interface ForecastArgs {
  site: Site;
  weather: Weather[];
  observations?: Observation[];
  horizon: Horizon;
  runAt: string;
  /** Model-level fixture WAPE to report when a site has no clean intervals of its own. */
  referenceWape?: number;
}

export function forecastSolarYield(args: ForecastArgs): ForecastResult {
  const intervals = expectedProfile(args.site, args.weather);
  const expectedKwh = round(sum(intervals.map((i) => i.expectedKwh)));
  const lowerKwh = round(expectedKwh * (1 - A.confidenceBandPct));
  const upperKwh = round(expectedKwh * (1 + A.confidenceBandPct));

  const flags: QualityFlag[] = [];
  if (args.site.isFixture) flags.push("fixture_data");
  if (intervals.some((i) => !i.weatherAvailable)) flags.push("weather_unavailable");

  // Honest metric: own clean-interval WAPE if measurable; else a supplied model
  // reference WAPE (flagged); else unavailable (flagged). NEVER a silent 0 — a
  // 0 would read as a perfect forecast, the exact overclaim ADR-0005 forbids.
  const ownWape = args.observations ? fixtureWape(args.observations, intervals) : null;
  let metricValue: number | null;
  if (ownWape != null) {
    metricValue = round(ownWape, 4);
  } else if (args.referenceWape != null) {
    metricValue = round(args.referenceWape, 4);
    flags.push("metric_from_reference");
  } else {
    metricValue = null;
    flags.push("metric_unavailable");
  }

  const assumptions: Assumption[] = [
    { name: "performance_ratio", value: args.site.performanceRatio, note: "Per-site baseline PR." },
    { name: "gamma_per_c", value: A.gammaPerC, note: "Temperature derate slope per °C above 25°C." },
    { name: "confidence_band_pct", value: A.confidenceBandPct, note: "± band around expected." },
  ];

  return {
    siteId: args.site.id,
    horizon: args.horizon,
    runAt: args.runAt,
    expectedKwh,
    lowerKwh,
    upperKwh,
    modelVersion: MODEL_VERSION,
    metric: { name: "fixture_wape", value: metricValue },
    assumptions,
    qualityFlags: flags,
    intervals,
  };
}
