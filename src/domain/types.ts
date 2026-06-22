// Core domain types for SolarOps / SolarPulse.
// Mirrors docs/schemas/solarops_schema.sql and PDR-003, in camelCase.

export type Severity = "healthy" | "watch" | "anomaly" | "critical" | "data_issue";

export type LikelyCause =
  | "weather_explained"
  | "inverter_or_string_underperformance"
  | "soiling_or_degradation"
  | "telemetry_data_quality_issue"
  | "possible_curtailment_or_grid_issue"
  | "unknown_operator_review_required";

export type Confidence = "low" | "medium" | "high";

export type Horizon = "day_ahead" | "week_ahead" | "custom";
export type GridHorizon = "current" | "day_ahead" | "week_ahead";
export type ReportFormat = "markdown" | "pdf";

// Quality flags: the PDR-003 §5 set plus the extra labels present in the fixtures.
export type QualityFlag =
  | "missing_generation"
  | "stale_telemetry"
  | "weather_unavailable"
  | "irradiance_outlier"
  | "generation_outlier"
  | "inverter_level_missing"
  | "fixture_data"
  | "public_context_only"
  | "partner_data"
  | "seeded_inverter_underperformance"
  | "generation_noisy"
  | "public_context_reference"
  | "metric_unavailable"
  | "metric_from_reference"
  // Allow as-yet-unknown labels from data without losing autocomplete on the known ones.
  | (string & {});

// Provenance source types (PDR-003 §1 / source_manifest.md).
export type SourceType =
  | "public"
  | "open_benchmark"
  | "fixture"
  | "partner"
  | "model_estimate"
  | "manual_assumption";

export interface Site {
  id: string;
  tenantId: string;
  name: string;
  region: string;
  latitude: number | null;
  longitude: number | null;
  capacityKwp: number;
  inverterCount: number | null;
  commissioningDate: string | null;
  tariffAssumptionRmPerKwh: number | null;
  carbonFactorKgco2PerKwh: number | null;
  performanceRatio: number;
  source: string;
  isFixture: boolean;
}

export interface Observation {
  id: string;
  siteId: string;
  timestamp: string; // ISO 8601 with +08:00 offset
  generationKwh: number | null; // null = missing telemetry (must never be treated as 0)
  inverterId: string | null;
  stringId: string | null;
  availability: number | null;
  source: string;
  isFixture: boolean;
  qualityFlags: QualityFlag[];
}

export interface Weather {
  id: string;
  siteId: string;
  timestamp: string;
  irradianceWm2: number | null;
  temperatureC: number | null;
  cloudCover: number | null;
  rainfallMm: number | null;
  source: string;
  isFixture: boolean;
  qualityFlags: QualityFlag[];
}

export interface GridSnapshot {
  id: string;
  region: string;
  timestamp: string;
  demandMw: number | null;
  forecastHorizon: string;
  source: string;
  fetchedAt: string | null;
  sourceUrl: string | null;
  qualityFlags: QualityFlag[];
}

export interface Assumption {
  name: string;
  value: number | string;
  note?: string;
}

export interface ManifestInput {
  name: string;
  sourceType: SourceType;
  sourceName: string;
  url?: string;
  license?: string;
  isFixture: boolean;
}

export interface SourceManifest {
  runId: string;
  inputs: ManifestInput[];
  assumptions: Assumption[];
  generatedAt: string;
}

// Per-interval expected generation, used for charts and for apples-to-apples residuals.
export interface ExpectedInterval {
  timestamp: string;
  expectedKwh: number;
  weatherAvailable: boolean;
}

export interface ForecastResult {
  siteId: string;
  horizon: Horizon;
  runAt: string;
  expectedKwh: number;
  lowerKwh: number;
  upperKwh: number;
  modelVersion: string;
  // value is null when a site has no clean intervals to backtest against and no
  // reference WAPE was supplied — surfaced via a metric_unavailable flag. Never a
  // silent 0, which would read as a perfect (over-claimed) forecast.
  metric: { name: string; value: number | null };
  assumptions: Assumption[];
  qualityFlags: QualityFlag[];
  intervals: ExpectedInterval[];
}

export interface AnomalyEvidence {
  weatherNormal: boolean;
  persistentIntervals: number;
  validIntervals: number;
  missingIntervals: number;
  noisyIntervals: number;
  inverterSignal?: string;
  notes: string[];
}

export interface AnomalyResult {
  siteId: string;
  windowStart: string;
  windowEnd: string;
  observedKwh: number; // sum over valid (non-missing) intervals only
  expectedKwh: number; // sum over the SAME valid intervals — apples-to-apples
  residualKwh: number;
  residualPct: number;
  severity: Severity;
  qualityFlags: QualityFlag[];
  evidence: AnomalyEvidence;
  modelVersion: string;
}

export interface RootCauseResult {
  likelyCause: LikelyCause;
  confidence: Confidence;
  evidence: string[];
  caveats: string[];
}

// Persisted anomaly event (schema.sql anomaly_events) = detection + classification,
// addressable by a deterministic id so explain/rank/report can resolve it later.
export interface AnomalyEvent {
  id: string;
  siteId: string;
  windowStart: string;
  windowEnd: string;
  observedKwh: number;
  expectedKwh: number;
  residualKwh: number;
  residualPct: number;
  severity: Severity;
  qualityFlags: QualityFlag[];
  evidence: AnomalyEvidence;
  likelyCause: LikelyCause;
  confidence: Confidence;
  rootCauseEvidence: string[];
  caveats: string[];
  modelVersion: string;
  createdAt: string;
}

export interface Recommendation {
  rank: number;
  action: string;
  expectedRecoveryKwhMonth: number;
  estimatedRmValue: number;
  estimatedCo2Kg: number;
  confidence: Confidence;
  assumptions: Record<string, number | string>;
  rationale: string;
}

export interface Report {
  reportId: string;
  siteId: string;
  anomalyEventId: string | null;
  title: string;
  format: ReportFormat;
  content: string;
  includesProvenance: boolean;
  includesAssumptions: boolean;
  sourceManifest: SourceManifest;
  createdAt: string;
}
