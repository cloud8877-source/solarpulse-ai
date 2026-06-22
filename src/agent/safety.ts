// Deterministic safety layer for the copilot (ADR-0005, ADR-0006, PDR-005 §5, CE4).
//
// PRIMARY defense = numeric grounding: every unit-bearing quantitative claim (kWh,
// MWh, RM, %, kg) in the answer must trace to a number in that turn's tool outputs,
// within tolerance and across kWh<->MWh / fraction<->percent normalization, matched
// against the TOOL's value (not the prompt's). This is phrasing-independent, so a
// fabricated "RM 50,000" or a stale "13.1%" that doesn't match the real tool output
// is caught regardless of wording.
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

const GROUNDING_TOLERANCE = 0.02; // relative
const MULTIPLIERS = [1, 100, 0.01, 1000, 0.001]; // fraction<->percent, kWh<->MWh

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

export function collectToolNumbers(toolOutputs: unknown[]): number[] {
  const nums: number[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "number" && Number.isFinite(v)) nums.push(Math.abs(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  toolOutputs.forEach(walk);
  return nums;
}

function isGrounded(canonical: number, pool: number[]): boolean {
  const cv = Math.abs(canonical);
  if (cv === 0) return true; // zero ("0 kWh recovery") is always safe
  for (const t of pool) {
    for (const k of MULTIPLIERS) {
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
  const pool = collectToolNumbers(toolOutputs);
  const ungroundedClaims = extractClaims(answer).filter((c) => !isGrounded(c.canonical, pool));
  const blockedPhrases = checkDenylist(answer);
  const grounded = ungroundedClaims.length === 0;
  return {
    ok: grounded && blockedPhrases.length === 0,
    grounded,
    ungroundedClaims,
    blockedPhrases,
  };
}
