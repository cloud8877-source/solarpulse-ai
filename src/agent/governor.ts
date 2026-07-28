// Deterministic KREDIT policy governor (I5 / C3).
// Runs OUTSIDE the LLM. Writes PolicyDecision[] into ledger rows via the service.
// The model never generates policy outcomes.

import { assumptions } from "../config/assumptions";
import type { ActionKind, PolicyDecision } from "../domain/actions";
import type { Confidence, Severity } from "../domain/types";
import type { ToolApprovalStatus } from "ai";

/** Credit-recovery kinds that require ATAP eligibility and clean data. */
const CREDIT_KINDS: ReadonlySet<ActionKind> = new Set([
  "load_shift",
  "reschedule_maintenance",
]);

/** Kinds that "commit" an operational recommendation (not escalate). */
const COMMIT_KINDS: ReadonlySet<ActionKind> = new Set([
  "load_shift",
  "reschedule_maintenance",
]);

export interface GovernorCandidate {
  id: string;
  siteId: string;
  kind: ActionKind;
  confidence: Confidence;
  evidenceRefs: string[];
  deadline: string;
  /** Optional; used only for diagnostics. */
  title?: string;
}

export interface GovernorContext {
  /** Site ATAP eligibility at asOfDate. */
  siteEligible: boolean;
  /** Detection severity for the site on asOfDate. */
  severity: Severity;
  /**
   * Evidence refs the sweep can resolve this turn (credit-clock runId,
   * anomaly_event_id, …). Missing/unknown refs fail evidence_required.
   */
  knownEvidenceRefs: ReadonlySet<string> | readonly string[];
  /**
   * Count of non-escalate actions already accepted this sweep for this site
   * (proposed/awaiting/approved/issued this run — not denied).
   */
  nonEscalateCountThisSweep: number;
  /** Optional override for rate limit (defaults to assumptions.kredit). */
  maxNonEscalateActionsPerSite?: number;
}

export type GovernorStatus = "denied" | "user-approval" | "approved";

export interface GovernorResult {
  status: GovernorStatus;
  decisions: PolicyDecision[];
}

function knownSet(ctx: GovernorContext): Set<string> {
  if (ctx.knownEvidenceRefs instanceof Set) return ctx.knownEvidenceRefs;
  return new Set(ctx.knownEvidenceRefs);
}

/**
 * Evaluate policies IN ORDER. First deny short-circuits with status 'denied'.
 * Non-escalate survivors end as 'user-approval'; escalate ends as 'approved'.
 */
export function evaluate(
  candidate: GovernorCandidate,
  context: GovernorContext,
): GovernorResult {
  const decisions: PolicyDecision[] = [];
  const kind = candidate.kind;

  // 1. eligibility_required — ATAP-ineligible sites cannot take credit kinds
  if (CREDIT_KINDS.has(kind) && !context.siteEligible) {
    decisions.push({
      policyId: "eligibility_required",
      outcome: "deny",
      reason: `Site is ATAP-ineligible; credit kind '${kind}' denied`,
    });
    return { status: "denied", decisions };
  }
  decisions.push({
    policyId: "eligibility_required",
    outcome: "allow",
    reason: context.siteEligible
      ? "Site is ATAP-eligible (or non-credit kind)"
      : "Non-credit kind permitted on ineligible site",
  });

  // 2. no_action_on_bad_data — data_issue day blocks load_shift/reschedule; escalate ok
  if (COMMIT_KINDS.has(kind) && context.severity === "data_issue") {
    decisions.push({
      policyId: "no_action_on_bad_data",
      outcome: "deny",
      reason: `Severity data_issue on this day; '${kind}' denied (escalate allowed)`,
    });
    return { status: "denied", decisions };
  }
  decisions.push({
    policyId: "no_action_on_bad_data",
    outcome: "allow",
    reason:
      context.severity === "data_issue"
        ? "data_issue day but escalate is permitted"
        : `Severity '${context.severity}' permits '${kind}'`,
  });

  // 3. evidence_required — missing/unresolvable refs OR confidence low → deny commit kinds
  if (COMMIT_KINDS.has(kind)) {
    const known = knownSet(context);
    const missing = candidate.evidenceRefs.filter((r) => !known.has(r));
    if (missing.length > 0 || candidate.confidence === "low") {
      const why =
        candidate.confidence === "low"
          ? "confidence is low"
          : `unresolvable evidence refs: ${missing.join(", ")}`;
      decisions.push({
        policyId: "evidence_required",
        outcome: "deny",
        reason: `Commit kind '${kind}' denied — ${why}`,
      });
      return { status: "denied", decisions };
    }
  }
  decisions.push({
    policyId: "evidence_required",
    outcome: "allow",
    reason:
      COMMIT_KINDS.has(kind)
        ? "Evidence refs resolve and confidence is not low"
        : "Escalate exempt from commit-kind evidence gate",
  });

  // 4. rate_limit_per_site — max N non-escalate actions per site per sweep
  const max =
    context.maxNonEscalateActionsPerSite ??
    assumptions.kredit.maxNonEscalateActionsPerSite;
  if (COMMIT_KINDS.has(kind) && context.nonEscalateCountThisSweep >= max) {
    decisions.push({
      policyId: "rate_limit_per_site",
      outcome: "deny",
      reason: `Rate limit: already ${context.nonEscalateCountThisSweep} non-escalate actions (max ${max})`,
    });
    return { status: "denied", decisions };
  }
  decisions.push({
    policyId: "rate_limit_per_site",
    outcome: "allow",
    reason: `Under rate limit (${context.nonEscalateCountThisSweep}/${max} non-escalate)`,
  });

  // 5. human_signature_required — non-escalate needs human signature later (I7)
  if (kind !== "escalate") {
    decisions.push({
      policyId: "human_signature_required",
      outcome: "require_approval",
      reason: `Kind '${kind}' requires human signature (sweep terminates at awaiting_approval)`,
    });
    return { status: "user-approval", decisions };
  }

  // 6. auto_class — escalate auto-approved under system:governor/auto principal
  decisions.push({
    policyId: "auto_class",
    outcome: "allow",
    reason: "Escalate is auto-class; approved under system:governor/auto",
  });
  return { status: "approved", decisions };
}

/**
 * Map a governor result to an AI SDK ToolApprovalStatus for toolApproval.
 * - denied → denied (feeds back into the ToolLoopAgent — demo beat)
 * - user-approval / approved → approved so the write tool may execute and
 *   record the ledger row (human signature is I7, not mid-loop)
 */
export function toToolApprovalStatus(result: GovernorResult): ToolApprovalStatus {
  if (result.status === "denied") {
    const last = result.decisions[result.decisions.length - 1];
    return {
      type: "denied",
      reason: last
        ? `${last.policyId}: ${last.reason}`
        : "denied_by_policy",
    };
  }
  // Let execute() run; it records awaiting_approval or auto-issues escalate.
  return { type: "approved", reason: `governor:${result.status}` };
}
