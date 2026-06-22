// SolarOps service layer — the single implementation behind both the Mastra tools
// (agent) and the REST routes (dashboard). Wires engine + store + source manifest,
// persists anomaly events under deterministic ids, and raises typed errors
// (PDR-005 §6). No LLM is involved in any calculation here (ADR-0005).

import { buildSourceManifest, FIXTURE_INPUTS } from "../data/sourceManifest";
import { getStore, type SolarStore } from "../data/store";
import { detectUnderperformance } from "../engine/anomaly";
import { expectedProfile, fixtureWape, forecastSolarYield } from "../engine/forecast";
import { rankActions } from "../engine/recommend";
import { classifyRootCause } from "../engine/rootCause";
import { generateReport } from "../engine/report";
import type {
  AnomalyEvent,
  AnomalyResult,
  GridHorizon,
  Horizon,
  ReportFormat,
  RootCauseResult,
  Severity,
} from "../domain/types";

const REFERENCE_SITE_ID = "site_a"; // healthy reference for the model backtest WAPE

export type SolarOpsErrorCode =
  | "site_not_found"
  | "anomaly_not_found"
  | "no_observations"
  | "grid_unavailable";

export class SolarOpsError extends Error {
  constructor(
    public readonly code: SolarOpsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SolarOpsError";
  }
}

function ymd(timestamp: string): string {
  return timestamp.slice(0, 10).replace(/-/g, "");
}

function anomalyEventId(siteId: string, windowStart: string): string {
  return `anom_${siteId}_${ymd(windowStart)}`;
}

function siteIdFromEventId(id: string): string {
  return id.replace(/^anom_/, "").replace(/_\d{8}$/, "");
}

function eventToAnomalyResult(ev: AnomalyEvent): AnomalyResult {
  return {
    siteId: ev.siteId,
    windowStart: ev.windowStart,
    windowEnd: ev.windowEnd,
    observedKwh: ev.observedKwh,
    expectedKwh: ev.expectedKwh,
    residualKwh: ev.residualKwh,
    residualPct: ev.residualPct,
    severity: ev.severity,
    qualityFlags: ev.qualityFlags,
    evidence: ev.evidence,
    modelVersion: ev.modelVersion,
  };
}

function eventToRootCause(ev: AnomalyEvent): RootCauseResult {
  return {
    likelyCause: ev.likelyCause,
    confidence: ev.confidence,
    evidence: ev.rootCauseEvidence,
    caveats: ev.caveats,
  };
}

