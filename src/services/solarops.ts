// SolarOps service layer — the single implementation behind both the AI SDK tools
// (agent) and the REST routes (dashboard). Wires engine + store + source manifest,
// persists anomaly events under deterministic ids, and raises typed errors
// (PDR-005 §6). No LLM is involved in any calculation here (ADR-0005).

import { assumptions, MODEL_VERSION } from "../config/assumptions";
import {
  mergeWeatherPreferFixture,
  type FetchLiveWeatherOpts,
} from "../data/liveWeather";
import { buildSourceManifest, FIXTURE_INPUTS, STANDARD_ASSUMPTIONS } from "../data/sourceManifest";
import { getStore, type SolarStore } from "../data/store";
import { billingPeriodBounds, computeAtapCreditClock } from "../engine/atap";
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
  QualityFlag,
  ReportFormat,
  RootCauseResult,
  Severity,
  Site,
  Weather,
} from "../domain/types";

/**
 * Real Open-Meteo fetcher — opt in at app wiring (I7):
 *   createSolarOpsService(store, { liveWeatherFetcher: fetchLiveWeather })
 * Default is null (fail-closed); never auto-wired into createSolarOpsService.
 */
export { fetchLiveWeather } from "../data/liveWeather";

/** Injectable live-weather fetcher (tests pass a stub or null — never hits the network). */
export type LiveWeatherFetcher = (
  site: Site,
  opts?: FetchLiveWeatherOpts,
) => Promise<Weather[] | null>;

export type SolarOpsServiceOptions = {
  /**
   * Live Open-Meteo fetcher. Defaults to `null` (fail-closed — no network).
   * Opt in at app wiring (I7) with `liveWeatherFetcher: fetchLiveWeather`.
   * Only invoked from the opt-in `getWeatherMerged` path when `now` marks
   * asOfDate as "today".
   */
  liveWeatherFetcher?: LiveWeatherFetcher | null;
};

const REFERENCE_SITE_ID = "site_a"; // healthy reference for the model backtest WAPE
/** Local calendar used for all detection windows (Peninsular Malaysia). */
const LOCAL_OFFSET = "+08:00";
const LOCAL_OFFSET_MS = 8 * 60 * 60 * 1000;

export type SolarOpsErrorCode =
  | "site_not_found"
  | "anomaly_not_found"
  | "no_observations"
  | "grid_unavailable"
  | "smp_unavailable";

export class SolarOpsError extends Error {
  constructor(
    public readonly code: SolarOpsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SolarOpsError";
  }
}

function ymdCompact(isoDate: string): string {
  return isoDate.slice(0, 10).replace(/-/g, "");
}

function ymd(timestamp: string): string {
  return localDateKey(timestamp).replace(/-/g, "");
}

/**
 * Calendar day (YYYY-MM-DD) in local +08:00 for any ISO bound (Z, offset, or bare date).
 * UTC/Z inputs are converted — e.g. 2026-06-19T20:00:00Z → 2026-06-20 in +08.
 */
