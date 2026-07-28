// Green Performance Report (GPR) — client-facing monthly site performance report.
// Formats deterministic engine outputs only; no LLM (ADR-0005).
// Builds a structured GreenReportData first; markdown is derived from it.

import { assumptions as A, MODEL_VERSION } from "../config/assumptions";
import type {
  AnomalyResult,
  Confidence,
  LikelyCause,
  Report,
  RootCauseResult,
  Severity,
  Site,
  SourceManifest,
} from "../domain/types";
import { lvVolumetricStackRmPerKwh } from "./atap";
import { round } from "./math";
import { renderManifest } from "./report";

const CAUSE_PLAIN: Record<LikelyCause, string> = {
  weather_explained: "weather (output within weather-adjusted expectation)",
  inverter_or_string_underperformance: "inverter or string underperformance",
  soiling_or_degradation: "soiling or module degradation",
  telemetry_data_quality_issue: "telemetry / data-quality issue",
  possible_curtailment_or_grid_issue: "possible curtailment or grid issue",
  unknown_operator_review_required: "unknown — operator review required",
};

function plainCause(cause: LikelyCause): string {
  return CAUSE_PLAIN[cause];
}

/**
 * Coverage caveat for data_issue: denominator is measurable intervals
 * (expected generation > 0, i.e. daylight), not the full 24h window.
 */
function coverageNote(args: {
  anomaly: AnomalyResult;
  validMeasurableIntervals?: number;
  measurableIntervals?: number;
}): string | undefined {
  if (args.anomaly.severity !== "data_issue") return undefined;
  const measurable = args.measurableIntervals;
  const valid = args.validMeasurableIntervals;
  if (measurable != null && measurable > 0 && valid != null) {
    return `based on ${valid} of ~${measurable} measurable intervals`;
  }
  // Fallback: all-interval counts (legacy path if service did not pass measurable).
  const validAll = args.anomaly.evidence.validIntervals;
  const total = args.anomaly.evidence.validIntervals + args.anomaly.evidence.missingIntervals;
  return `based on ${validAll} of ${total} valid intervals`;
}

function productionSentence(args: {
  siteName: string;
  observedKwh: number;
  expectedKwh: number;
  indexDisplay: string;
  severity: Severity;
  coverage?: string;
}): string {
  const { siteName, observedKwh, expectedKwh, indexDisplay, severity, coverage } = args;
  const coverageSuffix = coverage ? ` (${coverage})` : "";

  if (expectedKwh === 0) {
    return (
      `Site **${siteName}** has no weather-adjusted expectation available for the period ` +
      `(**${observedKwh} kWh** observed${coverageSuffix}; performance index **n/a**).`
    );
  }

  if (severity === "healthy") {
    return (
      `Site **${siteName}** performed in line with its weather-adjusted expectation over the period, ` +
      `generating **${observedKwh} kWh** against an expected **${expectedKwh} kWh** ` +
      `(performance index (observed / expected) **${indexDisplay}**).`
    );
  }
  if (severity === "data_issue") {
    return (
      `Site **${siteName}** has incomplete or noisy telemetry over the period ` +
      `(**${observedKwh} kWh** observed${coverageSuffix} vs **${expectedKwh} kWh** weather-adjusted expected; ` +
      `performance index (observed / expected) **${indexDisplay}**). ` +
      `Treat figures as provisional until data quality is restored.`
    );
  }
  return (
    `Site **${siteName}** underperformed its weather-adjusted expectation over the period, ` +
    `generating **${observedKwh} kWh** against an expected **${expectedKwh} kWh** ` +
    `(performance index (observed / expected) **${indexDisplay}**).`
  );
}

