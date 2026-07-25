// Report generator v1 (PDR-006 §4). Produces a Markdown report that distinguishes
// observed data, model estimates, and likely cause, and ALWAYS includes the source
// manifest + assumptions (PDR-007 acceptance: 100% provenance presence).

import { MODEL_VERSION } from "../config/assumptions";
import type {
  AnomalyResult,
  ForecastResult,
  Recommendation,
  Report,
  ReportFormat,
  RootCauseResult,
  Site,
  SourceManifest,
} from "../domain/types";

export function renderManifest(m: SourceManifest): string {
  const inputs = m.inputs
    .map((i) => {
      const url = i.url ? ` — ${i.url}` : "";
      const label = i.isFixture ? " _(fixture_data)_" : "";
      return `- **${i.name}** — _${i.sourceType}_: ${i.sourceName}${url}${label}`;
    })
    .join("\n");
  const assumptions = m.assumptions
    .map((a) => `| ${a.name} | ${a.value} | ${a.note ?? ""} |`)
    .join("\n");
  return [
    `Run ID: \`${m.runId}\`  `,
    `Generated: ${m.generatedAt}  `,
    `Model version: \`${MODEL_VERSION}\``,
    "",
    "**Inputs**",
    "",
    inputs,
    "",
    "**Assumptions**",
    "",
    "| Name | Value | Note |",
    "| --- | --- | --- |",
    assumptions,
  ].join("\n");
}

export interface ReportArgs {
  site: Site;
  anomaly: AnomalyResult;
  rootCause: RootCauseResult;
  recommendations: Recommendation[];
  manifest: SourceManifest;
  forecast?: ForecastResult;
  format?: ReportFormat;
  reportId: string;
  anomalyEventId?: string | null;
  now?: string;
}

export function generateReport(args: ReportArgs): Report {
  const { site, anomaly, rootCause, recommendations, manifest } = args;
  const top = recommendations[0];
  const residualPctStr = (anomaly.residualPct * 100).toFixed(1);
  const createdAt = args.now ?? new Date().toISOString();

  const evidenceList = rootCause.evidence.map((e) => `- ${e}`).join("\n");
  const recAssumptions = top
    ? Object.entries(top.assumptions)
        .map(([k, v]) => `| ${k} | ${v} |`)
        .join("\n")
    : "| (none) | |";

  const content = [
    "# SolarPulse Site Performance Report",
    "",
    `**Site:** ${site.name} (${site.region}) — ${site.capacityKwp} kWp  `,
    `**Status:** ${anomaly.severity}  `,
    site.isFixture ? "**Data:** fixture_data (clearly labeled demo dataset)" : "",
    "",
    "## Executive Summary",
    "",
    `Site **${site.name}** generated **${anomaly.observedKwh} kWh** (observed) from ${anomaly.windowStart} to ${anomaly.windowEnd}, ` +
      `compared with an expected **${anomaly.expectedKwh} kWh** (model estimate, \`${MODEL_VERSION}\` weather-adjusted baseline). ` +
      `The residual was **${residualPctStr}%**.`,
    "",
    "## Likely Cause",
    "",
    `Likely cause: **${rootCause.likelyCause}**  `,
    `Confidence: **${rootCause.confidence}**`,
    "",
    "Evidence:",
    evidenceList,
    "",
    "## Recommended Action",
    "",
    top
      ? [
          `Top action: **${top.action}**  `,
          `Expected recovery: **${top.expectedRecoveryKwhMonth} kWh/month** (model estimate)  `,
          `Estimated value: **RM ${top.estimatedRmValue}**  `,
          `Estimated avoided CO₂: **${top.estimatedCo2Kg} kg CO₂e**`,
        ].join("\n")
      : "No action recommended.",
    "",
    "### Action assumptions",
    "",
    "| Assumption | Value |",
    "| --- | --- |",
    recAssumptions,
    "",
    "## Assumptions & Source Provenance",
    "",
    renderManifest(manifest),
    "",
    "## Caveats",
    "",
    "This report includes model estimates labeled above. Numbers are produced by deterministic tools, " +
      "not invented by the assistant. Field verification is required before physical maintenance decisions. " +
      "No autonomous dispatch, grid/inverter control, energy trading, or guaranteed savings is implied.",
    "",
  ].join("\n");

  return {
    reportId: args.reportId,
    siteId: site.id,
    anomalyEventId: args.anomalyEventId ?? null,
    title: `SolarPulse Performance Report — ${site.name}`,
    format: args.format ?? "markdown",
    content,
    includesProvenance: true,
    includesAssumptions: true,
    sourceManifest: manifest,
    createdAt,
  };
}
