// KREDIT write tools (I5). Exactly two write tools; NO decidedBy anywhere (C2).
// Execute delegates to service verbs only — never holds a raw ledger.
//
// I6: No verify tool is exposed in this increment. If a future increment adds
// one, its schema MUST exclude outcome / measuredRm — the model must never
// author grades (grades are permanent, engine-derived only).

import { tool } from "ai";
import { z } from "zod";
import { validateAnswer } from "../agent/safety";
import {
  GOVERNOR_AUTO_PRINCIPAL,
  SolarOpsError,
  type ActionCandidate,
  type ActionVerbs,
} from "../services/solarops";
import type { PolicyDecision } from "../domain/actions";

/** Zod input schema for commit_action — exported for CE7-(c) schema-key asserts. */
export const commitActionInputSchema = z.object({
  site_id: z.string().describe("Site id the candidate belongs to"),
  candidate_id: z
    .string()
    .describe("Deterministic candidate id from proposeCreditActionsDeterministic"),
  narrative: z
    .string()
    .describe(
      "Operator-facing narrative. Must be grounded in this turn's tool outputs; ungrounded text is replaced by the candidate description.",
    ),
});

/** Zod input schema for escalate — exported for CE7-(c) schema-key asserts. */
export const escalateInputSchema = z.object({
  site_id: z.string().describe("Site id to escalate"),
  reason: z.string().describe("Why escalation is needed (operator-facing)"),
  evidence_ref: z
    .string()
    .describe("Evidence reference (anomaly_event_id or credit-clock runId)"),
});

export interface ActionToolContext {
  /** Narrow action verbs only — never a raw ledger (I5-1 / C2). */
  svc: ActionVerbs;
  /** Lookup a pre-generated deterministic candidate by id. */
  getCandidate: (id: string) => ActionCandidate | undefined;
  /** All candidates for a site (used by escalate to select the escalate candidate). */
  getCandidatesForSite: (siteId: string) => ActionCandidate[];
  /** Governor decisions for a candidate id (set by toolApproval / offline path). */
  getDecisions: (candidateId: string) => PolicyDecision[] | undefined;
  setDecisions: (candidateId: string, decisions: PolicyDecision[]) => void;
  /**
   * Tool outputs from this turn for validateAnswer grounding (C5).
   * Offline path may pass the candidate description pool itself.
   */
  getGroundingOutputs: () => unknown[];
  /** Optional ISO now for decidedAt on auto path. */
  now?: string;
}

function groundNarrative(
  narrative: string,
  fallback: string,
  groundingOutputs: unknown[],
): { narrative: string; adjusted: boolean } {
  const safety = validateAnswer(narrative, groundingOutputs);
  if (safety.ok) return { narrative, adjusted: false };
  // Replace-not-negotiate (mirrors enforceGrounding).
  return { narrative: fallback, adjusted: true };
}

