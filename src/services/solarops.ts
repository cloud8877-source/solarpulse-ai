// SolarOps service layer — the single implementation behind both the AI SDK tools
// (agent) and the REST routes (dashboard). Wires engine + store + source manifest,
// persists anomaly events under deterministic ids, and raises typed errors
// (PDR-005 §6). No LLM is involved in any calculation here (ADR-0005).

import { assumptions, MODEL_VERSION } from "../config/assumptions";
import {
  mergeWeatherPreferFixture,
  type FetchLiveWeatherOpts,
} from "../data/liveWeather";
import {
  getLedger,
  LedgerError,
  type ActionLedger,
  type TransitionMeta,
} from "../data/ledger";
import { buildSourceManifest, FIXTURE_INPUTS, STANDARD_ASSUMPTIONS } from "../data/sourceManifest";
import { getStore, type SolarStore } from "../data/store";
import {
  actionId,
  type ActionCommitment,
  type ActionKind,
  type ActionVerification,
  type PolicyDecision,
} from "../domain/actions";
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
  Confidence,
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
  /**
   * Action commitment ledger (KREDIT). Defaults to getLedger() when action
   * verbs are first used. Inject a fresh InMemoryLedger in tests.
   * Tool/agent code must NEVER hold this handle — only service verbs may.
   */
  ledger?: ActionLedger;
};

const REFERENCE_SITE_ID = "site_a"; // healthy reference for the model backtest WAPE
/** Local calendar used for all detection windows (Peninsular Malaysia). */
const LOCAL_OFFSET = "+08:00";
const LOCAL_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Visible non-human principal for governor auto-approve of escalate (C3 / auto_class). */
export const GOVERNOR_AUTO_PRINCIPAL = "system:governor/auto";

export type SolarOpsErrorCode =
  | "site_not_found"
  | "anomaly_not_found"
  | "no_observations"
  | "grid_unavailable"
  | "smp_unavailable"
  | "illegal_field"
  | "action_not_found"
  | "ledger_error";

export class SolarOpsError extends Error {
  constructor(
    public readonly code: SolarOpsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SolarOpsError";
  }
}

/** Fields the model / caller may never inject on propose (C1). */
const ILLEGAL_PROPOSE_FIELDS = [
  "decidedBy",
  "decidedAt",
  "verification",
  "status",
] as const;

/** Candidate produced by proposeCreditActionsDeterministic — not yet on the ledger. */
export interface ActionCandidate {
  id: string;
  siteId: string;
  sweepId: string;
  kind: ActionKind;
  title: string;
  description: string;
  rmImpact: number | null;
  kwhImpact: number | null;
  confidence: Confidence;
  evidenceRefs: string[];
  deadline: string;
  approvalClass: "auto" | "human_signature";
}

export type ProposeActionInput = {
  id?: string;
  siteId: string;
  sweepId: string;
  kind: ActionKind;
  title: string;
  description: string;
  rmImpact: number | null;
  kwhImpact: number | null;
  confidence: Confidence;
  evidenceRefs: string[];
  deadline: string;
  approvalClass: "auto" | "human_signature";
  /** Optional seed for policy decisions on the proposed row (usually empty). */
  policyDecisions?: PolicyDecision[];
  createdAt?: string;
};

function mapLedgerError(err: unknown): never {
  if (err instanceof SolarOpsError) throw err;
  if (err instanceof LedgerError) {
    if (err.code === "not_found") {
      throw new SolarOpsError("action_not_found", err.message);
    }
    if (err.code === "verification_already_set" || err.code === "verification_not_allowed") {
      throw new SolarOpsError("ledger_error", err.message);
    }
    if (err.code === "illegal_transition" || err.code === "invalid_initial_status") {
      throw new SolarOpsError("ledger_error", err.message);
    }
    if (err.code === "already_exists") {
      throw new SolarOpsError("ledger_error", err.message);
    }
    throw new SolarOpsError("ledger_error", err.message);
  }
  throw err instanceof Error
    ? new SolarOpsError("ledger_error", err.message)
    : new SolarOpsError("ledger_error", String(err));
}

