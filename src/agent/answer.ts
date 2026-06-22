// Deterministic 7-part answer renderer (PDR-005 §4). Builds the copilot's structured
// answer directly from tool outputs, so it is grounded by construction. Used as the
// offline demo path and as the safe fallback when a live-agent answer fails grounding.

import type { SolarOpsService } from "../services/solarops";

export type SiteTriage = {
  site: ReturnType<SolarOpsService["lookupSolarSite"]>;
  forecast: ReturnType<SolarOpsService["forecast"]>;
  detect: ReturnType<SolarOpsService["detectAssetUnderperformance"]>;
  explain: ReturnType<SolarOpsService["explainSolarAnomaly"]>;
  rank: ReturnType<SolarOpsService["rankOmActions"]>;
};

const int = (n: number): string => Math.round(n).toLocaleString("en-US");
const pct = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;

function nextStep(severity: string): string {
  switch (severity) {
    case "data_issue":
      return "Fix the telemetry/data feed and re-run the analysis before any field action.";
    case "anomaly":
    case "critical":
      return "Prioritise the inspection above; re-run triage after the fault is confirmed.";
    case "watch":
      return "Keep monitoring; re-check at the next interval.";
    default:
      return "No action needed; continue routine monitoring.";
  }
}

export function renderSiteTriageAnswer(t: SiteTriage): string {
  const top = t.rank.recommendations[0];
  const impact =
    top && top.expected_recovery_kwh_month > 0
      ? `Estimated recovery **${int(top.expected_recovery_kwh_month)} kWh/month** ≈ **RM ${int(top.estimated_rm_value)}** and **${int(top.estimated_co2_kg)} kg CO₂** avoided (model estimate).`
      : "No recoverable energy is credited until the underlying issue (data quality) is resolved.";

  const caveats = [...t.explain.caveats];
  if (t.site.is_fixture) caveats.push("Data is labeled fixture_data (demo dataset).");

  return [
    `**Finding** — ${t.site.name} (${t.site.region}, ${int(t.site.capacity_kwp)} kWp) is **${t.detect.severity}**: observed ${int(t.detect.observed_kwh)} kWh vs an expected ${int(t.detect.expected_kwh)} kWh, a ${pct(t.detect.residual_pct)} residual after weather adjustment.`,
    "",
    `**Evidence** — ${t.explain.evidence.join(" ")}`,
    "",
    `**Likely cause** — ${t.explain.likely_cause} (confidence: ${t.explain.confidence}).`,
    "",
    `**Recommended action** — ${top ? top.action : "Operator review."} ${top ? `(confidence: ${top.confidence})` : ""}`.trim(),
    "",
    `**Estimated impact** — ${impact}`,
    "",
    `**Assumptions / caveats** — ${caveats.join(" ")}`,
    "",
    `**Next step** — ${nextStep(t.detect.severity)}`,
    "",
    `_Numbers are produced by deterministic tools (model ${t.forecast.model_version}); none are invented. No autonomous dispatch, control, trading, or guaranteed savings is implied._`,
  ].join("\n");
}

export type PortfolioForecast = {
  sites: { site: SiteTriage["site"]; forecast: SiteTriage["forecast"] }[];
  grid: ReturnType<SolarOpsService["lookupGridDemand"]>;
};

export function renderPortfolioForecastAnswer(p: PortfolioForecast): string {
  const rows = p.sites
    .map(
      ({ site, forecast }) =>
        `- **${site.name}**: expected **${int(forecast.expected_kwh)} kWh** (band ${int(forecast.lower_kwh)}–${int(forecast.upper_kwh)} kWh), status ${site.latest_status}.`,
    )
    .join("\n");

  const gridLine =
    p.grid.snapshots.length > 0
      ? `**Demand context** — Peninsular Malaysia day-ahead demand peaks around ${int(Math.max(...p.grid.snapshots.map((s) => s.demand_mw ?? 0)))} MW (${p.grid.source}).`
      : "**Demand context** — unavailable for the requested region/horizon.";

  return [
    "**Finding** — Day-ahead portfolio forecast (deterministic baseline):",
    "",
    rows,
    "",
    gridLine,
    "",
    `**Assumptions / caveats** — Forecasts use the ${p.sites[0]?.forecast.model_version ?? "baseline"} weather-adjusted model on fixture_data; bands are ±8%. Metrics labeled fixture_wape are in-sample fixture backtests, not real-world accuracy claims.`,
    "",
    "**Next step** — Review any non-healthy site in detail before the operating day.",
  ].join("\n");
}
