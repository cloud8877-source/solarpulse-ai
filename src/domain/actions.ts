// Action commitment ledger types for the KREDIT agent.
// Proposed dated actions against each site's ATAP credit clock, with policy
// decisions, human signature, and later meter-based verification grades.

export type ActionKind = "load_shift" | "reschedule_maintenance" | "escalate";

export type ActionStatus =
  | "proposed"
  | "awaiting_approval"
  | "approved"
  | "issued"
  | "denied_by_policy"
  | "expired";

export type PolicyOutcome = "allow" | "deny" | "require_approval";

export interface PolicyDecision {
  policyId: string;
  outcome: PolicyOutcome;
  reason: string;
}

export interface ActionVerification {
  outcome: "verified" | "partial" | "falsified";
  measuredRm: number | null;
  note: string;
  verifiedAt: string;
  /**
   * Grade-band + coverage caveats (config/engine derived; never model-authored).
   * Optional for seed rows written before I6.
   */
  assumptions?: string[];
}

export interface ActionCommitment {
  id: string;
  siteId: string;
  sweepId: string;
  kind: ActionKind;
  title: string;
  description: string;
  rmImpact: number | null;
  kwhImpact: number | null;
  confidence: "low" | "medium" | "high";
  evidenceRefs: string[];
  /** ISO date (YYYY-MM-DD) — the credit-clock date this action must happen by. */
  deadline: string;
  approvalClass: "auto" | "human_signature";
  status: ActionStatus;
  policyDecisions: PolicyDecision[];
  verification: ActionVerification | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface SweepRun {
  id: string;
  asOfDate: string;
  startedAt: string;
  siteCount: number;
  proposedActions: number;
  blockedActions: number;
  notes: string[];
}

/** Compact YYYYMMDD from an ISO date or date-key (no time, no randomness). */
export function dateKeyCompact(dateKey: string): string {
  return dateKey.slice(0, 10).replace(/-/g, "");
}

/**
 * Deterministic action id. No randomness; no Date.now — callers pass dateKey.
 * Shape: act_<site>_<yyyymmdd>_<seq>
 */
export function actionId(siteId: string, dateKey: string, seq: number): string {
  return `act_${siteId}_${dateKeyCompact(dateKey)}_${seq}`;
}

/**
 * Deterministic sweep id. No randomness; no Date.now — callers pass asOfDate.
 * Shape: swp_<yyyymmdd> or swp_<yyyymmdd>_<seq>
 */
export function sweepId(asOfDate: string, seq?: number): string {
  const key = dateKeyCompact(asOfDate);
  return seq === undefined ? `swp_${key}` : `swp_${key}_${seq}`;
}
