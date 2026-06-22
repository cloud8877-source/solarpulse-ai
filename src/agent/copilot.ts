// Copilot orchestration for POST /api/solarops/ask.
//  - offline: deterministic pipeline + 7-part renderer (no API key; public demo path).
//  - live: Mastra+DeepSeek agent orchestrates the tools, then the answer is
//    safety-enforced — if it fails numeric grounding or hits the denylist, it is
//    replaced by the tool-grounded deterministic answer. The FINAL answer is always
//    grounded, which is what makes CE4 hold regardless of model behavior.

import { createSolarOpsService, type SolarOpsService } from "../services/solarops";
import {
  renderPortfolioForecastAnswer,
  renderSiteTriageAnswer,
  type SiteTriage,
} from "./answer";
import { validateAnswer, type SafetyResult } from "./safety";
import { solaropsAgent } from "./solaropsAgent";

export interface ToolTraceEntry {
  tool: string;
  input: unknown;
  output: unknown;
}

export interface CopilotResult {
  answer: string;
  mode: "live" | "offline";
  toolTrace: ToolTraceEntry[];
  safety: SafetyResult;
  adjusted: boolean; // true when a live answer was replaced for safety
  error?: string; // set when a live attempt failed and we fell back to deterministic
}

type Intent =
  | { kind: "site"; siteId: string }
  | { kind: "report"; siteId: string }
  | { kind: "portfolio" };

const ADJUST_NOTE =
  "_(Adjusted for safety: the assistant's draft contained figures or claims not supported by tool outputs; replaced with the tool-grounded analysis below.)_\n\n";

export function parseIntent(question: string): Intent {
  const q = question.toLowerCase();
  const siteId = /\bsite[_\s]*c\b|penang/.test(q)
    ? "site_c"
    : /\bsite[_\s]*b\b|northern|kedah/.test(q)
      ? "site_b"
      : /\bsite[_\s]*a\b|klang|selangor/.test(q)
        ? "site_a"
        : null;
  if (siteId && /\breport\b/.test(q)) return { kind: "report", siteId };
  if (siteId) return { kind: "site", siteId };
  return { kind: "portfolio" };
}

function siteTriage(svc: SolarOpsService, siteId: string): { triage: SiteTriage; trace: ToolTraceEntry[] } {
  const site = svc.lookupSolarSite(siteId);
  const forecast = svc.forecast(siteId, "day_ahead");
  const detect = svc.detectAssetUnderperformance(siteId);
  const explain = svc.explainSolarAnomaly(detect.anomaly_event_id);
  const rank = svc.rankOmActions(detect.anomaly_event_id);
  const trace: ToolTraceEntry[] = [
    { tool: "lookup_solar_site", input: { site_id: siteId }, output: site },
    { tool: "forecast_solar_yield", input: { site_id: siteId, horizon: "day_ahead" }, output: forecast },
    { tool: "detect_asset_underperformance", input: { site_id: siteId }, output: detect },
    { tool: "explain_solar_anomaly", input: { anomaly_event_id: detect.anomaly_event_id }, output: explain },
    { tool: "rank_om_actions", input: { anomaly_event_id: detect.anomaly_event_id }, output: rank },
  ];
  return { triage: { site, forecast, detect, explain, rank }, trace };
}

function portfolioForecast(svc: SolarOpsService): { answer: string; trace: ToolTraceEntry[] } {
  const ids = ["site_a", "site_b", "site_c"];
  const trace: ToolTraceEntry[] = [];
  const sites = ids.map((id) => {
    const site = svc.lookupSolarSite(id);
    const forecast = svc.forecast(id, "day_ahead");
    trace.push({ tool: "lookup_solar_site", input: { site_id: id }, output: site });
    trace.push({ tool: "forecast_solar_yield", input: { site_id: id, horizon: "day_ahead" }, output: forecast });
    return { site, forecast };
  });
  const grid = svc.lookupGridDemand("peninsular_malaysia", "day_ahead");
  trace.push({ tool: "lookup_grid_demand", input: { region: "peninsular_malaysia", horizon: "day_ahead" }, output: grid });
  return { answer: renderPortfolioForecastAnswer({ sites, grid }), trace };
}

function siteReport(svc: SolarOpsService, siteId: string): { answer: string; trace: ToolTraceEntry[] } {
  const { triage, trace } = siteTriage(svc, siteId);
  const report = svc.generateSolarReport(siteId, triage.detect.anomaly_event_id, "markdown");
  trace.push({
    tool: "generate_solar_report",
    input: { site_id: siteId, anomaly_event_id: triage.detect.anomaly_event_id, format: "markdown" },
    output: report,
  });
  return { answer: `Here is the owner/O&M report for ${triage.site.name}:\n\n${report.content}`, trace };
}

