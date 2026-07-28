// Deterministic safety layer for the copilot (ADR-0005, ADR-0006, PDR-005 §5, CE4).
//
// PRIMARY defense = numeric grounding: every unit-bearing quantitative claim (kWh,
// MWh, RM, %, kg) in the answer must trace to a number in that turn's tool outputs,
// within tolerance and across unit-class-aware normalization, matched against the
// TOOL's value (not the prompt's). Pool numbers are classified by their JSON key so
// bare counts / carbon factors / capacities cannot ground energy or mass claims via
// ×1000/×0.001 (or cross-class identity).
//
// SECONDARY = a negation-guarded denylist for qualitative claims (fake dispatch,
// guaranteed savings, control/trading) that carry no number for grounding to catch.

export interface GroundingClaim {
  raw: string;
  canonical: number; // kWh for energy, percent for %, RM, kg
  unit: "rm" | "percent" | "kwh" | "mwh" | "kg";
}

export interface SafetyResult {
  ok: boolean;
  grounded: boolean;
  ungroundedClaims: GroundingClaim[];
  blockedPhrases: { phrase: string; reason: string }[];
}

/** Unit class of a number drawn from tool-output JSON, derived from its key. */
export type UnitClass =
  | "energy"
  | "currency"
  | "mass_co2"
  | "percent_ratio"
  | "count"
  | "power"
  | "unclassified";

interface PooledNumber {
  value: number;
  unitClass: UnitClass;
  /** Rate keys (X_per_Y / XPerY) match identity only — never ×1000 / ×0.001. */
  identityOnly: boolean;
}

const GROUNDING_TOLERANCE = 0.02; // relative

/** kWh <-> MWh (and kg <-> tonne) conversion only — no bare x100 / x0.01. */
const ENERGY_MASS_MULT = [1, 1000, 0.001];
/** fraction <-> percent. */
const PERCENT_MULT = [1, 100, 0.01];
const IDENTITY_MULT = [1];

function toNumber(s: string): number {
  return parseFloat(s.replace(/,/g, ""));
}

/** Extract unit-bearing quantitative claims. Bare integers ("inverter 3",
 *  "5 intervals") are intentionally ignored — only operational quantities. */
export function extractClaims(text: string): GroundingClaim[] {
  const claims: GroundingClaim[] = [];
  const add = (raw: string, canonical: number, unit: GroundingClaim["unit"]) => {
    if (Number.isFinite(canonical)) claims.push({ raw: raw.trim(), canonical, unit });
  };
  let m: RegExpExecArray | null;

  const rm = /RM\s*([\d,]+(?:\.\d+)?)\s*(k|m|thousand|million)?/gi;
  while ((m = rm.exec(text))) {
    let v = toNumber(m[1]!);
    const suffix = (m[2] ?? "").toLowerCase();
    if (suffix === "k" || suffix === "thousand") v *= 1e3;
    if (suffix === "m" || suffix === "million") v *= 1e6;
    add(m[0]!, v, "rm");
  }
  const pct = /([\d,]+(?:\.\d+)?)\s*%/g;
  while ((m = pct.exec(text))) add(m[0]!, toNumber(m[1]!), "percent");
  const mwh = /([\d,]+(?:\.\d+)?)\s*mwh/gi;
  while ((m = mwh.exec(text))) add(m[0]!, toNumber(m[1]!) * 1000, "mwh");
  const kwh = /([\d,]+(?:\.\d+)?)\s*kwh/gi;
  while ((m = kwh.exec(text))) add(m[0]!, toNumber(m[1]!), "kwh");
  const kg = /([\d,]+(?:\.\d+)?)\s*kg/gi;
  while ((m = kg.exec(text))) add(m[0]!, toNumber(m[1]!), "kg");

  return claims;
}

/**
 * Detect rate-shaped keys X_per_Y / XPerY and return the numerator unit class
 * token: "rm" | "kg" | "kwh" | "other". null if not a rate key.
 *
 * Examples: tariff_rm_per_kwh, tariffRmPerKwh, averageSmpRmPerKwh,
 * volumetricStackRmPerKwh, carbon_factor_kgco2_per_kwh, carbonFactorKgco2PerKwh,
 * residual_kwh_per_day.
 */