function localDateKey(timestamp: string): string {
  const bare = timestamp.trim();
  // Already a calendar date (no time component).
  if (/^\d{4}-\d{2}-\d{2}$/.test(bare)) return bare;
  const ms = Date.parse(bare);
  if (!Number.isFinite(ms)) {
    // Last resort: first 10 chars if they look like a date.
    const head = bare.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : bare.slice(0, 10);
  }
  // Shift into +08 wall-clock, then read UTC components of the shifted instant.
  const shifted = new Date(ms + LOCAL_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function anomalyEventId(siteId: string, windowStart: string, windowEnd: string): string {
  const startDay = ymd(windowStart);
  const endDay = ymd(windowEnd);
  if (startDay === endDay) return `anom_${siteId}_${startDay}`;
  return `anom_${siteId}_${startDay}_${endDay}`;
}

function siteIdFromEventId(id: string): string {
  // anom_<siteId>_<YYYYMMDD> or anom_<siteId>_<YYYYMMDD>_<YYYYMMDD>
  const m = id.match(/^anom_(.+?)_(\d{8})(?:_(\d{8}))?$/);
  return m?.[1] ?? id.replace(/^anom_/, "");
}

/** Parse start day (YYYY-MM-DD) from a day-keyed anomaly id. */
function dateFromEventId(id: string): string | null {
  const m = id.match(/^anom_.+?_(\d{8})(?:_(\d{8}))?$/);
  if (!m) return null;
  const d = m[1]!;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/** Parse full local-day window from a single- or multi-day anomaly id. */
function windowFromEventId(id: string): { startDate: string; endDate: string } | null {
  const m = id.match(/^anom_.+?_(\d{8})(?:_(\d{8}))?$/);
  if (!m) return null;
  const start = m[1]!;
  const end = m[2] ?? m[1]!;
  const toIso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return { startDate: toIso(start), endDate: toIso(end) };
}

function dateKey(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function dayWindow(asOfDate: string): { windowStart: string; windowEnd: string } {
  return {
    windowStart: `${asOfDate}T00:00:00${LOCAL_OFFSET}`,
    // Inclusive end of the local calendar day (ms precision for filter ≤).
    windowEnd: `${asOfDate}T23:59:59.999${LOCAL_OFFSET}`,
  };
}

/**
 * Normalize detection bounds to full local (+08:00) calendar days.
 * Any provided bound (including Z/UTC) is converted to +08, then expanded:
 * start → 00:00:00, end → 23:59:59.999 of their respective local days.
 * Multi-day explicit windows remain possible after expansion.
 */
function normalizeDetectionWindow(
  windowStart?: string,
  windowEnd?: string,
  asOfDate?: string,
): { windowStart: string; windowEnd: string } {
  if (!windowStart && !windowEnd) {
    return dayWindow(asOfDate!);
  }
  if (windowStart && !windowEnd) {
    return dayWindow(localDateKey(windowStart));
  }
  if (!windowStart && windowEnd) {
    return dayWindow(localDateKey(windowEnd));
  }
  const startDay = localDateKey(windowStart!);
  const endDay = localDateKey(windowEnd!);
  return {
    windowStart: dayWindow(startDay).windowStart,
    windowEnd: dayWindow(endDay).windowEnd,
  };
}

function filterByDate<T extends { timestamp: string }>(rows: T[], asOfDate: string): T[] {
  return rows.filter((r) => dateKey(r.timestamp) === asOfDate);
}

/** Inclusive timestamp window filter (ISO strings compare lexicographically for +08:00 fixtures). */
function filterByWindow<T extends { timestamp: string }>(
  rows: T[],
  start?: string,
  end?: string,
): T[] {
  return rows.filter(
    (r) => (!start || r.timestamp >= start) && (!end || r.timestamp <= end),
  );
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

export function createSolarOpsService(
  store: SolarStore = getStore(),
  options: SolarOpsServiceOptions = {},
) {
  // Day-scoped reference WAPE (key = YYYY-MM-DD); value null means unmeasurable that day.
  const referenceWapeCache = new Map<string, number | null>();
  let latestFixtureDateCache: string | null | undefined;

  // Default = null (fail-closed). Opt in with fetchLiveWeather at app wiring (I7).
  // Existing sync methods never call this — only getWeatherMerged with a
  // passed-in `now` AND a non-null fetcher can trigger a fetch.
  const liveWeatherFetcher: LiveWeatherFetcher | null =
    options.liveWeatherFetcher === undefined
      ? null
      : options.liveWeatherFetcher;

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

  /** Reference-site fixture WAPE for a single asOfDate day (not cross-day). */
  function referenceWape(asOfDate?: string): number | undefined {
    const day = resolveAsOfDate(asOfDate);
    if (!referenceWapeCache.has(day)) {
      const ref = store.getSite(REFERENCE_SITE_ID);
      if (!ref) {
        referenceWapeCache.set(day, null);
      } else {
        const obs = filterByDate(store.getObservations(ref.id), day);
        const wx = filterByDate(store.getWeather(ref.id), day);
        referenceWapeCache.set(day, fixtureWape(obs, expectedProfile(ref, wx)));
      }
    }
    return referenceWapeCache.get(day) ?? undefined;
  }

  function requireSite(siteId: string) {
    const site = store.getSite(siteId);
    if (!site) throw new SolarOpsError("site_not_found", `Unknown site '${siteId}'. Provide a valid site id.`);
    return site;
  }

  function persistEvent(siteId: string, anomaly: AnomalyResult, site: ReturnType<typeof requireSite>): AnomalyEvent {
    const rootCause = classifyRootCause({ anomaly, site });
    const event: AnomalyEvent = {
      id: anomalyEventId(siteId, anomaly.windowStart, anomaly.windowEnd),
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

  function detectEvent(
    siteId: string,
    windowStart?: string,
    windowEnd?: string,
    asOfDate?: string,
  ): AnomalyEvent {
    const site = requireSite(siteId);
    const allObservations = store.getObservations(siteId);
    if (allObservations.length === 0) {
      throw new SolarOpsError("no_observations", `No telemetry available for site '${siteId}'.`);
    }

    // Explicit windows win; otherwise scope to asOfDate (default = latest fixture day).
    // ALL bounds normalize to full local (+08:00) calendar days (R1/R2).
    const { windowStart: start, windowEnd: end } = normalizeDetectionWindow(
      windowStart,
      windowEnd,
      resolveAsOfDate(asOfDate),
    );

    // Scope observations + weather to the same window before the engine runs
    // (weatherNormal / weather_unavailable must not mix cross-day means).
    const observations = filterByWindow(allObservations, start, end);
    const weather = filterByWindow(store.getWeather(siteId), start, end);

    // Empty window → data_issue (same convention as lookupSolarSite empty day), never "healthy".
    if (observations.length === 0) {
      const flags: QualityFlag[] = ["missing_generation"];
      if (site.isFixture) flags.push("fixture_data");
      const anomaly: AnomalyResult = {
        siteId,
        windowStart: start,
        windowEnd: end,
        observedKwh: 0,
        expectedKwh: 0,
        residualKwh: 0,
        residualPct: 0,
        severity: "data_issue",
        qualityFlags: flags,
        evidence: {
          weatherNormal: false,
          persistentIntervals: 0,
          validIntervals: 0,
          missingIntervals: 0,
          noisyIntervals: 0,
          notes: ["No telemetry in the requested window."],
        },
        modelVersion: MODEL_VERSION,
      };
      return persistEvent(siteId, anomaly, site);
    }

    const anomaly = detectUnderperformance({
      site,
      observations,
      weather,
      windowStart: start,
      windowEnd: end,
    });
    return persistEvent(siteId, anomaly, site);
  }

  // Resolve a persisted event; if absent, re-derive it deterministically from the
  // id so explain/rank/report are robust to call order from the agent.
  function requireEvent(anomalyEventId: string): AnomalyEvent {
    const existing = store.getAnomalyEvent(anomalyEventId);
    if (existing) return existing;
    const siteId = siteIdFromEventId(anomalyEventId);
    if (store.getSite(siteId)) {
      const win = windowFromEventId(anomalyEventId);
      if (win) {
        const bounds = {
          start: dayWindow(win.startDate).windowStart,
          end: dayWindow(win.endDate).windowEnd,
        };
        const derived = detectEvent(siteId, bounds.start, bounds.end);
        if (derived.id === anomalyEventId) return derived;
      } else {
        const date = dateFromEventId(anomalyEventId);
        const derived = date ? detectEvent(siteId, undefined, undefined, date) : detectEvent(siteId);
        if (derived.id === anomalyEventId) return derived;
      }
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
    const refWape = referenceWape(day);
    const f = forecastSolarYield({
      site,
      weather,
      observations,
      horizon,
      runAt: resolvedRunAt,
      ...(refWape !== undefined ? { referenceWape: refWape } : {}),
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
    const reportId = `report_${siteId}_${ymd(ev.windowStart)}`; // ymd already local-day compact
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
    const reportId = `gpr_${siteId}_${ymdCompact(day)}`;
    const manifest = buildSourceManifest({
      runId: reportId,
      inputs: [
        FIXTURE_INPUTS.solar_sites!,
        FIXTURE_INPUTS.solar_observations!,
        FIXTURE_INPUTS.weather_observations!,
      ],
      ...(now ? { now } : {}),
    });

    // Day-scoped production split + measurable coverage for valuation / notes.
    const dayObs = filterByDate(store.getObservations(siteId), day);
    const dayWx = filterByDate(store.getWeather(siteId), day);
    const expIntervals = expectedProfile(site, dayWx);
    const expByTs = new Map(expIntervals.map((i) => [i.timestamp, i.expectedKwh]));
    let genSum = 0;
    let exportSum = 0;
    let measurableIntervals = 0;
    let validMeasurableIntervals = 0;
    for (const i of expIntervals) {
      if (i.expectedKwh > 0) measurableIntervals += 1;
    }
    for (const o of dayObs) {
      if (o.generationKwh != null) genSum += o.generationKwh;
      if (o.exportKwh != null) exportSum += o.exportKwh;
      const exp = expByTs.get(o.timestamp) ?? 0;
      if (exp > 0) {
        if (o.generationKwh != null) validMeasurableIntervals += 1;
      }
    }
    const selfConsumedKwh = genSum - exportSum;

    // ATAP eligibility + preceding-month SMP (same resolution as atapCreditClock).
    const atapEligible = site.capacityKwp <= assumptions.atap.nonDomesticCapKwac;
    let averageSmpRmPerKwh: number | undefined;
    if (atapEligible) {
      const y = Number(day.slice(0, 4));
      const m = Number(day.slice(5, 7));
      const prevMonth = m === 1 ? 12 : m - 1;
      const prevYear = m === 1 ? y - 1 : y;
      const smpMonthLabel = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
      const smpEntry =
        assumptions.atap.averageSmpByMonth[
          smpMonthLabel as keyof typeof assumptions.atap.averageSmpByMonth
        ];
      if (smpEntry) averageSmpRmPerKwh = smpEntry.rmPerKwh;
    }

    const { report, data } = generateGreenReport({
      site,
      anomaly,
      rootCause,
      manifest,
      reportId,
      anomalyEventId: ev.id,
      ...(now ? { now } : {}),
      atapEligible,
      ...(averageSmpRmPerKwh != null ? { averageSmpRmPerKwh } : {}),
      selfConsumedKwh,
      exportedKwh: exportSum,
      measurableIntervals,
      validMeasurableIntervals,
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

  /**
   * ATAP credit-clock for a site (KREDIT / I2).
   * Billing period = calendar month of asOfDate; Average SMP = PRECEDING month entry.
   * Pure engine math + SourceManifest provenance; no HTTP route in this increment.
   * DTO is fully snake_case (matches every other service method).
   */
  function atapCreditClock(siteId: string, asOfDate?: string, now?: string) {
    const site = requireSite(siteId);
    const day = resolveAsOfDate(asOfDate);
    const { periodStart, periodEnd } = billingPeriodBounds(day);

    // Preceding calendar month of asOfDate (gazette §2 Average SMP definition).
    const y = Number(day.slice(0, 4));
    const m = Number(day.slice(5, 7));
    const prevMonth = m === 1 ? 12 : m - 1;
    const prevYear = m === 1 ? y - 1 : y;
    const smpMonthLabel = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
    const smpEntry = assumptions.atap.averageSmpByMonth[smpMonthLabel as keyof typeof assumptions.atap.averageSmpByMonth];
    if (!smpEntry) {
      throw new SolarOpsError(
        "smp_unavailable",
        `No Average SMP entry for preceding month '${smpMonthLabel}' (asOfDate ${day}). ` +
          `Add assumptions.atap.averageSmpByMonth['${smpMonthLabel}'] before computing ATAP credits.`,
      );
    }

    // Billing-period observations observed so far (date ≤ asOfDate, within the month).
    const observations = store
      .getObservations(siteId)
      .filter((o) => {
        const d = dateKey(o.timestamp);
        return d >= periodStart && d <= day && d <= periodEnd;
      });

    // Daylight predicate via expectedProfile (same helper as detection / green-report).
    const weather = store
      .getWeather(siteId)
      .filter((w) => {
        const d = dateKey(w.timestamp);
        return d >= periodStart && d <= day && d <= periodEnd;
      });
    const expectedKwhByTimestamp = new Map(
      expectedProfile(site, weather).map((i) => [i.timestamp, i.expectedKwh]),
    );

    const tariff =
      site.tariffAssumptionRmPerKwh ?? assumptions.retailTariffRmPerKwh;

    const result = computeAtapCreditClock({
      site: {
        id: site.id,
        capacityKwp: site.capacityKwp,
        tariffRmPerKwh: tariff,
        tariffCategory: site.tariffCategory,
      },
      observations,
      asOfDate: day,
      averageSmp: {
        rmPerKwh: smpEntry.rmPerKwh,
        monthLabel: smpMonthLabel,
        provenance: smpEntry.provenance,
        source: smpEntry.source,
      },
      assumptions,
      expectedKwhByTimestamp,
    });

    const runId = `atap_${siteId}_${day.replace(/-/g, "")}`;
    const manifest = buildSourceManifest({
      runId,
      inputs: [
        FIXTURE_INPUTS.solar_sites!,
        FIXTURE_INPUTS.solar_observations!,
        {
          name: "average_smp",
          sourceType: smpEntry.provenance,
          sourceName: `Average SMP ${smpMonthLabel}`,
          url: smpEntry.source.startsWith("http") ? smpEntry.source.split(" ")[0] : undefined,
          isFixture: false,
        },
        {
          name: "retail_tariff_rm_per_kwh",
          sourceType: "public",
          sourceName: "TNB gazetted energy charge (site override or Non-Domestic LV General)",
          url: "https://www.mytnb.com.my/tariff",
          isFixture: false,
        },
        {
          name: "grid_emission_factor",
          sourceType: "public",
          sourceName: "Peninsular Malaysia GEF projection 2026 (JPPET 2/2025)",
          url: "https://singlebuyer.com.my/docs/default-source/about/gef-projection-publication_31122025v1.pdf",
          isFixture: false,
        },
      ],
      assumptions: [
        ...STANDARD_ASSUMPTIONS,
        {
          name: "atap_average_smp_rm_per_kwh",
          value: smpEntry.rmPerKwh,
          note: `Preceding month ${smpMonthLabel}; provenance=${smpEntry.provenance}`,
        },
        {
          name: "atap_sun_hours_per_day",
          value: assumptions.atap.sunHoursPerDay,
          note: "Gazette GP/ST/No.60/2025 section 2 MAQ definition",
        },
      ],
      ...(now ? { now } : {}),
    });

    // Normalize to snake_case DTO (every other service method uses this convention).
    return {
      site_id: siteId,
      eligibility: {
        eligible: result.eligibility.eligible,
        reason: result.eligibility.reason,
      },
      coverage: {
        period_start: result.coverage.periodStart,
        period_end: result.coverage.periodEnd,
        days_in_period: result.coverage.daysInPeriod,
        observed_days: result.coverage.observedDays,
        as_of_date: result.coverage.asOfDate,
        days_remaining: result.coverage.daysRemaining,
      },
      observed_to_date: {
        generation_kwh: result.observedToDate.generationKwh,
        load_kwh: result.observedToDate.loadKwh,
        import_kwh: result.observedToDate.importKwh,
        export_kwh: result.observedToDate.exportKwh,
        self_consumed_kwh: result.observedToDate.selfConsumedKwh,
        self_consumption_ratio: result.observedToDate.selfConsumptionRatio,
      },
      maq_kwh: result.maqKwh,
      projection: result.projection
        ? {
            method: result.projection.method,
            observed_days: result.projection.observedDays,
            export_kwh: result.projection.exportKwh,
            import_kwh: result.projection.importKwh,
            offsettable_export_kwh: result.projection.offsettableExportKwh,
            forfeited_export_kwh: result.projection.forfeitedExportKwh,
            credit_rm: result.projection.creditRm,
            forfeited_credit_rm: result.projection.forfeitedCreditRm,
            energy_charge_rm: result.projection.energyChargeRm,
            net_energy_charge_rm: result.projection.netEnergyChargeRm,
            observed_daylight_import_kwh: result.projection.observedDaylightImportKwh,
            projected_daylight_import_kwh: result.projection.projectedDaylightImportKwh,
            load_shiftable_export_kwh: result.projection.loadShiftableExportKwh,
          }
        : null,
      value_leak: result.valueLeak
        ? {
            smp_spread_rm: result.valueLeak.smpSpreadRm,
            smp_spread_ceiling_rm: result.valueLeak.smpSpreadCeilingRm,
            forfeited_credit_rm: result.valueLeak.forfeitedCreditRm,
            floored_credit_lost_rm: result.valueLeak.flooredCreditLostRm,
            total_rm: result.valueLeak.totalRm,
          }
        : null,
      projection_unavailable_reason: result.projectionUnavailableReason,
      assumptions: result.assumptions,
      source_manifest: manifest,
    };
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

  /**
   * Opt-in weather resolution with optional live Open-Meteo overlay.
   *
   * Live fetch runs ONLY when all of:
   *   - a non-null liveWeatherFetcher is configured
   *   - `now` is provided (never uses Date.now() — keeps tests deterministic / offline)
   *   - asOfDate (resolved) equals the local (+08) calendar day of `now`
   *
   * Fixture rows always win on hour collision; live only ADDS uncovered hours.
   * On any fetch failure, returns fixture weather unchanged (never throws).
   */
  async function getWeatherMerged(
    siteId: string,
    asOfDate?: string,
    opts?: { now?: string; pastDays?: number },
  ): Promise<Weather[]> {
    const site = requireSite(siteId);
    const day = resolveAsOfDate(asOfDate);
    const fixture = store.getWeather(siteId);

    const fetcher = liveWeatherFetcher;
    const shouldFetchLive =
      fetcher != null && opts?.now != null && localDateKey(opts.now) === day;

    if (!shouldFetchLive || fetcher == null) {
      return filterByDate(fixture, day);
    }

    let live: Weather[] | null = null;
    try {
      live = await fetcher(site, {
        ...(opts?.pastDays != null ? { pastDays: opts.pastDays } : {}),
      });
    } catch {
      live = null;
    }

    if (!live || live.length === 0) {
      return filterByDate(fixture, day);
    }

    return filterByDate(mergeWeatherPreferFixture(fixture, live), day);
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
    atapCreditClock,
    /** Opt-in live+fixture weather merge (async; off the default hot path). */
    getWeatherMerged,
    /** Pure merge helper — fixture wins; live fills gaps. No I/O. */
    mergeLiveWeather: mergeWeatherPreferFixture,
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
