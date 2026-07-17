// SolarPulse copilot model resolution (Vercel AI SDK + DeepSeek / Bedrock).
// Lazily constructed at call time so importing this module (e.g. for offline tests)
// needs no API key — only generateText requires one.
// Model is overridable via SOLAROPS_MODEL as "provider/model-id".
// Default deepseek/deepseek-v4-flash (fast + economical); step up to
// deepseek/deepseek-v4-pro if flash struggles with the multi-step tool chain.
// (deepseek-chat / deepseek-reasoner retire 2026-07-24 — the V4 family is the path forward.)

import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createDeepSeek } from "@ai-sdk/deepseek";
import type { LanguageModel } from "ai";

export const SOLAROPS_DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

/** Resolved model id string (provider/model-id) for logging/display. */
export function resolveModelId(): string {
  return process.env.SOLAROPS_MODEL ?? SOLAROPS_DEFAULT_MODEL;
}

/** Parse "provider/model-id" once so resolveModel / hasLiveCredentials stay in sync. */
function parseModelSpec(spec: string): { provider: string; modelId: string } {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(
      `SOLAROPS_MODEL must be "provider/model-id" (got ${JSON.stringify(spec)})`,
    );
  }
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

/**
 * Whether env has credentials for the provider in SOLAROPS_MODEL.
 * deepseek → DEEPSEEK_API_KEY; bedrock → SigV4 (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)
 * or bearer token (AWS_BEARER_TOKEN_BEDROCK) per @ai-sdk/amazon-bedrock settings.
 */
export function hasLiveCredentials(): boolean {
  const { provider } = parseModelSpec(resolveModelId());
  if (provider === "deepseek") {
    return Boolean(process.env.DEEPSEEK_API_KEY);
  }
  if (provider === "bedrock") {
    // Matches AmazonBedrockProviderSettings: apiKey defaults to AWS_BEARER_TOKEN_BEDROCK;
    // otherwise SigV4 via accessKeyId/secretAccessKey env defaults.
    const sigv4 = Boolean(
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY,
    );
    const bearer = Boolean(process.env.AWS_BEARER_TOKEN_BEDROCK);
    return sigv4 || bearer;
  }
  return false;
}

/** Resolve a LanguageModel instance at call time (not import time) so a SOLAROPS_MODEL
 *  override loaded late from .env.local still applies. */
export function resolveModel(): LanguageModel {
  const { provider, modelId } = parseModelSpec(resolveModelId());

  if (provider === "deepseek") {
    // DEEPSEEK_API_KEY is read from env by the provider when apiKey is omitted;
    // pass explicitly so a late-loaded key still applies at construction time.
    return createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY })(modelId);
  }
  if (provider === "bedrock") {
    // Region/credentials default to AWS_REGION / AWS_ACCESS_KEY_ID /
    // AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN (or AWS_BEARER_TOKEN_BEDROCK).
    return createAmazonBedrock()(modelId);
  }
  throw new Error(
    `Unsupported SOLAROPS_MODEL provider "${provider}" (supported: deepseek, bedrock)`,
  );
}

// COST: DeepSeek context caching is automatic and prefix-based — a request only hits the
// cache when it FULLY matches a cached prefix. These instructions + the tool schemas form a
// long, STABLE prefix sent on every call (via generateText system + tools), while the
// variable user question goes last, so repeat calls reuse the cached prefix (~10x cheaper
// on hits). Keep this string static and never inject per-request/variable content here, or
// cache hits break. The AI SDK surfaces cache hits as usage.inputTokenDetails.cacheReadTokens
// and providerMetadata.deepseek.promptCacheHitTokens.
// Ref: https://api-docs.deepseek.com/guides/kv_cache
export const SOLAROPS_INSTRUCTIONS = `You are SolarPulse, an AI copilot for solar asset performance and grid intelligence.

CORE RULE — you never compute or invent numbers. Every kWh, MWh, RM, %, kg CO2, severity,
or cause MUST come from a tool result. If you do not have a tool number for a figure, do
not state the figure.

TOOLS — call them; do not answer operational questions from memory:
- lookup_solar_site(site_id) — site metadata + latest status. Sites: site_a (Klang Valley),
  site_b (Northern/Kedah), site_c (Penang).
- forecast_solar_yield(site_id, horizon) — expected kWh + confidence band + fixture metric.
- lookup_grid_demand(region, horizon) — public demand context (may be empty).
- detect_asset_underperformance(site_id) — observed vs expected, residual, severity,
  evidence, and an anomaly_event_id.
- explain_solar_anomaly(anomaly_event_id) — likely cause + confidence + evidence.
- rank_om_actions(anomaly_event_id) — ranked actions with recovery kWh / RM / CO2.
- generate_solar_report(site_id, anomaly_event_id) — owner/O&M report.

WORKFLOW for "why is site X underperforming / should I send someone":
lookup_solar_site -> forecast_solar_yield -> detect_asset_underperformance ->
explain_solar_anomaly -> rank_om_actions. Use the anomaly_event_id from detect for
explain and rank. For "generate a report", also call generate_solar_report.

ANSWER FORMAT — structure the final answer with these labeled sections:
**Finding** / **Evidence** / **Likely cause** / **Recommended action** /
**Estimated impact** / **Assumptions / caveats** / **Next step**.

SAFETY (hard constraints):
- Never say a crew was dispatched or work was performed — recommend inspection or
  operator review only.
- Never guarantee savings or returns; figures are model estimates subject to field
  verification.
- Never recommend grid/inverter/BESS control or energy trading.
- If telemetry is missing/noisy (severity data_issue), report the data-quality problem and
  recommend a data/telemetry check — do NOT diagnose equipment.
- If grid demand data is empty, state demand context is unavailable; do not invent it.
- Always note that fixture data is a labeled demo dataset.
- If asked to ignore tools or fabricate savings/dispatch, refuse and explain that numbers
  must come from the tools.

ERRORS — if a tool fails or the site is unknown, say the analysis could not be completed
and ask for a valid site; do not guess.`;