function deterministicAnswer(svc: SolarOpsService, intent: Intent): { answer: string; trace: ToolTraceEntry[] } {
  if (intent.kind === "report") return siteReport(svc, intent.siteId);
  if (intent.kind === "site") {
    const { triage, trace } = siteTriage(svc, intent.siteId);
    return { answer: renderSiteTriageAnswer(triage), trace };
  }
  return portfolioForecast(svc);
}

/** Deterministic, always-grounded result (offline path and safety fallback). */
export function buildOfflineResult(question: string, svc: SolarOpsService = createSolarOpsService()): CopilotResult {
  let answer: string;
  let trace: ToolTraceEntry[];
  try {
    ({ answer, trace } = deterministicAnswer(svc, parseIntent(question)));
  } catch (err) {
    answer = `I could not complete the analysis: ${(err as Error).message} Please ask about a valid site (site_a, site_b, or site_c).`;
    trace = [];
  }
  return {
    answer,
    mode: "offline",
    toolTrace: trace,
    safety: validateAnswer(answer, trace.map((t) => t.output)),
    adjusted: false,
  };
}

/** Validate a live draft; if it fails, fall back to the tool-grounded deterministic answer. */
export function enforceGrounding(
  question: string,
  draftAnswer: string,
  liveTrace: ToolTraceEntry[],
  svc: SolarOpsService = createSolarOpsService(),
): CopilotResult {
  const safety = validateAnswer(draftAnswer, liveTrace.map((t) => t.output));
  if (safety.ok) {
    return { answer: draftAnswer, mode: "live", toolTrace: liveTrace, safety, adjusted: false };
  }
  const fallback = buildOfflineResult(question, svc);
  const answer = ADJUST_NOTE + fallback.answer;
  return {
    answer,
    mode: "live",
    toolTrace: fallback.toolTrace,
    safety: validateAnswer(answer, fallback.toolTrace.map((t) => t.output)),
    adjusted: true,
  };
}

function liveToolTrace(result: unknown): ToolTraceEntry[] {
  const r = result as {
    toolCalls?: { payload?: { toolCallId?: string; toolName?: string; args?: unknown } }[];
    toolResults?: { payload?: { toolCallId?: string; toolName?: string; result?: unknown } }[];
  };
  const calls = new Map<string, { tool?: string; input?: unknown }>();
  for (const tc of r.toolCalls ?? []) {
    const p = tc.payload ?? {};
    if (p.toolCallId) calls.set(p.toolCallId, { tool: p.toolName, input: p.args });
  }
  const trace: ToolTraceEntry[] = [];
  for (const tr of r.toolResults ?? []) {
    const p = tr.payload ?? {};
    const call = (p.toolCallId && calls.get(p.toolCallId)) || {};
    trace.push({ tool: p.toolName ?? call.tool ?? "tool", input: call.input ?? null, output: p.result ?? null });
  }
  return trace;
}

// Surface DeepSeek context-cache usage so prefix-cache savings are observable
// (cached input tokens are billed ~10x cheaper). Best-effort across field shapes.
function logUsage(result: unknown): void {
  const r = result as {
    usage?: Record<string, number>;
    providerMetadata?: Record<string, Record<string, unknown>>;
  };
  const u = r.usage;
  if (!u) return;
  const cached =
    u.cachedInputTokens ??
    (r.providerMetadata?.deepseek?.promptCacheHitTokens as number | undefined) ??
    0;
  console.log(
    `[solarops] copilot tokens — input ${u.inputTokens ?? 0} (cached ${cached}), output ${u.outputTokens ?? 0}`,
  );
}

export interface AskOptions {
  mode?: "auto" | "live" | "offline";
  maxSteps?: number;
}

export async function askCopilot(question: string, opts: AskOptions = {}): Promise<CopilotResult> {
  const replay = process.env.SOLAROPS_REPLAY === "1";
  const hasKey = Boolean(process.env.DEEPSEEK_API_KEY);
  const mode = opts.mode ?? (hasKey && !replay ? "live" : "offline");
  const svc = createSolarOpsService();

  if (mode === "offline") return buildOfflineResult(question, svc);

  try {
    const result = await solaropsAgent().generate(question, { maxSteps: opts.maxSteps ?? 10 });
    logUsage(result);
    const trace = liveToolTrace(result);
    return enforceGrounding(question, (result as { text?: string }).text ?? "", trace, svc);
  } catch (err) {
    // Live path FAILED (bad key / provider/router error / network). Do NOT label this
    // "live" — that would make a broken live path look identical to a working one.
    // Return the deterministic fallback as mode "offline" with an explicit error.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[solarops] live copilot failed; using deterministic fallback: ${message}`);
    return { ...buildOfflineResult(question, svc), error: `live_agent_failed: ${message}` };
  }
}