function detectRateNumerator(key: string): "rm" | "kg" | "kwh" | "other" | null {
  const lower = key.toLowerCase();

  // snake_case: …_NUMERATOR_per_DENOM…
  if (lower.includes("_per_")) {
    const before = lower.split("_per_")[0]!;
    if (before.endsWith("rm") || before.includes("_rm")) return "rm";
    if (before.includes("kgco2") || before.endsWith("_kg") || /(?:^|_)kg$/.test(before)) return "kg";
    if (before.includes("kwh") || before.includes("mwh")) return "kwh";
    return "other";
  }

  // camelCase: …NumeratorPerDenom… (Per followed by an uppercase unit start)
  if (/[a-z0-9]Per[A-Z]/.test(key)) {
    const m = key.match(/^(.+?)Per[A-Z]/);
    if (!m) return "other";
    const num = m[1]!.toLowerCase();
    if (num.endsWith("rm") || num.includes("rm")) return "rm";
    if (num.includes("kgco2") || num.includes("kg")) return "kg";
    if (num.includes("kwh") || num.includes("mwh")) return "kwh";
    return "other";
  }

  return null;
}

function isRateKey(key: string): boolean {
  return detectRateNumerator(key) !== null;
}

/**
 * Classify a JSON key into a unit class. Order matters:
 *  1. Rate shape X_per_Y / XPerY → class by NUMERATOR (rm/kg/kwh)
 *  2. Energy totals (kwh/mwh)
 *  3. Currency (camelCase Rm / snake _rm / rm_)
 *  4. Mass CO₂ (Kg / co2 / _kg / carbon)
 *  5. Power capacity (kwp / _kw) — grounds nothing unit-bearing
 *  6. Percent / ratio
 *  7. Count (intervals, rank, active_anomalies, …) — grounds nothing unit-bearing
 *  8. Unclassified — also grounds nothing unit-bearing (wildcard closed)
 */
export function classifyKey(key: string | null | undefined): UnitClass {
  if (key == null || key === "") return "unclassified";
  const k = key.toLowerCase();

  // 1. RATE KEYS FIRST — numerator decides class (identity mult applied at pool time)
  const rateNum = detectRateNumerator(key);
  if (rateNum === "rm") return "currency";
  if (rateNum === "kg") return "mass_co2";
  if (rateNum === "kwh") return "energy";
  // rateNum === "other" falls through (e.g. sun_hours_per_day → count via "hours")

  // 2. ENERGY totals
  if (k.includes("kwh") || k.includes("mwh")) return "energy";

  // 3. CURRENCY: Rm$ / ^rm / Rm[A-Z] / _rm / rm_
  if (
    /Rm$/.test(key) ||
    /^rm(?:[A-Z_]|$)/.test(key) ||
    /Rm[A-Z]/.test(key) ||
    k.includes("_rm") ||
    k.includes("rm_")
  ) {
    return "currency";
  }

  // 4. MASS_CO2: Kg$ / Co2 / co2 / _kg / kgco2 / carbon
  if (
    /Kg$/.test(key) ||
    /Co2/.test(key) ||
    k.includes("co2") ||
    k.includes("_kg") ||
    k.includes("kgco2") ||
    k.includes("carbon")
  ) {
    return "mass_co2";
  }

  // 5. POWER capacity: kwp / Kwp / _kw$ — neither energy nor money
  if (k.includes("kwp") || /_kw$/.test(k)) return "power";

  // 6. PERCENT_RATIO
  if (
    k.includes("_pct") ||
    k.includes("pct") ||
    k.includes("_ratio") ||
    k.includes("ratio") ||
    k.includes("fraction") ||
    k.includes("residual")
  ) {
    return "percent_ratio";
  }

  // 7. COUNT — grounds nothing unit-bearing. Dropped over-broad "_n" substring.
  if (
    k.includes("interval") ||
    k.includes("count") ||
    k.includes("days") ||
    k.includes("hours") ||
    k.includes("observed_days") ||
    k.includes("rank") ||
    k.includes("active_anomalies") ||
    k.includes("activeanomalies")
  ) {
    return "count";
  }

  return "unclassified";
}

/** Multipliers allowed when matching a claim unit against a pooled unit class.
 *  null = this pool entry cannot ground this claim.
 *  COUNT, POWER, and UNCLASSIFIED ground nothing unit-bearing. */
function allowedMultipliers(
  claimUnit: GroundingClaim["unit"],
  poolClass: UnitClass,
  identityOnly: boolean,
): number[] | null {
  if (poolClass === "count" || poolClass === "power" || poolClass === "unclassified") {
    return null;
  }

  const energyMass = identityOnly ? IDENTITY_MULT : ENERGY_MASS_MULT;

  switch (claimUnit) {
    case "kwh":
    case "mwh":
      if (poolClass === "energy") return energyMass;
      return null;
    case "rm":
      if (poolClass === "currency") return IDENTITY_MULT;
      return null;
    case "kg":
      // kg <-> tonne on mass totals; rates stay identity-only
      if (poolClass === "mass_co2") return energyMass;
      return null;
    case "percent":
      if (poolClass === "percent_ratio") return PERCENT_MULT;
      return null;
    default:
      return null;
  }
}

