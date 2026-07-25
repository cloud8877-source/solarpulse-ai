// Green Performance Report (GPR) — client-facing monthly site performance report.
// Formats deterministic engine outputs only; no LLM (ADR-0005).

import { assumptions as A, MODEL_VERSION } from "../config/assumptions";
import type {
  AnomalyResult,
  Report,
  ReportFormat,
  RootCauseResult,
  Site,
  SourceManifest,
} from "../domain/types";
import { round } from "./math";
import { renderManifest } from "./report";

const CAUSE_PLAIN: Record<string, string> = {
  weather_explained: "weather (output within weather-adjusted expectation)",
  inverter_or_string_underperformance: "inverter or string underperformance",
  soiling_or_degradation: "soiling or module degradation",
  telemetry_data_quality_issue: "telemetry / data-quality issue",
  possible_curtailment_or_grid_issue: "possible curtailment or grid issue",
  unknown_operator_review_required: "unknown — operator review required",
};

function plainCause(cause: string): string {
  return CAUSE_PLAIN[cause] ?? cause.replace(/_/g, " ");
}

function productionSentence(
  siteName: string,
  observedKwh: number,
  expectedKwh: number,
  pr: number,
  severity: string,
): string {
  const prPct = (pr * 100).toFixed(1);
  if (severity === "healthy") {
    return (
      `Site **${siteName}** performed in line with its weather-adjusted expectation over the period, ` +
      `generating **${observedKwh} kWh** against an expected **${expectedKwh} kWh** ` +
      `(simple performance ratio **${prPct}%**).`
    );
  }
  if (severity === "data_issue") {
    return (
      `Site **${siteName}** has incomplete or noisy telemetry over the period ` +
      `(**${observedKwh} kWh** observed vs **${expectedKwh} kWh** weather-adjusted expected; ` +
      `simple performance ratio **${prPct}%**). Treat figures as provisional until data quality is restored.`
    );
  }
  return (
    `Site **${siteName}** underperformed its weather-adjusted expectation over the period, ` +
    `generating **${observedKwh} kWh** against an expected **${expectedKwh} kWh** ` +
    `(simple performance ratio **${prPct}%**).`
  );
}

export interface GreenReportArgs {
  site: Site;
  anomaly: AnomalyResult;
  rootCause: RootCauseResult;
  manifest: SourceManifest;
  reportId: string;
  format?: ReportFormat;
  now?: string;
}

export function generateGreenReport(args: GreenReportArgs): Report {
  const { site, anomaly, rootCause, manifest } = args;
  const createdAt = args.now ?? new Date().toISOString();

  const observedKwh = anomaly.observedKwh;
  const expectedKwh = anomaly.expectedKwh;
  const performanceRatio = expectedKwh > 0 ? round(observedKwh / expectedKwh, 4) : 0;

  const tariff = site.tariffAssumptionRmPerKwh ?? A.tariffRmPerKwh;
  const carbon = site.carbonFactorKgco2PerKwh ?? A.carbonFactorKgco2PerKwh;
  const energyValueRm = round(observedKwh * tariff);
  const co2AvoidedKg = round(observedKwh * carbon);

  const isAnomalous =
    anomaly.severity === "watch" ||
    anomaly.severity === "anomaly" ||
    anomaly.severity === "critical";

  const incidentsBody = isAnomalous
    ? [
        `**Status:** ${anomaly.severity}  `,
        `**Likely cause:** ${plainCause(rootCause.likelyCause)}  `,
        `**Confidence:** ${rootCause.confidence}`,
        "",
        "Evidence:",
        ...rootCause.evidence.map((e) => `- ${e}`),
      ].join("\n")
    : anomaly.severity === "data_issue"
      ? [
          `**Status:** data_issue  `,
          `**Likely cause:** ${plainCause(rootCause.likelyCause)}  `,
          `**Confidence:** ${rootCause.confidence}`,
          "",
          "No equipment fault is confirmed while telemetry quality is insufficient.",
        ].join("\n")
      : [
          `**Status:** ${anomaly.severity}  `,
          "No performance incidents detected in this reporting period. " +
            `Generation was within the weather-adjusted expectation (model \`${MODEL_VERSION}\`).`,
        ].join("\n");

  const content = [
    "# Green Performance Report",
    "",
    `**Site:** ${site.name} (${site.region}) — ${site.capacityKwp} kWp  `,
    `**Reporting period:** ${anomaly.windowStart} → ${anomaly.windowEnd}  `,
    site.isFixture
      ? "**Data:** fixture_data (clearly labeled demo dataset — not live telemetry)"
      : "**Data:** live / partner telemetry",
    "",
    "## Production Summary",
    "",
    `| Metric | Value |`,
    `| --- | --- |`,
    `| Observed generation | **${observedKwh} kWh** |`,
    `| Weather-adjusted expected | **${expectedKwh} kWh** |`,
    `| Simple performance ratio | **${(performanceRatio * 100).toFixed(1)}%** |`,
    "",
    productionSentence(site.name, observedKwh, expectedKwh, performanceRatio, anomaly.severity),
    "",
    "## Incidents",
    "",
    incidentsBody,
    "",
    "## Value & Sustainability",
    "",
    `Energy value of observed production: **RM ${energyValueRm}** ` +
      `(at RM ${tariff}/kWh tariff assumption).  `,
    `CO₂ avoided from observed production: **${co2AvoidedKg} kg CO₂e** ` +
      `(at ${carbon} kgCO₂e/kWh carbon factor).`,
    "",
    "## Assumptions & Source Provenance",
    "",
    renderManifest(manifest),
    "",
    "## Caveats",
    "",
    "This Green Performance Report formats deterministic model estimates and fixture or partner inputs. " +
      "Financial and carbon figures use configurable demo assumptions, not quoted tariffs or approved emission factors. " +
      "Field verification is required before maintenance decisions. " +
      "No autonomous dispatch, grid/inverter control, energy trading, or guaranteed savings is implied.",
    "",
  ].join("\n");

  return {
    reportId: args.reportId,
    siteId: site.id,
    anomalyEventId: null,
    title: `Green Performance Report — ${site.name}`,
    format: args.format ?? "markdown",
    content,
    includesProvenance: true,
    includesAssumptions: true,
    sourceManifest: manifest,
    createdAt,
  };
}