export interface GreenReportData {
  title: string;
  reportId: string;
  siteName: string;
  region: string;
  capacityKwp: number;
  fixtureLabel: boolean;
  windowStart: string;
  windowEnd: string;
  production: {
    observedKwh: number;
    expectedKwh: number;
    /** null when expectedKwh === 0 (index is n/a). */
    performanceIndexPct: number | null;
    performanceIndexDisplay: string;
    sentence: string;
    coverageNote?: string;
  };
  incidents: {
    severity: Severity;
    causePlain?: string;
    confidence?: Confidence;
    evidence: string[];
    /** Extra prose after status/evidence (healthy note or data_issue disclaimer). */
    footerNote?: string;
  };
  value: {
    /** Total energy value RM (avoided cost + export credit for ATAP-eligible; single-rate otherwise). */
    rmValue: number;
    /** Single-rate tariff for ineligible sites; energy charge for eligible bill context. */
    tariffRmPerKwh: number;
    co2Kg: number;
    carbonFactor: number;
    /** Present when ATAP-eligible valuation is used. */
    valuationMode?: "atap_stack" | "single_rate";
    selfConsumedKwh?: number;
    exportedKwh?: number;
    /** Self-consumed × full LV volumetric stack (avoided cost). */
    avoidedCostRm?: number;
    /** Exported × Average SMP (export credit). */
    exportCreditRm?: number;
    volumetricStackRmPerKwh?: number;
    averageSmpRmPerKwh?: number;
  };
  manifest: SourceManifest;
  modelVersion: string;
  caveats: string;
}

export interface GreenReportArgs {
  site: Site;
  anomaly: AnomalyResult;
  rootCause: RootCauseResult;
  manifest: SourceManifest;
  reportId: string;
  anomalyEventId?: string | null;
  now?: string;
  /** ATAP eligibility for the site (passed in — engine stays pure). */
  atapEligible?: boolean;
  /** Average SMP RM/kWh for export-credit valuation (ATAP-eligible path). */
  averageSmpRmPerKwh?: number;
  /** Period self-consumed kWh (generation − export) for ATAP stack valuation. */
  selfConsumedKwh?: number;
  /** Period exported kWh for ATAP stack valuation. */
  exportedKwh?: number;
  /** Intervals with expected generation > 0 (daylight measurable denominator). */
  measurableIntervals?: number;
  /** Of measurable intervals, how many have non-null generation. */
  validMeasurableIntervals?: number;
}

export interface GreenReportResult {
  report: Report;
  data: GreenReportData;
}

function resolvedManifest(
  base: SourceManifest,
  tariff: number,
  carbon: number,
  performanceRatio: number,
  extra: Array<{ name: string; value: number | string; note?: string }> = [],
): SourceManifest {
  return {
    ...base,
    assumptions: [
      {
        name: "tariff_assumption_rm_per_kwh",
        value: tariff,
        note: "Demo-only configurable assumption; not a quoted tariff.",
      },
      {
        name: "carbon_factor_kgco2_per_kwh",
        value: carbon,
        note: "Demo-only configurable factor; replace with approved factor before production.",
      },
      {
        name: "performance_ratio",
        value: performanceRatio,
        note: "Baseline performance ratio; per-site value used where available.",
      },
      ...extra,
    ],
  };
}

function buildIncidentsBody(data: GreenReportData["incidents"]): string {
  const { severity, causePlain, confidence, evidence, footerNote } = data;
  const isAnomalous = severity === "watch" || severity === "anomaly" || severity === "critical";

  if (isAnomalous) {
    return [
      `**Status:** ${severity}  `,
      `**Likely cause:** ${causePlain}  `,
      `**Confidence:** ${confidence}`,
      "",
      "Evidence:",
      ...evidence.map((e) => `- ${e}`),
    ].join("\n");
  }

  if (severity === "data_issue") {
    return [
      `**Status:** data_issue  `,
      `**Likely cause:** ${causePlain}  `,
      `**Confidence:** ${confidence}`,
      "",
      "Evidence:",
      ...evidence.map((e) => `- ${e}`),
      "",
      footerNote ?? "No equipment fault is confirmed while telemetry quality is insufficient.",
    ].join("\n");
  }

  return [
    `**Status:** ${severity}  `,
    footerNote ??
      "No performance incidents detected in this reporting period. " +
        `Generation was within the weather-adjusted expectation (model \`${MODEL_VERSION}\`).`,
  ].join("\n");
}