/** SourceManifest assumption entries: classify numeric `value` from sibling `name`. */
function isAssumptionEntry(obj: Record<string, unknown>): obj is {
  name: string;
  value: number;
  note?: unknown;
} {
  return typeof obj.name === "string" && typeof obj.value === "number" && Number.isFinite(obj.value);
}

function poolEntry(value: number, key: string): PooledNumber {
  return {
    value: Math.abs(value),
    unitClass: classifyKey(key),
    identityOnly: isRateKey(key),
  };
}

function collectClassifiedToolNumbers(toolOutputs: unknown[]): PooledNumber[] {
  const nums: PooledNumber[] = [];
  const walk = (v: unknown, key: string | null): void => {
    if (typeof v === "number" && Number.isFinite(v)) {
      if (key == null) {
        // Bare array elements / root — unclassified, grounds nothing unit-bearing
        nums.push({ value: Math.abs(v), unitClass: "unclassified", identityOnly: false });
      } else {
        nums.push(poolEntry(v, key));
      }
    } else if (Array.isArray(v)) {
      for (const item of v) {
        // SourceManifest.assumptions[]: { name, value, note } — class from name, not "value"
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const obj = item as Record<string, unknown>;
          if (isAssumptionEntry(obj)) {
            nums.push(poolEntry(obj.value, obj.name));
            for (const [k, child] of Object.entries(obj)) {
              if (k === "value" || k === "name") continue;
              walk(child, k);
            }
            continue;
          }
        }
        walk(item, null);
      }
    } else if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        walk(child, k);
      }
    }
  };
  toolOutputs.forEach((o) => walk(o, null));
  return nums;
}

/** Flat absolute numbers from tool outputs (public helper; class is used only internally). */
export function collectToolNumbers(toolOutputs: unknown[]): number[] {
  return collectClassifiedToolNumbers(toolOutputs).map((p) => p.value);
}

function isGrounded(claim: GroundingClaim, pool: PooledNumber[]): boolean {
  const cv = Math.abs(claim.canonical);
  if (cv === 0) return true; // zero ("0 kWh recovery") is always safe
  for (const { value: t, unitClass, identityOnly } of pool) {
    const mults = allowedMultipliers(claim.unit, unitClass, identityOnly);
    if (!mults) continue;
    for (const k of mults) {
      const cand = t * k;
      if (cand !== 0 && Math.abs(cv - cand) / Math.abs(cand) <= GROUNDING_TOLERANCE) return true;
    }
  }
  return false;
}

const NEGATORS = /\b(no|not|n['’]t|never|without|cannot|can['’]t|won['’]t|don['’]t|do not|isn['’]t|wasn['’]t|haven['’]t|hasn['’]t|refuse|unable)\b/i;

const DENY_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(crew|technician|team|truck|someone)\b[^.?!]{0,30}\b(dispatch\w*|sent|en route|on the way)\b/i, reason: "claims a field crew was dispatched" },
  { pattern: /\b(dispatch\w*|sent)\b[^.?!]{0,30}\b(crew|technician|team|truck)\b/i, reason: "claims a field crew was dispatched" },
  { pattern: /\b(saved|recovered|earned|made)\b[^.?!]{0,15}\bRM\s*[\d,]/i, reason: "claims realized/guaranteed savings" },
  { pattern: /\bguarantee\w*\b[^.?!]{0,30}\b(saving|recovery|kwh|rm|return|profit|payback)\b/i, reason: "guarantees a financial/energy outcome" },
  { pattern: /\b(control|curtail|trade|trading|dispatch\w*)\b[^.?!]{0,20}\b(inverter|grid|bess|battery|market|energy)\b/i, reason: "implies grid/inverter control or energy trading" },
];

/** Look back ~40 chars before a match for a negator, so disclaimers
 *  ("no crew was dispatched", "cannot guarantee savings") are not flagged. */
function isNegated(text: string, matchIndex: number): boolean {
  const before = text.slice(Math.max(0, matchIndex - 40), matchIndex);
  return NEGATORS.test(before);
}

export function checkDenylist(text: string): { phrase: string; reason: string }[] {
  const hits: { phrase: string; reason: string }[] = [];
  for (const { pattern, reason } of DENY_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (!isNegated(text, m.index)) hits.push({ phrase: m[0]!.trim(), reason });
    }
  }
  return hits;
}

export function validateAnswer(answer: string, toolOutputs: unknown[]): SafetyResult {
  const pool = collectClassifiedToolNumbers(toolOutputs);
  const ungroundedClaims = extractClaims(answer).filter((c) => !isGrounded(c, pool));
  const blockedPhrases = checkDenylist(answer);
  const grounded = ungroundedClaims.length === 0;
  return {
    ok: grounded && blockedPhrases.length === 0,
    grounded,
    ungroundedClaims,
    blockedPhrases,
  };
}
