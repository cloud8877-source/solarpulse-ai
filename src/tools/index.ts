// SolarOps AI SDK tools (PDR-005 / tool_contracts.yaml). Thin, zod-validated wrappers
// over the deterministic service layer. The agent calls these; it must never compute
// kWh/RM/CO2/% itself — every number here is tool-computed (ADR-0005).

import { tool } from "ai";
import { z } from "zod";
import { solarOps } from "../services/solarops";

const severityEnum = z.enum(["healthy", "watch", "anomaly", "critical", "data_issue"]);
const confidenceEnum = z.enum(["low", "medium", "high"]);
const causeEnum = z.enum([
  "weather_explained",
  "inverter_or_string_underperformance",
  "soiling_or_degradation",
  "telemetry_data_quality_issue",
  "possible_curtailment_or_grid_issue",
  "unknown_operator_review_required",
]);
const metricSchema = z.object({ name: z.string(), value: z.number().nullable() });
const assumptionListSchema = z.array(
  z.object({ name: z.string(), value: z.union([z.number(), z.string()]), note: z.string().optional() }),
);
const evidenceSchema = z.object({
  weatherNormal: z.boolean(),
  persistentIntervals: z.number(),
  validIntervals: z.number(),
  missingIntervals: z.number(),
  noisyIntervals: z.number(),
  inverterSignal: z.string().optional(),
  notes: z.array(z.string()),
});

export const lookupSolarSiteTool = tool({
  description:
    "Return solar site metadata and its latest computed health status. Read-only. Use first to resolve a site before forecasting or anomaly analysis.",
  inputSchema: z.object({ site_id: z.string().describe("Site id, e.g. site_a / site_b / site_c") }),
  outputSchema: z.object({
    site_id: z.string(),
    name: z.string(),
    region: z.string(),
    capacity_kwp: z.number(),
    latest_status: severityEnum,
    is_fixture: z.boolean(),
  }),
  execute: async ({ site_id }) => solarOps().lookupSolarSite(site_id),
});

export const forecastSolarYieldTool = tool({
  description:
    "Deterministic day-ahead/week-ahead solar generation forecast (expected kWh + confidence band + fixture backtest metric). The model must report these numbers as-is, never invent them.",
  inputSchema: z.object({
    site_id: z.string(),
    horizon: z.enum(["day_ahead", "week_ahead", "custom"]).default("day_ahead"),
    run_at: z.string().optional().describe("ISO datetime the forecast is run at"),
  }),
  outputSchema: z.object({
    site_id: z.string(),
    horizon: z.string(),
    expected_kwh: z.number(),
    lower_kwh: z.number(),
    upper_kwh: z.number(),
    model_version: z.string(),
    metric: metricSchema,
    assumptions: assumptionListSchema,
    quality_flags: z.array(z.string()),
  }),
  execute: async ({ site_id, horizon, run_at }) => solarOps().forecast(site_id, horizon, run_at),
});

export const lookupGridDemandTool = tool({
  description:
    "Return public Single Buyer demand context snapshots for a region. Read-only. If no data is available the snapshots list is empty and the caller must state demand context is unavailable.",
  inputSchema: z.object({
    region: z.string().default("peninsular_malaysia"),
    horizon: z.enum(["current", "day_ahead", "week_ahead"]).default("day_ahead"),
  }),
  outputSchema: z.object({
    region: z.string(),
    horizon: z.string(),
    snapshots: z.array(z.object({ timestamp: z.string(), demand_mw: z.number().nullable() })),
    source: z.string(),
    quality_flags: z.array(z.string()),
  }),
  execute: async ({ region, horizon }) => solarOps().lookupGridDemand(region, horizon),
});

