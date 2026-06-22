// Central config for every tunable number in the engine.
// PDR-004 §3: "Thresholds should be config values, not hardcoded deep inside logic."
// Financial/carbon values are demo-only configurable assumptions, NOT quoted tariffs.

import type { Confidence, Severity } from "../domain/types";

export const MODEL_VERSION = "solarops-baseline-v1";
export const BASELINE_VERSION = "solarops-baseline-v1";

export const assumptions = {
  // --- Financial / carbon (demo-only; surfaced in every recommendation & report) ---
  tariffRmPerKwh: 0.5,
  carbonFactorKgco2PerKwh: 0.65,

  // --- Forecast baseline (PDR-004 §2) ---
  performanceRatioDefault: 0.78,
  gammaPerC: -0.004, // temperature-derate slope, per °C above reference
  tempRefC: 25,
  irradianceRefWm2: 1000,
  irradianceFactorMax: 1.2,
  intervalHours: 1, // fixtures are hourly
  confidenceBandPct: 0.08, // ± band around expected_kwh for lower/upper

  // --- Anomaly severity thresholds on residual_pct (negative = shortfall, PDR-004 §3) ---
  severity: {
    healthyMin: -0.05, // residual_pct >= -5%  -> healthy
    watchMin: -0.1, //    -10% <= pct < -5%  -> watch
    anomalyMin: -0.2, //  -20% <= pct < -10% -> anomaly;  pct < -20% -> critical
  },

  // --- Anomaly persistence (PDR-004 §3) ---
  persistence: {
    intervalResidualThreshold: -0.1, // an interval is "down" if its residual_pct < this
    minConsecutiveIntervals: 2,
  },

  // --- Data-quality detection: Site C path. Checked BEFORE severity (PDR-003 §6). ---
  dataQuality: {
    flags: ["missing_generation", "stale_telemetry", "generation_noisy"] as const,
    maxMissingFraction: 0.15, // > 15% of daylight intervals missing -> data_issue
    minNoisyFractionForIssue: 0.3, // >= 30% intervals flagged noisy -> data_issue
  },

  // --- Recommendation impact (PDR-004 §5) ---
  recovery: {
    recurrenceDaysPerMonth: 20,
    recoverableFractionByConfidence: { low: 0.5, medium: 0.72, high: 0.9 } satisfies Record<
      Confidence,
      number
    >,
  },

  // --- Ranking score weights (PDR-004 §5) ---
  ranking: {
    severityWeight: {
      healthy: 0,
      watch: 0.4,
      anomaly: 0.8,
      critical: 1.0,
      data_issue: 0.3,
    } satisfies Record<Severity, number>,
    confidenceWeight: { low: 0.4, medium: 0.7, high: 1.0 } satisfies Record<Confidence, number>,
    uncertaintyPenalty: 0.1,
  },
};

export type Assumptions = typeof assumptions;