export function createSolarOpsService(store: SolarStore = getStore()) {
  let referenceWapeCache: number | null | undefined; // undefined = not computed yet

  function referenceWape(): number | undefined {
    if (referenceWapeCache === undefined) {
      const ref = store.getSite(REFERENCE_SITE_ID);
      referenceWapeCache = ref
        ? fixtureWape(store.getObservations(ref.id), expectedProfile(ref, store.getWeather(ref.id)))
        : null;
    }
    return referenceWapeCache ?? undefined;
  }

  function requireSite(siteId: string) {
    const site = store.getSite(siteId);
    if (!site) throw new SolarOpsError("site_not_found", `Unknown site '${siteId}'. Provide a valid site id.`);
    return site;
  }

  function detectEvent(siteId: string, windowStart?: string, windowEnd?: string): AnomalyEvent {
    const site = requireSite(siteId);
    const observations = store.getObservations(siteId);
    if (observations.length === 0) {
      throw new SolarOpsError("no_observations", `No telemetry available for site '${siteId}'.`);
    }
    const anomaly = detectUnderperformance({
      site,
      observations,
      weather: store.getWeather(siteId),
      ...(windowStart ? { windowStart } : {}),
      ...(windowEnd ? { windowEnd } : {}),
    });
    const rootCause = classifyRootCause({ anomaly, site });
    const event: AnomalyEvent = {
      id: anomalyEventId(siteId, anomaly.windowStart),
      siteId,
      windowStart: anomaly.windowStart,
      windowEnd: anomaly.windowEnd,
      observedKwh: anomaly.observedKwh,
      expectedKwh: anomaly.expectedKwh,
      residualKwh: anomaly.residualKwh,
      residualPct: anomaly.residualPct,
      severity: anomaly.severity,
      qualityFlags: anomaly.qualityFlags,
      evidence: anomaly.evidence,
      likelyCause: rootCause.likelyCause,
      confidence: rootCause.confidence,
      rootCauseEvidence: rootCause.evidence,
      caveats: rootCause.caveats,
      modelVersion: anomaly.modelVersion,
      createdAt: new Date().toISOString(),
    };
    store.saveAnomalyEvent(event);
    return event;
  }

  // Resolve a persisted event; if absent, re-derive it deterministically from the
  // id so explain/rank/report are robust to call order from the agent.
  function requireEvent(anomalyEventId: string): AnomalyEvent {
    const existing = store.getAnomalyEvent(anomalyEventId);
    if (existing) return existing;
    const siteId = siteIdFromEventId(anomalyEventId);
    if (store.getSite(siteId)) {
      const derived = detectEvent(siteId);
      if (derived.id === anomalyEventId) return derived;
    }
    throw new SolarOpsError("anomaly_not_found", `Unknown anomaly event '${anomalyEventId}'.`);
  }

  function lookupSolarSite(siteId: string) {
    const site = requireSite(siteId);
    const latestStatus: Severity =
      store.getObservations(siteId).length > 0 ? detectEvent(siteId).severity : "data_issue";
    return {
      site_id: site.id,
      name: site.name,
      region: site.region,
      capacity_kwp: site.capacityKwp,
      latest_status: latestStatus,
      is_fixture: site.isFixture,
    };
  }

  function forecast(siteId: string, horizon: Horizon = "day_ahead", runAt?: string) {
    const site = requireSite(siteId);
    const observations = store.getObservations(siteId);
    const resolvedRunAt = runAt ?? observations[observations.length - 1]?.timestamp ?? site.commissioningDate ?? "";
    const f = forecastSolarYield({
      site,
      weather: store.getWeather(siteId),
      observations,
      horizon,
      runAt: resolvedRunAt,
      ...(referenceWape() !== undefined ? { referenceWape: referenceWape()! } : {}),
    });
    return {
      site_id: f.siteId,
      horizon: f.horizon,
      expected_kwh: f.expectedKwh,
      lower_kwh: f.lowerKwh,
      upper_kwh: f.upperKwh,
      model_version: f.modelVersion,
      metric: f.metric,
      assumptions: f.assumptions,
      quality_flags: f.qualityFlags,
    };
  }

  function lookupGridDemand(region: string = "peninsular_malaysia", horizon: GridHorizon = "day_ahead") {
    const all = store.getGridSnapshots(region);
    const matched = all.filter((s) => s.forecastHorizon === horizon);
    const used = matched.length > 0 ? matched : all;
    const qualityFlags = [...new Set(used.flatMap((s) => s.qualityFlags))];
    if (used.length === 0) qualityFlags.push("public_context_only");
    return {
      region,
      horizon,
      snapshots: used.map((s) => ({ timestamp: s.timestamp, demand_mw: s.demandMw })),
      source: used[0]?.source ?? "unavailable",
      quality_flags: qualityFlags,
    };
  }

  function detectAssetUnderperformance(siteId: string, windowStart?: string, windowEnd?: string) {
    const ev = detectEvent(siteId, windowStart, windowEnd);
    return {
      anomaly_event_id: ev.id,
      site_id: ev.siteId,
      observed_kwh: ev.observedKwh,
      expected_kwh: ev.expectedKwh,
      residual_kwh: ev.residualKwh,
      residual_pct: ev.residualPct,
      severity: ev.severity,
      quality_flags: ev.qualityFlags,
      evidence: ev.evidence,
    };
  }

  function explainSolarAnomaly(anomalyEventId: string) {
    const ev = requireEvent(anomalyEventId);
    return {
      likely_cause: ev.likelyCause,
      confidence: ev.confidence,
      evidence: ev.rootCauseEvidence,
      caveats: ev.caveats,
    };
  }

  function rankOmActions(anomalyEventId: string) {
    const ev = requireEvent(anomalyEventId);
    const site = requireSite(ev.siteId);
    const recommendations = rankActions({
      anomaly: eventToAnomalyResult(ev),
      rootCause: eventToRootCause(ev),
      site,
    });
    return {
      recommendations: recommendations.map((r) => ({
        rank: r.rank,
        action: r.action,
        expected_recovery_kwh_month: r.expectedRecoveryKwhMonth,
        estimated_rm_value: r.estimatedRmValue,
        estimated_co2_kg: r.estimatedCo2Kg,
        confidence: r.confidence,
        assumptions: r.assumptions,
      })),
    };
  }

  function generateSolarReport(
    siteId: string,
    anomalyEventId: string,
    format: ReportFormat = "markdown",
  ) {
    const site = requireSite(siteId);
    const ev = requireEvent(anomalyEventId);
    const anomaly = eventToAnomalyResult(ev);
    const rootCause = eventToRootCause(ev);
    const recommendations = rankActions({ anomaly, rootCause, site });
    const reportId = `report_${siteId}_${ymd(ev.windowStart)}`;
    const manifest = buildSourceManifest({
      runId: reportId,
      inputs: [
        FIXTURE_INPUTS.solar_sites!,
        FIXTURE_INPUTS.solar_observations!,
        FIXTURE_INPUTS.weather_observations!,
        FIXTURE_INPUTS.grid_demand!,
      ],
    });
    const report = generateReport({
      site,
      anomaly,
      rootCause,
      recommendations,
      manifest,
      reportId,
      anomalyEventId,
      format,
    });
    store.saveReport(report);
    return {
      report_id: report.reportId,
      format: report.format,
      url_or_path: `/reports/${report.reportId}.md`,
      includes_provenance: report.includesProvenance,
      includes_assumptions: report.includesAssumptions,
      content: report.content,
    };
  }

  function listSites() {
    return store.listSites().map((s) => lookupSolarSite(s.id));
  }

  return {
    listSites,
    lookupSolarSite,
    forecast,
    lookupGridDemand,
    detectAssetUnderperformance,
    explainSolarAnomaly,
    rankOmActions,
    generateSolarReport,
  };
}

export type SolarOpsService = ReturnType<typeof createSolarOpsService>;

let defaultService: SolarOpsService | null = null;
export function solarOps(): SolarOpsService {
  if (!defaultService) defaultService = createSolarOpsService();
  return defaultService;
}
