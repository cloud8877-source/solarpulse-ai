// Deterministic safety layer for the copilot (ADR-0005, ADR-0006, PDR-005 §5, CE4).
//
// PRIMARY defense = numeric grounding: every unit-bearing quantitative claim (kWh,
// MWh, RM, %, kg) in the answer must trace to a number in that turn's tool outputs,
// within tolerance and across unit-class-aware normalization, matched against the
// TOOL's value (not the prompt's). Pool numbers are classified by their JSON key so
// bare counts / carbon factors cannot ground energy or mass claims via x1000/x100.
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
  | "unclassified";

interface PooledNumber {
  value: number;
  unitClass: UnitClass;
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
 * Classify a JSON key into a unit class. Order matters: energy wins over mass for
 * rates like carbon_factor_kgco2_per_kwh (contains both "kwh" and "carbon"), so a
 * kg claim cannot ground via the carbon factor ×1000.
 */
export function classifyKey(key: string | null | undefined): UnitClass {
  if (key == null || key === "") return "unclassified";
  const k = key.toLowerCase();

  // ENERGY: ends _kwh/_mwh or contains kwh/mwh (covers camelCase …PerKwh too)
  if (k.includes("kwh") || k.includes("mwh")) return "energy";

  // CURRENCY: _rm / rm_
  if (k.includes("_rm") || k.includes("rm_")) return "currency";

  // MASS_CO2: _kg / _kgco2 / co2_kg / carbon
  if (
    k.includes("_kg") ||
    k.includes("kgco2") ||
    k.includes("co2_kg") ||
    k.includes("carbon")
  ) {
    return "mass_co2";
  }

  // PERCENT_RATIO: _pct / _ratio / fraction / residual
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

  // COUNT: interval / count / days / _n / hours / observed_days
  if (
    k.includes("interval") ||
    k.includes("count") ||
    k.includes("days") ||
    k.includes("_n") ||
    k.includes("hours") ||
    k.includes("observed_days")
  ) {
    return "count";
  }

  return "unclassified";
}

/** Multipliers allowed when matching a claim unit against a pooled unit class.
 *  null = this pool entry cannot ground this claim. COUNT grounds nothing with units. */
function allowedMultipliers(
  claimUnit: GroundingClaim["unit"],
  poolClass: UnitClass,
): number[] | null {
  if (poolClass === "count") return null;

  switch (claimUnit) {
    case "kwh":
    case "mwh":
      if (poolClass === "energy") return ENERGY_MASS_MULT;
      if (poolClass === "unclassified") return IDENTITY_MULT;
      return null;
    case "rm":
      if (poolClass === "currency" || poolClass === "unclassified") return IDENTITY_MULT;
      return null;
    case "kg":
      // kg <-> tonne conversion on mass-class and unclassified
      if (poolClass === "mass_co2" || poolClass === "unclassified") return ENERGY_MASS_MULT;
      return null;
    case "percent":
      if (poolClass === "percent_ratio" || poolClass === "unclassified") return PERCENT_MULT;
      return null;
    default:
      return null;
  }
}

function collectClassifiedToolNumbers(toolOutputs: unknown[]): PooledNumber[] {
  const nums: PooledNumber[] = [];
  const walk = (v: unknown, key: string | null): void => {
    if (typeof v === "number" && Number.isFinite(v)) {
      nums.push({ value: Math.abs(v), unitClass: classifyKey(key) });
    } else if (Array.isArray(v)) {
      // Bare array elements have no own key → unclassified
      v.forEach((item) => walk(item, null));
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
  for (const { value: t, unitClass } of pool) {
    const mults = allowedMultipliers(claim.unit, unitClass);
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
