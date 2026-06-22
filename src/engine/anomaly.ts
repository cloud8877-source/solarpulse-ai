// Anomaly detector v1 (PDR-004 §3).
// ORDER MATTERS: data-quality is detected FIRST and overrides severity. Missing
// generation is excluded from the residual entirely — never summed as zero —
// otherwise Site C's missing peak hours read as "critical" and CE3 fails for
// over-diagnosing equipment (PDR-003 §6, PDR-005 §6).

import { assumptions as A, MODEL_VERSION } from "../config/assumptions";
import type {
  AnomalyEvidence,
  AnomalyResult,
  Observation,
  QualityFlag,
  Severity,
  Site,
  Weather,
} from "../domain/types";
import { expectedProfile } from "./forecast";
import { mean, round, sum } from "./math";

const WEATHER_NORMAL_MAX_CLOUD = 0.6;
const PER_INTERVAL_MIN_EXPECTED_KWH = 1.0; // guard tiny denominators at dawn/dusk

function severityFromResidual(residualPct: number): Severity {
  if (residualPct >= A.severity.healthyMin) return "healthy";
  if (residualPct >= A.severity.watchMin) return "watch";
  if (residualPct >= A.severity.anomalyMin) return "anomaly";
  return "critical";
}

export interface DetectArgs {
  site: Site;
  observations: Observation[];
  weather: Weather[];
  windowStart?: string;
  windowEnd?: string;
}

export function detectUnderperformance(args: DetectArgs): AnomalyResult {
  const obs = [...args.observations].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );
  const inWindow = obs.filter(
    (o) =>
      (!args.windowStart || o.timestamp >= args.windowStart) &&
      (!args.windowEnd || o.timestamp <= args.windowEnd),
  );

  const windowStart = args.windowStart ?? inWindow[0]?.timestamp ?? "";
  const windowEnd = args.windowEnd ?? inWindow[inWindow.length - 1]?.timestamp ?? "";

  const expByTs = new Map(expectedProfile(args.site, args.weather).map((i) => [i.timestamp, i.expectedKwh]));

  const total = inWindow.length;
  let missing = 0;
  let noisy = 0;
  let stale = 0;

  let observedKwh = 0;
  let expectedKwh = 0;

  // per-valid-interval residuals, in time order, for persistence + inverter signal
  const downInverters = new Set<string>();
  let run = 0;
  let persistentIntervals = 0;

  for (const o of inWindow) {
    if (o.qualityFlags.includes("generation_noisy")) noisy += 1;
    if (o.qualityFlags.includes("stale_telemetry")) stale += 1;

    if (o.generationKwh == null) {
      missing += 1;
      run = 0; // a gap breaks a persistence run
      continue;
    }

    const exp = expByTs.get(o.timestamp) ?? 0;
    observedKwh += o.generationKwh;
    expectedKwh += exp;

    if (exp > PER_INTERVAL_MIN_EXPECTED_KWH) {
      const intervalResidualPct = (o.generationKwh - exp) / exp;
      if (intervalResidualPct < A.persistence.intervalResidualThreshold) {
        run += 1;
        persistentIntervals = Math.max(persistentIntervals, run);
        if (o.inverterId) downInverters.add(o.inverterId);
      } else {
        run = 0;
      }
    } else {
      run = 0;
    }
  }

  const residualKwh = observedKwh - expectedKwh;
  const residualPct = expectedKwh > 0 ? residualKwh / expectedKwh : 0;

  // --- Data-quality FIRST (overrides severity) ---
  const missingFraction = total > 0 ? missing / total : 0;
  const noisyFraction = total > 0 ? noisy / total : 0;
  const isDataIssue =
    missingFraction > A.dataQuality.maxMissingFraction ||
    noisyFraction >= A.dataQuality.minNoisyFractionForIssue ||
    stale > 0;

  const severity: Severity = isDataIssue ? "data_issue" : severityFromResidual(residualPct);

  // --- Evidence ---
  const cloudVals = args.weather.map((w) => w.cloudCover).filter((c): c is number => c != null);
  const weatherUnavailable = expectedProfile(args.site, args.weather).some((i) => !i.weatherAvailable);
  const weatherNormal =
    !weatherUnavailable && (cloudVals.length === 0 || mean(cloudVals) < WEATHER_NORMAL_MAX_CLOUD);

  const notes: string[] = [];
  if (isDataIssue) {
    if (missing > 0) notes.push(`${missing} of ${total} intervals have missing generation`);
    if (stale > 0) notes.push(`${stale} intervals flagged stale telemetry`);
    if (noisy > 0) notes.push(`${noisy} intervals flagged noisy generation`);
    notes.push("Telemetry quality is insufficient to diagnose equipment; residual is unreliable.");
  }

  const inverterSignal =
    downInverters.size > 0
      ? `${[...downInverters].sort().join(", ")} lower than peer group`
      : undefined;

  const evidence: AnomalyEvidence = {
    weatherNormal,
    persistentIntervals,
    validIntervals: total - missing,
    missingIntervals: missing,
    noisyIntervals: noisy,
    ...(inverterSignal ? { inverterSignal } : {}),
    notes,
  };

  const flags: QualityFlag[] = [];
  if (args.site.isFixture) flags.push("fixture_data");
  if (missing > 0) flags.push("missing_generation");
  if (stale > 0) flags.push("stale_telemetry");
  if (noisy > 0) flags.push("generation_noisy");
  if (weatherUnavailable) flags.push("weather_unavailable");

  return {
    siteId: args.site.id,
    windowStart,
    windowEnd,
    observedKwh: round(observedKwh),
    expectedKwh: round(expectedKwh),
    residualKwh: round(residualKwh),
    residualPct: round(residualPct, 4),
    severity,
    qualityFlags: flags,
    evidence,
    modelVersion: MODEL_VERSION,
  };
}
