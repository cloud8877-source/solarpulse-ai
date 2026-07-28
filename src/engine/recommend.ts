// Recommendation ranker v1 (PDR-004 §5, US-005).
// Impact and money come ONLY from config assumptions; every assumption is returned.
// Data-issue / weather causes credit zero recoverable energy and steer to review, not dispatch.

import { assumptions as A } from "../config/assumptions";
import type { AnomalyResult, Confidence, Recommendation, RootCauseResult, Site } from "../domain/types";
import { round } from "./math";

interface Candidate {
  action: string;
  recoverableFraction: number;
  confidence: Confidence;
  rationale: string;
}

function impact(residualKwhPerDay: number, site: Site, recoverableFraction: number) {
  const tariff = site.tariffAssumptionRmPerKwh ?? A.retailTariffRmPerKwh;
  const carbon = site.carbonFactorKgco2PerKwh ?? A.carbonFactorKgco2PerKwh;
  const recoveryKwhMonth =
    Math.abs(residualKwhPerDay) * A.recovery.recurrenceDaysPerMonth * recoverableFraction;
  return {
    expectedRecoveryKwhMonth: round(recoveryKwhMonth),
    estimatedRmValue: round(recoveryKwhMonth * tariff),
    estimatedCo2Kg: round(recoveryKwhMonth * carbon),
    tariff,
    carbon,
  };
}

export interface RankArgs {
  anomaly: AnomalyResult;
  rootCause: RootCauseResult;
  site: Site;
}

function candidatesFor(args: RankArgs): Candidate[] {
  const { anomaly, rootCause } = args;
  const fracByConf = A.recovery.recoverableFractionByConfidence;

  switch (rootCause.likelyCause) {
    case "inverter_or_string_underperformance": {
      const inverter = anomaly.evidence.inverterSignal?.split(" ")[0] ?? "the affected inverter/string";
      return [
        {
          action: `Inspect ${inverter} and associated strings`,
          recoverableFraction: fracByConf[rootCause.confidence],
          confidence: rootCause.confidence,
          rationale: "Weather-adjusted residual is persistent and localised to one inverter/string.",
        },
        {
          action: "Verify inverter telemetry and recent alarm/event logs",
          recoverableFraction: fracByConf.low,
          confidence: "low",
          rationale: "Confirm the fault and rule out a sensor/logging artefact before any field visit.",
        },
      ];
    }
    case "soiling_or_degradation":
      return [
        {
          action: "Schedule module cleaning / soiling inspection",
          recoverableFraction: fracByConf[rootCause.confidence],
          confidence: rootCause.confidence,
          rationale: "Broad, persistent, weather-adjusted shortfall consistent with soiling.",
        },
        {
          action: "Review multi-day trend and check shading / vegetation",
          recoverableFraction: fracByConf.low,
          confidence: "low",
          rationale: "Distinguish reversible soiling from irreversible degradation.",
        },
      ];
    case "telemetry_data_quality_issue":
      return [
        {
          action: "Check data logger / telemetry feed and backfill missing intervals",
          recoverableFraction: 0,
          confidence: "low",
          rationale: "Residual is unreliable while telemetry is missing/noisy; fix the data first.",
        },
        {
          action: "Operator review of site telemetry before any field action",
          recoverableFraction: 0,
          confidence: "low",
          rationale: "Avoid over-diagnosing equipment on bad data; no autonomous dispatch.",
        },
      ];
    case "weather_explained":
      return [
        {
          action: "Continue monitoring; no field action required",
          recoverableFraction: 0,
          confidence: rootCause.confidence,
          rationale: "Any shortfall is explained by weather; observed generation is within band.",
        },
        {
          action: "Re-check performance when irradiance normalises",
          recoverableFraction: 0,
          confidence: "low",
          rationale: "Confirm the site returns to expected output after weather recovers.",
        },
      ];
    default:
      return [
        {
          action: "Operator review to gather additional evidence",
          recoverableFraction: fracByConf.low,
          confidence: "low",
          rationale: "Evidence is insufficient to attribute a single cause.",
        },
        {
          action: "Continue monitoring and re-run analysis next interval",
          recoverableFraction: 0,
          confidence: "low",
          rationale: "Accumulate more data before committing resources.",
        },
      ];
  }
}

export function rankActions(args: RankArgs): Recommendation[] {
  const severityWeight = A.ranking.severityWeight[args.anomaly.severity];
  const residualDay = args.anomaly.residualKwh;

  const scored = candidatesFor(args).map((c) => {
    const confidenceWeight = A.ranking.confidenceWeight[c.confidence];
    const score =
      severityWeight * confidenceWeight * c.recoverableFraction -
      (c.confidence === "low" ? A.ranking.uncertaintyPenalty : 0);
    return { c, imp: impact(residualDay, args.site, c.recoverableFraction), score };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.map((s, i) => ({
    rank: i + 1,
    action: s.c.action,
    expectedRecoveryKwhMonth: s.imp.expectedRecoveryKwhMonth,
    estimatedRmValue: s.imp.estimatedRmValue,
    estimatedCo2Kg: s.imp.estimatedCo2Kg,
    confidence: s.c.confidence,
    assumptions: {
      tariff_rm_per_kwh: s.imp.tariff,
      carbon_factor_kgco2_per_kwh: s.imp.carbon,
      recoverable_fraction: s.c.recoverableFraction,
      recurrence_days_per_month: A.recovery.recurrenceDaysPerMonth,
      residual_kwh_per_day: round(Math.abs(residualDay)),
    },
    rationale: s.c.rationale,
  }));
}