function assertNoIllegalProposeFields(input: Record<string, unknown>): void {
  for (const field of ILLEGAL_PROPOSE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined) {
      throw new SolarOpsError(
        "illegal_field",
        `Action payload must not carry '${field}' (service-owned field)`,
      );
    }
  }
}

/** Coverage → confidence for candidate rows (never pure low while projection exists). */
function confidenceFromCoverage(observedDays: number, daysInPeriod: number): Confidence {
  if (observedDays < 2) return "low";
  const ratio = daysInPeriod > 0 ? observedDays / daysInPeriod : 0;
  if (ratio < 0.5) return "medium";
  return "high";
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

  // Ledger is optional at construction; action verbs resolve lazily so pure
  // engine callers never touch getLedger / the demo singleton.
  let ledgerRef: ActionLedger | null = options.ledger ?? null;
  function ledger(): ActionLedger {
    if (!ledgerRef) ledgerRef = getLedger();
    return ledgerRef;
  }

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

  // -------------------------------------------------------------------------
  // KREDIT action verbs (C1) — thin ActionLedger wrappers. Tool/agent code
  // must call these; never hold a raw ledger handle.
  // -------------------------------------------------------------------------

  /**
   * Create a proposed action. Rejects any payload carrying decidedBy /
   * decidedAt / verification / status (illegal_field). On already_exists,
   * reallocates id via nextSeq and retries (C4) — never upserts.
   */
  async function proposeAction(input: ProposeActionInput): Promise<ActionCommitment> {
    assertNoIllegalProposeFields(input as unknown as Record<string, unknown>);
    const led = ledger();
    // Prefer date embedded in a well-formed id; else deadline; used only for retry seq.
    const idDateKey = (() => {
      if (input.id) {
        const m = input.id.match(/^act_.+_(\d{8})_\d+$/);
        if (m) {
          const d = m[1]!;
          return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
        }
      }
      return input.deadline.slice(0, 10);
    })();
    const createdAt = input.createdAt ?? `${idDateKey}T08:00:00${LOCAL_OFFSET}`;
    const maxRetries = assumptions.kredit.proposeMaxRetries;

    let preferredId = input.id;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let id = preferredId;
      if (!id || attempt > 0) {
        const seqHint = await led.nextSeq(input.siteId, idDateKey);
        id = actionId(input.siteId, idDateKey, seqHint);
      }
      const row: ActionCommitment = {
        id,
        siteId: input.siteId,
        sweepId: input.sweepId,
        kind: input.kind,
        title: input.title,
        description: input.description,
        rmImpact: input.rmImpact,
        kwhImpact: input.kwhImpact,
        confidence: input.confidence,
        evidenceRefs: [...input.evidenceRefs],
        deadline: input.deadline,
        approvalClass: input.approvalClass,
        status: "proposed",
        policyDecisions: (input.policyDecisions ?? []).map((p) => ({ ...p })),
        verification: null,
        createdAt,
        decidedAt: null,
        decidedBy: null,
      };
      try {
        await led.saveAction(row);
        const saved = await led.getAction(id);
        if (!saved) {
          throw new SolarOpsError("ledger_error", `saveAction succeeded but getAction('${id}') is null`);
        }
        return saved;
      } catch (err) {
        if (err instanceof LedgerError && err.code === "already_exists") {
          preferredId = undefined; // force fresh nextSeq on next attempt
          continue;
        }
        mapLedgerError(err);
      }
    }
    throw new SolarOpsError(
      "ledger_error",
      `proposeAction exhausted ${maxRetries} retries for site '${input.siteId}' deadline '${dateKey}' (already_exists)`,
    );
  }

  /** proposed → awaiting_approval (optionally attach policy decisions). */
  async function requestApproval(
    id: string,
    meta?: { policyDecisions?: PolicyDecision[] },
  ): Promise<ActionCommitment> {
    try {
      const tmeta: TransitionMeta = {};
      if (meta?.policyDecisions !== undefined) tmeta.policyDecisions = meta.policyDecisions;
      return await ledger().transitionAction(id, "awaiting_approval", tmeta);
    } catch (err) {
      mapLedgerError(err);
    }
  }

  /** proposed → denied_by_policy with governor decisions (offline/live deny path). */
  async function denyByPolicy(
    id: string,
    meta: { policyDecisions: PolicyDecision[]; decidedAt?: string },
  ): Promise<ActionCommitment> {
    try {
      return await ledger().transitionAction(id, "denied_by_policy", {
        policyDecisions: meta.policyDecisions,
        ...(meta.decidedAt !== undefined ? { decidedAt: meta.decidedAt } : {}),
      });
    } catch (err) {
      mapLedgerError(err);
    }
  }

  /**
   * awaiting_approval → approved. decidedBy is REQUIRED here (C2: never a
   * model-authored tool argument — only UI/API or governor auto path).
   */
  async function approveAction(
    id: string,
    opts: { decidedBy: string; decidedAt?: string; policyDecisions?: PolicyDecision[] },
  ): Promise<ActionCommitment> {
    const signer = opts.decidedBy?.trim();
    if (!signer) {
      throw new SolarOpsError(
        "illegal_field",
        "approveAction requires non-blank decidedBy (human or system principal)",
      );
    }
    try {
      return await ledger().transitionAction(id, "approved", {
        decidedBy: signer,
        decidedAt: opts.decidedAt ?? new Date().toISOString(),
        ...(opts.policyDecisions !== undefined
          ? { policyDecisions: opts.policyDecisions }
          : {}),
      });
    } catch (err) {
      mapLedgerError(err);
    }
  }

  /** approved → issued. Signature must already be on the row (set at approval). */
  async function issueAction(id: string): Promise<ActionCommitment> {
    try {
      return await ledger().transitionAction(id, "issued");
    } catch (err) {
      mapLedgerError(err);
    }
  }

  /** Permanent grade on an issued row. Re-grade → verification_already_set. */
  async function verifyAction(
    id: string,
    verification: ActionVerification,
  ): Promise<ActionCommitment> {
    try {
      return await ledger().setVerification(id, verification);
    } catch (err) {
      mapLedgerError(err);
    }
  }

  /**
   * Deterministic candidate generation from ATAP credit-clock + detection (C5).
   * The model never invents candidates — only selects by id and authors narrative.
   *
   * Rules:
   *  - eligible + value_leak.total_rm > threshold → load_shift
   *  - eligible + forfeited_credit_rm > 0 + anomaly that day → reschedule_maintenance
   *  - data_issue day OR (ineligible + anomalous) → escalate
   */
  async function proposeCreditActionsDeterministic(
    siteId: string,
    asOfDate?: string,
    opts?: { sweepId?: string; now?: string },
  ): Promise<ActionCandidate[]> {
    const site = requireSite(siteId);
    const day = resolveAsOfDate(asOfDate);
    const clock = atapCreditClock(siteId, day, opts?.now);
    const detect = detectAssetUnderperformance(siteId, undefined, undefined, day);
    const sweepId = opts?.sweepId ?? `swp_pending_${day.replace(/-/g, "")}`;
    const conf = confidenceFromCoverage(
      clock.coverage.observed_days,
      clock.coverage.days_in_period,
    );
    const runRef = clock.source_manifest.runId;
    const anomalyRef = detect.anomaly_event_id;
    const deadline = clock.coverage.period_end;
    const led = ledger();
    const out: ActionCandidate[] = [];

    // Ids key on asOfDate (sweep day), not deadline — deadline may be period end.
    // nextSeq is advisory and does not advance until saveAction; allocate a
    // contiguous local range so multi-candidate proposals never collide.
    let seqCursor = await led.nextSeq(siteId, day);
    const nextId = (): string => {
      const id = actionId(siteId, day, seqCursor);
      seqCursor += 1;
      return id;
    };

    const eligible = clock.eligibility.eligible;
    const totalLeak = clock.value_leak?.total_rm ?? 0;
    const threshold = assumptions.kredit.valueLeakThresholdRm;
    const isAnomalyDay =
      detect.severity === "watch" ||
      detect.severity === "anomaly" ||
      detect.severity === "critical";
    const isDataIssue = detect.severity === "data_issue";

    if (eligible && clock.value_leak && clock.projection && totalLeak > threshold) {
      const kwh = clock.projection.load_shiftable_export_kwh;
      const rm = clock.value_leak.smp_spread_rm;
      // stack−SMP unit savings implied by the DTO (honest: rm / kwh when kwh > 0).
      const unit = kwh > 0 ? round(rm / kwh, 4) : null;
      const unitNote =
        unit != null
          ? `${kwh} kWh × RM ${unit}/kWh (stack−SMP)`
          : `${kwh} kWh load-shiftable export`;
      out.push({
        id: nextId(),
        siteId,
        sweepId,
        kind: "load_shift",
        title: `Load-shift to recover ATAP SMP-spread — ${site.name}`,
        description:
          `Shift on-site load into the export window to absorb ${kwh} kWh of ` +
          `projected load-shiftable export by billing period end ${deadline}. ` +
          `Estimated recovery ${unitNote} = RM ${rm} (value_leak.smp_spread_rm). ` +
          `Total value leak RM ${totalLeak}. Evidence: ${runRef}.`,
        rmImpact: rm,
        kwhImpact: kwh,
        confidence: conf,
        evidenceRefs: [runRef, anomalyRef],
        deadline,
        approvalClass: "human_signature",
      });
    }

    if (
      eligible &&
      clock.value_leak &&
      clock.value_leak.forfeited_credit_rm > 0 &&
      isAnomalyDay
    ) {
      const forfRm = clock.value_leak.forfeited_credit_rm;
      const forfKwh = clock.projection?.forfeited_export_kwh ?? null;
      out.push({
        id: nextId(),
        siteId,
        sweepId,
        kind: "reschedule_maintenance",
        title: `Reschedule maintenance to cut forfeited credit — ${site.name}`,
        description:
          `Reschedule maintenance that may be driving forfeited export credit of ` +
          `RM ${forfRm}` +
          (forfKwh != null ? ` (${forfKwh} kWh forfeited export × Average SMP)` : "") +
          ` by period end ${deadline}. Evidence: ${runRef}, ${anomalyRef}.`,
        rmImpact: forfRm,
        kwhImpact: forfKwh,
        confidence: conf,
        evidenceRefs: [runRef, anomalyRef],
        deadline,
        approvalClass: "human_signature",
      });
    }

    if (isDataIssue || (!eligible && isAnomalyDay)) {
      const reason = isDataIssue
        ? `severity=data_issue on ${day}`
        : `ATAP-ineligible (${clock.eligibility.reason ?? "cap"}) with severity=${detect.severity}`;
      out.push({
        id: nextId(),
        siteId,
        sweepId,
        kind: "escalate",
        title: `Escalate ${site.name} — ${isDataIssue ? "data quality" : "ineligible anomaly"}`,
        description:
          `Escalate site ${siteId} for operator review: ${reason}. ` +
          `Anomaly ${anomalyRef}. Credit-clock run ${runRef}.`,
        rmImpact: null,
        kwhImpact: null,
        confidence: conf === "low" ? "medium" : conf, // escalate stays actionable
        evidenceRefs: [runRef, anomalyRef],
        deadline: day, // escalate is for today, not period-end credit recovery
        approvalClass: "auto",
      });
    }

    return out;
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
    // KREDIT action surface (C1 / C4 / C5)
    proposeAction,
    requestApproval,
    denyByPolicy,
    approveAction,
    issueAction,
    verifyAction,
    proposeCreditActionsDeterministic,
    /** Opt-in live+fixture weather merge (async; off the default hot path). */
    getWeatherMerged,
    /** Pure merge helper — fixture wins; live fills gaps. No I/O. */
    mergeLiveWeather: mergeWeatherPreferFixture,
    /** Exposed for tests: resolves default asOfDate from fixture observations. */
    latestFixtureDate,
    /** Exposed for tests / sweep: the ledger handle this service wraps (do not use from tools). */
    getLedger: ledger,
  };
}

export type SolarOpsService = ReturnType<typeof createSolarOpsService>;

let defaultService: SolarOpsService | null = null;
export function solarOps(): SolarOpsService {
  if (!defaultService) defaultService = createSolarOpsService();
  return defaultService;
}
