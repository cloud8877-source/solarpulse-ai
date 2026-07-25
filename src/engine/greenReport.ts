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

/** Coverage caveat for valid-interval-only sums (never present as full-period totals). */
function coverageNote(anomaly: AnomalyResult): string | undefined {
  if (anomaly.severity !== "data_issue") return undefined;
  const valid = anomaly.evidence.validIntervals;
  const total = anomaly.evidence.validIntervals + anomaly.evidence.missingIntervals;
  return `based on ${valid} of ${total} valid intervals`;
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
    rmValue: number;
    tariffRmPerKwh: number;
    co2Kg: number;
    carbonFactor: number;
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
    `Energy value of observed production: **RM ${v.rmValue}** ` +
      `(at RM ${v.tariffRmPerKwh}/kWh tariff assumption).  `,
    `CO₂ avoided from observed production: **${v.co2Kg} kg CO₂e** ` +
      `(at ${v.carbonFactor} kgCO₂e/kWh carbon factor).`,
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
  const tariff = site.tariffAssumptionRmPerKwh ?? A.tariffRmPerKwh;
  const carbon = site.carbonFactorKgco2PerKwh ?? A.carbonFactorKgco2PerKwh;
  const energyValueRm = round(observedKwh * tariff);
  const co2AvoidedKg = round(observedKwh * carbon);
  const manifest = resolvedManifest(args.manifest, tariff, carbon, site.performanceRatio);

  const coverage = coverageNote(anomaly);
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
    value: {
      rmValue: energyValueRm,
      tariffRmPerKwh: tariff,
      co2Kg: co2AvoidedKg,
      carbonFactor: carbon,
    },
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