function renderValueSection(v: GreenReportData["value"]): string {
  if (v.valuationMode === "atap_stack") {
    return [
      `Energy value of observed production: **RM ${v.rmValue}** ` +
        `(avoided cost of self-consumed kWh at full LV volumetric stack RM ${v.volumetricStackRmPerKwh}/kWh ` +
        `+ export credit at Average SMP RM ${v.averageSmpRmPerKwh}/kWh).  `,
      `- Avoided cost (self-consumed **${v.selfConsumedKwh} kWh** × RM ${v.volumetricStackRmPerKwh}/kWh): **RM ${v.avoidedCostRm}**  `,
      `- Export credit (exported **${v.exportedKwh} kWh** × RM ${v.averageSmpRmPerKwh}/kWh): **RM ${v.exportCreditRm}**  `,
      `CO₂ avoided from observed production: **${v.co2Kg} kg CO₂e** ` +
        `(at ${v.carbonFactor} kgCO₂e/kWh carbon factor).`,
    ].join("\n");
  }
  return (
    `Energy value of observed production: **RM ${v.rmValue}** ` +
    `(at RM ${v.tariffRmPerKwh}/kWh tariff assumption).  \n` +
    `CO₂ avoided from observed production: **${v.co2Kg} kg CO₂e** ` +
    `(at ${v.carbonFactor} kgCO₂e/kWh carbon factor).`
  );
}

function renderMarkdown(data: GreenReportData): string {
  const { production: p, value: v } = data;
  const observedCell = p.coverageNote
    ? `**${p.observedKwh} kWh** (${p.coverageNote})`
    : `**${p.observedKwh} kWh**`;

  return [
    "# Green Performance Report",
    "",
    `**Site:** ${data.siteName} (${data.region}) — ${data.capacityKwp} kWp  `,
    `**Reporting period:** ${data.windowStart} → ${data.windowEnd}  `,
    data.fixtureLabel
      ? "**Data:** fixture_data (clearly labeled demo dataset — not live telemetry)"
      : "**Data:** live / partner telemetry",
    "",
    "## Production Summary",
    "",
    `| Metric | Value |`,
    `| --- | --- |`,
    `| Observed generation | ${observedCell} |`,
    `| Weather-adjusted expected | **${p.expectedKwh} kWh** |`,
    `| Performance index (observed / expected) | **${p.performanceIndexDisplay}** |`,
    "",
    p.sentence,
    "",
    "## Incidents",
    "",
    buildIncidentsBody(data.incidents),
    "",
    "## Value & Sustainability",
    "",
    renderValueSection(v),
    "",
    "## Assumptions & Source Provenance",
    "",
    renderManifest(data.manifest),
    "",
    "## Caveats",
    "",
    data.caveats,
    "",
  ].join("\n");
}