export function createActionTools(ctx: ActionToolContext) {
  const commit_action = tool({
    description:
      "Commit a pre-generated credit action candidate (load_shift or reschedule_maintenance) " +
      "by id. Authors the operator narrative only — never invents candidates, decidedBy, " +
      "status, or verification. Lands in awaiting_approval for human signature (I7).",
    inputSchema: commitActionInputSchema,
    outputSchema: z.object({
      action_id: z.string(),
      status: z.string(),
      kind: z.string(),
      narrative_adjusted: z.boolean(),
      rm_impact: z.number().nullable(),
    }),
    execute: async ({ site_id, candidate_id, narrative }) => {
      const candidate = ctx.getCandidate(candidate_id);
      if (!candidate) {
        throw new SolarOpsError(
          "action_not_found",
          `Unknown candidate_id '${candidate_id}'`,
        );
      }
      if (candidate.siteId !== site_id) {
        throw new SolarOpsError(
          "illegal_field",
          `candidate_id '${candidate_id}' belongs to site '${candidate.siteId}', not '${site_id}'`,
        );
      }
      if (candidate.kind === "escalate") {
        throw new SolarOpsError(
          "illegal_field",
          "Use escalate tool for escalate candidates; commit_action is for credit kinds only",
        );
      }

      const grounded = groundNarrative(
        narrative,
        candidate.description,
        ctx.getGroundingOutputs(),
      );

      const decisions = ctx.getDecisions(candidate_id) ?? [];
      const proposed = await ctx.svc.proposeAction({
        id: candidate.id,
        siteId: candidate.siteId,
        sweepId: candidate.sweepId,
        kind: candidate.kind,
        title: candidate.title,
        description: grounded.narrative,
        rmImpact: candidate.rmImpact,
        kwhImpact: candidate.kwhImpact,
        confidence: candidate.confidence,
        evidenceRefs: candidate.evidenceRefs,
        deadline: candidate.deadline,
        approvalClass: candidate.approvalClass,
      });
      const awaiting = await ctx.svc.requestApproval(proposed.id, {
        policyDecisions: decisions,
      });
      return {
        action_id: awaiting.id,
        status: awaiting.status,
        kind: awaiting.kind,
        narrative_adjusted: grounded.adjusted,
        rm_impact: awaiting.rmImpact,
      };
    },
  });

  const escalate = tool({
    description:
      "Escalate a site for operator review using the pre-generated escalate candidate. " +
      "Auto-class: governor approves under system:governor/auto and issues immediately. " +
      "Never accepts decidedBy.",
    inputSchema: escalateInputSchema,
    outputSchema: z.object({
      action_id: z.string(),
      status: z.string(),
      kind: z.literal("escalate"),
      decided_by: z.string().nullable(),
      narrative_adjusted: z.boolean(),
    }),
    execute: async ({ site_id, reason, evidence_ref }) => {
      const candidates = ctx.getCandidatesForSite(site_id);
      const candidate =
        candidates.find((c) => c.kind === "escalate") ??
        ctx.getCandidate(evidence_ref); // allow evidence_ref to be the candidate id
      const esc =
        candidate?.kind === "escalate"
          ? candidate
          : candidates.find((c) => c.kind === "escalate");
      if (!esc) {
        throw new SolarOpsError(
          "action_not_found",
          `No escalate candidate for site '${site_id}'`,
        );
      }

      // Ground reason against tool outputs; fall back to deterministic description.
      const narrativeText = `${reason} (evidence: ${evidence_ref})`;
      const grounded = groundNarrative(
        narrativeText,
        esc.description,
        ctx.getGroundingOutputs(),
      );

      const decisions = ctx.getDecisions(esc.id) ?? [];
      const proposed = await ctx.svc.proposeAction({
        id: esc.id,
        siteId: esc.siteId,
        sweepId: esc.sweepId,
        kind: "escalate",
        title: esc.title,
        description: grounded.narrative,
        rmImpact: esc.rmImpact,
        kwhImpact: esc.kwhImpact,
        confidence: esc.confidence,
        evidenceRefs: esc.evidenceRefs.includes(evidence_ref)
          ? esc.evidenceRefs
          : [...esc.evidenceRefs, evidence_ref],
        deadline: esc.deadline,
        approvalClass: "auto",
      });
      await ctx.svc.requestApproval(proposed.id, { policyDecisions: decisions });
      const decidedAt = ctx.now ?? `${esc.deadline.slice(0, 10)}T08:30:00+08:00`;
      await ctx.svc.approveAction(proposed.id, {
        decidedBy: GOVERNOR_AUTO_PRINCIPAL,
        decidedAt,
        policyDecisions: decisions,
      });
      const issued = await ctx.svc.issueAction(proposed.id);
      return {
        action_id: issued.id,
        status: issued.status,
        kind: "escalate" as const,
        decided_by: issued.decidedBy,
        narrative_adjusted: grounded.adjusted,
      };
    },
  });

  return { commit_action, escalate };
}

export type ActionTools = ReturnType<typeof createActionTools>;
