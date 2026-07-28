// SolarOps service layer — the single implementation behind both the AI SDK tools
// (agent) and the REST routes (dashboard). Wires engine + store + source manifest,
// persists anomaly events under deterministic ids, and raises typed errors
// (PDR-005 §6). No LLM is involved in any calculation here (ADR-0005).

import { assumptions } from "../config/assumptions";
import { buildSourceManifest, FIXTURE_INPUTS } from "../data/sourceManifest";
import { getStore, type SolarStore } from "../data/store";
import { detectUnderperformance } from "../engine/anomaly";
import { expectedProfile, fixtureWape, forecastSolarYield } from "../engine/forecast";
import { generateGreenReport } from "../engine/greenReport";
import { round } from "../engine/math";
import { rankActions } from "../engine/recommend";
import { generateReport } from "../engine/report";
import { classifyRootCause } from "../engine/rootCause";
import type {
  AnomalyEvent,
  AnomalyResult,
  GridHorizon,
  Horizon,
  Observation,
  ReportFormat,
  RootCauseResult,
  Severity,
  Weather,
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

/** Parse YYYY-MM-DD from a day-keyed anomaly id (e.g. anom_site_b_20260621). */
function dateFromEventId(id: string): string | null {
  const m = id.match(/_(\d{8})$/);
  if (!m) return null;
  const d = m[1]!;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function dateKey(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function dayWindow(asOfDate: string): { windowStart: string; windowEnd: string } {
  return {
    windowStart: `${asOfDate}T00:00:00+08:00`,
    windowEnd: `${asOfDate}T23:59:59+08:00`,
  };
}

function filterByDate<T extends { timestamp: string }>(rows: T[], asOfDate: string): T[] {
  return rows.filter((r) => dateKey(r.timestamp) === asOfDate);
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
  let latestFixtureDateCache: string | null | undefined;

  /** Latest ISO date (YYYY-MM-DD) present in fixture observations; demo default asOfDate. */
  function latestFixtureDate(): string {
    if (latestFixtureDateCache !== undefined && latestFixtureDateCache !== null) {
      return latestFixtureDateCache;
    }
    let max = "";
    for (const s of store.listSites()) {
      for (const o of store.getObservations(s.id)) {
        const d = dateKey(o.timestamp);
        if (d > max) max = d;
      }
    }
    latestFixtureDateCache = max || "2026-06-21";
    return latestFixtureDateCache;
  }

  function resolveAsOfDate(asOfDate?: string): string {
    return asOfDate ?? latestFixtureDate();
  }

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

  function detectEvent(
    siteId: string,
    windowStart?: string,
    windowEnd?: string,
    asOfDate?: string,
  ): AnomalyEvent {
    const site = requireSite(siteId);
    const observations = store.getObservations(siteId);
    if (observations.length === 0) {
      throw new SolarOpsError("no_observations", `No telemetry available for site '${siteId}'.`);
    }

    // Explicit windows win; otherwise scope to asOfDate (default = latest fixture day).
    let start = windowStart;
    let end = windowEnd;
    if (!start && !end) {
      const bounds = dayWindow(resolveAsOfDate(asOfDate));
      start = bounds.windowStart;
      end = bounds.windowEnd;
    }

    const anomaly = detectUnderperformance({
      site,
      observations,
      weather: store.getWeather(siteId),
      ...(start ? { windowStart: start } : {}),
      ...(end ? { windowEnd: end } : {}),
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
      const date = dateFromEventId(anomalyEventId);
      const derived = date ? detectEvent(siteId, undefined, undefined, date) : detectEvent(siteId);
      if (derived.id === anomalyEventId) return derived;
    }
    throw new SolarOpsError("anomaly_not_found", `Unknown anomaly event '${anomalyEventId}'.`);
  }

  function lookupSolarSite(siteId: string, asOfDate?: string) {
    const site = requireSite(siteId);
    const day = resolveAsOfDate(asOfDate);
    const dayObs = filterByDate(store.getObservations(siteId), day);
    const latestStatus: Severity =
      dayObs.length > 0 ? detectEvent(siteId, undefined, undefined, day).severity : "data_issue";
    return {
      site_id: site.id,
      name: site.name,
      region: site.region,
      capacity_kwp: site.capacityKwp,
      latest_status: latestStatus,
      is_fixture: site.isFixture,
    };
  }

  function forecast(siteId: string, horizon: Horizon = "day_ahead", runAt?: string, asOfDate?: string) {
    const site = requireSite(siteId);
    const day = resolveAsOfDate(asOfDate);
    const allObs = store.getObservations(siteId);
    const allWx = store.getWeather(siteId);
    // Scope weather + observations to asOfDate so day_ahead stays a single-day profile
    // (multi-day fixtures must not inflate expected_kwh 4×).
    const observations: Observation[] = filterByDate(allObs, day);
    const weather: Weather[] = filterByDate(allWx, day);
    const resolvedRunAt =
      runAt ?? observations[observations.length - 1]?.timestamp ?? site.commissioningDate ?? "";
    const f = forecastSolarYield({
      site,
      weather,
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

  function detectAssetUnderperformance(
    siteId: string,
    windowStart?: string,
    windowEnd?: string,
    asOfDate?: string,
  ) {
    const ev = detectEvent(siteId, windowStart, windowEnd, asOfDate);
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

  // Client-facing Green Performance Report (monthly O&M pack). Formats the same
  // deterministic detect + root-cause numbers used elsewhere — no LLM.
  function generateGreenPerformanceReport(siteId: string, now?: string, asOfDate?: string) {
    const site = requireSite(siteId);
    const day = resolveAsOfDate(asOfDate);
    // detectEvent also requires the site and throws no_observations when empty.
    const ev = detectEvent(siteId, undefined, undefined, day);
    const anomaly = eventToAnomalyResult(ev);
    const rootCause = eventToRootCause(ev);
    const reportId = `gpr_${siteId}_${ymd(ev.windowStart)}`;
    const manifest = buildSourceManifest({
      runId: reportId,
      inputs: [
        FIXTURE_INPUTS.solar_sites!,
        FIXTURE_INPUTS.solar_observations!,
        FIXTURE_INPUTS.weather_observations!,
      ],
      ...(now ? { now } : {}),
    });
    const { report, data } = generateGreenReport({
      site,
      anomaly,
      rootCause,
      manifest,
      reportId,
      anomalyEventId: ev.id,
      ...(now ? { now } : {}),
    });
    store.saveReport(report);
    return {
      report_id: report.reportId,
      format: report.format,
      url_or_path: `/sites/${siteId}/green-report`,
      includes_provenance: report.includesProvenance,
      includes_assumptions: report.includesAssumptions,
      content: report.content,
      data,
    };
  }

  function listSites(asOfDate?: string) {
    return store.listSites().map((s) => lookupSolarSite(s.id, asOfDate));
  }

  // Portfolio rollup for the dashboard overview (PDR-006 §2, Screen 1).
  function portfolioSummary(asOfDate?: string) {
    const day = resolveAsOfDate(asOfDate);
    const rows = store.listSites().map((s) => {
      const detect = detectAssetUnderperformance(s.id, undefined, undefined, day);
      const topAction =
        detect.severity === "healthy"
          ? null
          : (rankOmActions(detect.anomaly_event_id).recommendations[0] ?? null);
      return { summary: lookupSolarSite(s.id, day), detect, topAction };
    });
    const isShortfall = (sev: string) => sev === "watch" || sev === "anomaly" || sev === "critical";
    const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
    const kpi = {
      total_capacity_kwp: sum((r) => r.summary.capacity_kwp),
      expected_kwh: round(sum((r) => r.detect.expected_kwh)),
      observed_kwh: round(sum((r) => r.detect.observed_kwh)),
      lost_kwh: round(sum((r) => (isShortfall(r.detect.severity) ? Math.abs(r.detect.residual_kwh) : 0))),
      active_anomalies: rows.filter((r) => r.detect.severity === "anomaly" || r.detect.severity === "critical").length,
      rm_at_risk: round(sum((r) => r.topAction?.estimated_rm_value ?? 0)),
      co2_at_risk: round(sum((r) => r.topAction?.estimated_co2_kg ?? 0)),
    };
    return { rows, kpi };
  }

  // Everything the Site Detail screen needs, including the hourly observed-vs-expected
  // series for the forecast chart (scoped to asOfDate).
  function siteDetail(siteId: string, asOfDate?: string) {
    const site = requireSite(siteId);
    const day = resolveAsOfDate(asOfDate);
    const weather = filterByDate(store.getWeather(siteId), day);
    const expByTs = new Map(expectedProfile(site, weather).map((i) => [i.timestamp, i.expectedKwh]));
    const band = assumptions.confidenceBandPct;
    const series = filterByDate(store.getObservations(siteId), day).map((o) => {
      const expected = round(expByTs.get(o.timestamp) ?? 0);
      return {
        time: o.timestamp.slice(11, 16),
        observed: o.generationKwh,
        expected,
        lower: round(expected * (1 - band)),
        upper: round(expected * (1 + band)),
      };
    });
    const detect = detectAssetUnderperformance(siteId, undefined, undefined, day);
    return {
      site: lookupSolarSite(siteId, day),
      forecast: forecast(siteId, "day_ahead", undefined, day),
      detect,
      explanation: explainSolarAnomaly(detect.anomaly_event_id),
      recommendations: rankOmActions(detect.anomaly_event_id).recommendations,
      series,
    };
  }

  return {
    listSites,
    portfolioSummary,
    siteDetail,
    lookupSolarSite,
    forecast,
    lookupGridDemand,
    detectAssetUnderperformance,
    explainSolarAnomaly,
    rankOmActions,
    generateSolarReport,
    generateGreenPerformanceReport,
    /** Exposed for tests: resolves default asOfDate from fixture observations. */
    latestFixtureDate,
  };
}

export type SolarOpsService = ReturnType<typeof createSolarOpsService>;

let defaultService: SolarOpsService | null = null;
export function solarOps(): SolarOpsService {
  if (!defaultService) defaultService = createSolarOpsService();
  return defaultService;
}
