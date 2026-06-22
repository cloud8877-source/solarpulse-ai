// Root-cause classifier v1 — rule-based evidence (PDR-004 §4).
// Returns one of the six PDR-005 cause enums with a confidence and explicit caveats.

import { assumptions as A } from "../config/assumptions";
import type { AnomalyResult, RootCauseResult, Site } from "../domain/types";

export interface RootCauseArgs {
  anomaly: AnomalyResult;
  site: Site;
}

export function classifyRootCause(args: RootCauseArgs): RootCauseResult {
  const a = args.anomaly;
  const ev = a.evidence;
  const pctStr = `${(a.residualPct * 100).toFixed(1)}%`;
  const fixtureCaveat = "Fixture telemetry; figures are demo estimates subject to field verification.";

  // 1. Data quality dominates — never diagnose equipment on bad telemetry (CE3).
  if (a.severity === "data_issue") {
    return {
      likelyCause: "telemetry_data_quality_issue",
      confidence: "high",
      evidence: [
        ...ev.notes,
        `${ev.missingIntervals} missing and ${ev.noisyIntervals} noisy of ${ev.validIntervals + ev.missingIntervals} intervals.`,
      ],
      caveats: [
        "Telemetry quality is insufficient to confirm an equipment fault.",
        "Recommend telemetry/data-logger check and operator review before any field action.",
      ],
    };
  }

  // 2. Healthy — observed within band.
  if (a.severity === "healthy") {
    return {
      likelyCause: "weather_explained",
      confidence: "high",
      evidence: [`Observed generation is within the expected band (residual ${pctStr}).`],
      caveats: [fixtureCaveat],
    };
  }

  // 3. Real shortfall (watch / anomaly / critical) but weather was adverse.
  if (!ev.weatherNormal) {
    return {
      likelyCause: "weather_explained",
      confidence: "medium",
      evidence: [`Residual ${pctStr} coincides with low-irradiance / adverse weather.`],
      caveats: ["Weather-driven shortfall; re-check when irradiance normalises.", fixtureCaveat],
    };
  }

  // 4. Weather normal + single-inverter signal + persistence -> equipment.
  if (ev.inverterSignal && ev.persistentIntervals >= A.persistence.minConsecutiveIntervals) {
    return {
      likelyCause: "inverter_or_string_underperformance",
      confidence: a.severity === "critical" ? "high" : "medium",
      evidence: [
        `Residual is ${pctStr} after weather adjustment.`,
        "Irradiance was within the expected range (weather normal).",
        `${ev.inverterSignal}.`,
        `Shortfall persisted for ${ev.persistentIntervals} consecutive daylight intervals.`,
      ],
      caveats: [
        "Confidence limited by inverter-level data availability.",
        fixtureCaveat,
      ],
    };
  }

  // 5. Weather normal + broad persistent shortfall, no single-inverter signal -> soiling/degradation.
  if (ev.persistentIntervals >= A.persistence.minConsecutiveIntervals) {
    return {
      likelyCause: "soiling_or_degradation",
      confidence: "medium",
      evidence: [
        `Residual ${pctStr} with normal weather and no single-inverter signal.`,
        "Broad, persistent shortfall is consistent with soiling or degradation.",
      ],
      caveats: ["Single-day fixture window; a multi-day trend is needed to confirm.", fixtureCaveat],
    };
  }

  // 6. Evidence too weak to attribute.
  return {
    likelyCause: "unknown_operator_review_required",
    confidence: "low",
    evidence: [`Residual ${pctStr} but evidence is insufficient to attribute a single cause.`],
    caveats: ["Operator review recommended before any action.", fixtureCaveat],
  };
}
