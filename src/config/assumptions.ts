// Central config for every tunable number in the engine.
// PDR-004 §3: "Thresholds should be config values, not hardcoded deep inside logic."
// Financial/carbon values are demo-only configurable assumptions, NOT quoted tariffs —
// except where a public gazette / published tariff is cited in the comment below.

import type { Confidence, Severity, SourceType } from "../domain/types";

export const MODEL_VERSION = "solarops-baseline-v1";
export const BASELINE_VERSION = "solarops-baseline-v1";

/** One month's Average SMP entry used for ATAP export credit pricing. */
export interface AverageSmpEntry {
  rmPerKwh: number;
  /** Provenance label for the SourceManifest (public | manual_assumption | …). */
  provenance: SourceType;
  source: string;
}

export const assumptions = {
  // --- Financial / carbon ---
  // TNB Non-Domestic Low Voltage General energy charge, effective 1 Jul 2025
  // (month: 2025-07). Source: https://www.mytnb.com.my/tariff
  // Note: ATAP credits offset the energy charge only — AFA (Automatic Fuel Adjustment)
  // is excluded from this model (GP/ST/No.60/2025 Pricing and Tariff).
  retailTariffRmPerKwh: 0.2703,

  // TNB non-domestic LV General unbundled volumetric components, effective 1 Jul 2025
  // (Source: https://www.mytnb.com.my/tariff). Sum = 0.5068 RM/kWh full avoided-cost stack
  // used for self-consumption valuation / SMP-spread leak. MV capacity & network are
  // RM/kW demand charges (not volumetric), so MV volumetric = energy charge 0.2983 only.
  lvVolumetricComponents: {
    energyRmPerKwh: 0.2703,
    capacityRmPerKwh: 0.0883,
    networkRmPerKwh: 0.1482,
  },

  // Peninsular Malaysia Grid Emission Factor projection for 2026 (JPPET 2/2025 basis),
  // published 31 Dec 2025 (month: 2025-12).
  // Source: https://singlebuyer.com.my/docs/default-source/about/gef-projection-publication_31122025v1.pdf
  carbonFactorKgco2PerKwh: 0.652,

  // --- Solar ATAP (GP/ST/No.60/2025, effective 1 Jan 2026, Peninsular Malaysia) ---
  // Gazette: https://www.st.gov.my/sites/default/files/2026-03/GUIDELINES-FOR-SOLAR-ACCELERATED_0.pdf
  // Average SMP = monthly average System Marginal Price for 07:00–19:00 of the
  // PRECEDING calendar month (section 2 definition) — known at billing-period start.
  atap: {
    averageSmpByMonth: {
      // Single Buyer revised SMP series, retrieved 2026-07-28 (month: 2026-01).
      "2026-01": {
        rmPerKwh: 0.1911,
        provenance: "public" as SourceType,
        source:
          "https://www.singlebuyer.com.my/market/market-data/system-marginal-price (revised, retrieved 2026-07-28)",
      },
      // Single Buyer revised SMP series, retrieved 2026-07-28 (month: 2026-02).
      "2026-02": {
        rmPerKwh: 0.1893,
        provenance: "public" as SourceType,
        source:
          "https://www.singlebuyer.com.my/market/market-data/system-marginal-price (revised, retrieved 2026-07-28)",
      },
      // Placeholder until May 2026 publication is verified (month: 2026-05).
      "2026-05": {
        rmPerKwh: 0.1893,
        provenance: "manual_assumption" as SourceType,
        source:
          "placeholder = most recent verified month (Feb 2026); May 2026 publication pending manual check",
      },
    } satisfies Record<string, AverageSmpEntry>,
    // Gazette section 2 MAQ definition: capacity (kWac) × sun-hours × days in period.
    sunHoursPerDay: 5,
    // Non-domestic hard cap (GP/ST/No.60/2025 eligibility).
    nonDomesticCapKwac: 1000,
    // Our capacity fields are kWp — used as a proxy for kWac (stated assumption).
    kwpAsKwacProxy: true,
  },

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

  // --- KREDIT sweep / action candidates (I5) ---
  kredit: {
    /** Minimum value_leak.total_rm (RM) to emit a load_shift candidate. */
    valueLeakThresholdRm: 100,
    /** Max non-escalate actions committed per site in one sweep (governor rate_limit). */
    maxNonEscalateActionsPerSite: 3,
    /** Bounded retries when saveAction returns already_exists (C4). */
    proposeMaxRetries: 5,
  },
};

export type Assumptions = typeof assumptions;