export const detectAssetUnderperformanceTool = tool({
  description:
    "Deterministically compare observed vs expected generation over a window and return residual, severity, evidence, and an anomaly_event_id. Data-quality issues short-circuit to severity=data_issue (do not diagnose equipment on bad telemetry).",
  inputSchema: z.object({
    site_id: z.string(),
    window_start: z
      .string()
      .optional()
      .describe(
        "Window start (ISO timestamp or YYYY-MM-DD). Detection windows are day-granular: the bound is converted to local (+08:00) and expanded to 00:00:00 of that calendar day. UTC/Z inputs are converted (e.g. 2026-06-19T20:00:00Z → 2026-06-20 in +08). Alone, scopes to that single local day.",
      ),
    window_end: z
      .string()
      .optional()
      .describe(
        "Window end (ISO timestamp or YYYY-MM-DD). Converted to local (+08:00) and expanded to 23:59:59.999 of that calendar day. Alone, scopes to that single local day. With window_start, multi-day windows are allowed (event id anom_<site>_<startday>_<endday>).",
      ),
  }),
  outputSchema: z.object({
    anomaly_event_id: z.string(),
    site_id: z.string(),
    observed_kwh: z.number(),
    expected_kwh: z.number(),
    residual_kwh: z.number(),
    residual_pct: z.number(),
    severity: severityEnum,
    quality_flags: z.array(z.string()),
    evidence: evidenceSchema,
  }),
  execute: async ({ site_id, window_start, window_end }) =>
    solarOps().detectAssetUnderperformance(site_id, window_start, window_end),
});

export const explainSolarAnomalyTool = tool({
  description:
    "Return the rule-based likely cause, confidence, evidence, and caveats for a persisted anomaly event id (from detect_asset_underperformance).",
  inputSchema: z.object({ anomaly_event_id: z.string() }),
  outputSchema: z.object({
    likely_cause: causeEnum,
    confidence: confidenceEnum,
    evidence: z.array(z.string()),
    caveats: z.array(z.string()),
  }),
  execute: async ({ anomaly_event_id }) => solarOps().explainSolarAnomaly(anomaly_event_id),
});

export const rankOmActionsTool = tool({
  description:
    "Return O&M actions ranked by likely impact for an anomaly event, each with deterministic expected recovery kWh/month, estimated RM value, estimated CO2, confidence, and the assumptions used. Recommends inspection/review only — never autonomous dispatch.",
  inputSchema: z.object({ anomaly_event_id: z.string() }),
  outputSchema: z.object({
    recommendations: z.array(
      z.object({
        rank: z.number(),
        action: z.string(),
        expected_recovery_kwh_month: z.number(),
        estimated_rm_value: z.number(),
        estimated_co2_kg: z.number(),
        confidence: confidenceEnum,
        assumptions: z.record(z.string(), z.union([z.number(), z.string()])),
      }),
    ),
  }),
  execute: async ({ anomaly_event_id }) => solarOps().rankOmActions(anomaly_event_id),
});

export const generateSolarReportTool = tool({
  description:
    "Generate an owner/O&M Markdown report for a site + anomaly event. Always includes source provenance and assumptions, labels fixture data, and states field verification is required.",
  inputSchema: z.object({
    site_id: z.string(),
    anomaly_event_id: z.string(),
    format: z.enum(["markdown", "pdf"]).default("markdown"),
  }),
  outputSchema: z.object({
    report_id: z.string(),
    format: z.string(),
    url_or_path: z.string(),
    includes_provenance: z.boolean(),
    includes_assumptions: z.boolean(),
    content: z.string(),
  }),
  execute: async ({ site_id, anomaly_event_id, format }) =>
    solarOps().generateSolarReport(site_id, anomaly_event_id, format),
});

export const solaropsTools = {
  lookup_solar_site: lookupSolarSiteTool,
  forecast_solar_yield: forecastSolarYieldTool,
  lookup_grid_demand: lookupGridDemandTool,
  detect_asset_underperformance: detectAssetUnderperformanceTool,
  explain_solar_anomaly: explainSolarAnomalyTool,
  rank_om_actions: rankOmActionsTool,
  generate_solar_report: generateSolarReportTool,
};