export function generateGreenReport(args: GreenReportArgs): GreenReportResult {
  const { site, anomaly, rootCause } = args;
  const createdAt = args.now ?? new Date().toISOString();

  const observedKwh = anomaly.observedKwh;
  const expectedKwh = anomaly.expectedKwh;
  const hasIndex = expectedKwh > 0;
  const performanceIndexPct = hasIndex ? round(observedKwh / expectedKwh, 4) : null;
  const performanceIndexDisplay = hasIndex
    ? `${((performanceIndexPct as number) * 100).toFixed(1)}%`
    : "n/a";

  // Resolve per-site overrides (same values used in body and provenance manifest).
  const tariff = site.tariffAssumptionRmPerKwh ?? A.retailTariffRmPerKwh;
  const carbon = site.carbonFactorKgco2PerKwh ?? A.carbonFactorKgco2PerKwh;
  const co2AvoidedKg = round(observedKwh * carbon);

  const atapEligible = args.atapEligible === true;
  const stack = lvVolumetricStackRmPerKwh(A);
  const smp = args.averageSmpRmPerKwh;
  const selfConsumed = args.selfConsumedKwh;
  const exported = args.exportedKwh;

  let energyValueRm: number;
  let valueFields: GreenReportData["value"];
  const extraManifest: Array<{ name: string; value: number | string; note?: string }> = [];

  if (
    atapEligible &&
    smp != null &&
    selfConsumed != null &&
    exported != null
  ) {
    const avoidedCostRm = round(selfConsumed * stack);
    const exportCreditRm = round(exported * smp);
    energyValueRm = round(avoidedCostRm + exportCreditRm);
    valueFields = {
      rmValue: energyValueRm,
      tariffRmPerKwh: tariff,
      co2Kg: co2AvoidedKg,
      carbonFactor: carbon,
      valuationMode: "atap_stack",
      selfConsumedKwh: round(selfConsumed),
      exportedKwh: round(exported),
      avoidedCostRm,
      exportCreditRm,
      volumetricStackRmPerKwh: stack,
      averageSmpRmPerKwh: smp,
    };
    extraManifest.push(
      {
        name: "lv_volumetric_stack_rm_per_kwh",
        value: stack,
        note: "Full LV avoided-cost stack (energy + capacity + network) for self-consumed kWh.",
      },
      {
        name: "average_smp_rm_per_kwh",
        value: smp,
        note: "Average SMP applied to exported kWh (export credit).",
      },
    );
  } else {
    energyValueRm = round(observedKwh * tariff);
    valueFields = {
      rmValue: energyValueRm,
      tariffRmPerKwh: tariff,
      co2Kg: co2AvoidedKg,
      carbonFactor: carbon,
      valuationMode: "single_rate",
    };
  }

  const manifest = resolvedManifest(
    args.manifest,
    tariff,
    carbon,
    site.performanceRatio,
    extraManifest,
  );

  const coverage = coverageNote({
    anomaly,
    measurableIntervals: args.measurableIntervals,
    validMeasurableIntervals: args.validMeasurableIntervals,
  });
  const sentence = productionSentence({
    siteName: site.name,
    observedKwh,
    expectedKwh,
    indexDisplay: performanceIndexDisplay,
    severity: anomaly.severity,
    coverage,
  });

  const isAnomalous =
    anomaly.severity === "watch" ||
    anomaly.severity === "anomaly" ||
    anomaly.severity === "critical";

  const incidents: GreenReportData["incidents"] =
    isAnomalous || anomaly.severity === "data_issue"
      ? {
          severity: anomaly.severity,
          causePlain: plainCause(rootCause.likelyCause),
          confidence: rootCause.confidence,
          evidence: rootCause.evidence,
          ...(anomaly.severity === "data_issue"
            ? {
                footerNote:
                  "No equipment fault is confirmed while telemetry quality is insufficient.",
              }
            : {}),
        }
      : {
          severity: anomaly.severity,
          evidence: [],
          footerNote:
            "No performance incidents detected in this reporting period. " +
            `Generation was within the weather-adjusted expectation (model \`${MODEL_VERSION}\`).`,
        };

  const title = `Green Performance Report — ${site.name}`;
  const caveats =
    "This Green Performance Report formats deterministic model estimates and fixture or partner inputs. " +
    "Financial and carbon figures use configurable demo assumptions, not quoted tariffs or approved emission factors. " +
    "Field verification is required before maintenance decisions. " +
    "No autonomous dispatch, grid/inverter control, energy trading, or guaranteed savings is implied.";

  const data: GreenReportData = {
    title,
    reportId: args.reportId,
    siteName: site.name,
    region: site.region,
    capacityKwp: site.capacityKwp,
    fixtureLabel: site.isFixture,
    windowStart: anomaly.windowStart,
    windowEnd: anomaly.windowEnd,
    production: {
      observedKwh,
      expectedKwh,
      performanceIndexPct,
      performanceIndexDisplay,
      sentence,
      ...(coverage ? { coverageNote: coverage } : {}),
    },
    incidents,
    value: valueFields,
    manifest,
    modelVersion: MODEL_VERSION,
    caveats,
  };

  const content = renderMarkdown(data);

  const report: Report = {
    reportId: args.reportId,
    siteId: site.id,
    anomalyEventId: args.anomalyEventId ?? null,
    title,
    format: "markdown",
    content,
    includesProvenance: true,
    includesAssumptions: true,
    sourceManifest: manifest,
    createdAt,
  };

  return { report, data };
}
