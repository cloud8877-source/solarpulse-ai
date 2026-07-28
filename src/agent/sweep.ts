// KREDIT sweep orchestration (I5).
// Pure orchestration callable from POST /api/agent/sweep and later cron.
// Offline: fully deterministic candidate → governor → service verbs.
// Live: ToolLoopAgent with read tools + commit_action/escalate; toolApproval → governor.

import { stepCountIs, ToolLoopAgent, type LanguageModel } from "ai";
import {
  evaluate,
  toToolApprovalStatus,
  type GovernorContext,
} from "./governor";
import { hasLiveCredentials, resolveModel } from "./solaropsAgent";
import type { ActionLedger } from "../data/ledger";
import {
  sweepId,
  type ActionCommitment,
  type ActionStatus,
  type SweepRun,
} from "../domain/actions";
import {
  createSolarOpsService,
  GOVERNOR_AUTO_PRINCIPAL,
  type ActionCandidate,
  type SolarOpsService,
} from "../services/solarops";
import { createActionTools } from "../tools/actions";
import { solaropsTools } from "../tools";

export type SweepMode = "offline" | "live" | "auto";

export interface RunSweepOptions {
  asOfDate?: string;
  now?: string;
  svc?: SolarOpsService;
  ledger?: ActionLedger;
  mode?: SweepMode;
  /** Injected model for live path (tests pass MockLanguageModelV4). */
  model?: LanguageModel;
  /** Cap live agent steps (default 12). */
  maxSteps?: number;
}

export interface SweepResult {
  sweep: SweepRun;
  actionIds: string[];
  mode: "offline" | "live";
  /** Per-site notes for debugging / demo. */
  siteSummaries: Array<{
    siteId: string;
    candidates: number;
    committed: number;
    blocked: number;
    notes: string[];
  }>;
}

/** Open (non-terminal) statuses — always dedupe against these. */
const OPEN_STATUSES: ReadonlySet<ActionStatus> = new Set([
  "proposed",
  "awaiting_approval",
  "approved",
  "issued",
]);

/**
 * Dedupe key: site + kind + deadline.
 * - Open rows (proposed/awaiting_approval/approved/issued) always block.
 * - denied_by_policy / expired block ONLY when their creation asOfDate equals
 *   the current sweep's asOfDate — so a transient data_issue denial on 06-21
 *   does not block load_shift for the rest of June once telemetry recovers.
 */
async function hasDuplicate(
  ledger: ActionLedger,
  siteId: string,
  kind: ActionCandidate["kind"],
  deadline: string,
  asOfDate: string,
): Promise<boolean> {
  const rows = await ledger.listActions({ siteId });
  return rows.some((r) => {
    if (r.kind !== kind || r.deadline !== deadline) return false;
    if (OPEN_STATUSES.has(r.status)) return true;
    if (r.status === "denied_by_policy" || r.status === "expired") {
      return r.createdAt.slice(0, 10) === asOfDate;
    }
    return false;
  });
}

async function recordCandidateOffline(
  svc: SolarOpsService,
  candidate: ActionCandidate,
  gov: ReturnType<typeof evaluate>,
  now: string,
): Promise<ActionCommitment> {
  const proposed = await svc.proposeAction({
    id: candidate.id,
    siteId: candidate.siteId,
    sweepId: candidate.sweepId,
    kind: candidate.kind,
    title: candidate.title,
    // Offline: deterministic description is the narrative (C5 offline path).
    description: candidate.description,
    rmImpact: candidate.rmImpact,
    kwhImpact: candidate.kwhImpact,
    confidence: candidate.confidence,
    evidenceRefs: candidate.evidenceRefs,
    deadline: candidate.deadline,
    approvalClass: candidate.approvalClass,
  });

  if (gov.status === "denied") {
    return svc.denyByPolicy(proposed.id, {
      policyDecisions: gov.decisions,
      decidedAt: now,
    });
  }

  const awaiting = await svc.requestApproval(proposed.id, {
    policyDecisions: gov.decisions,
  });

  if (gov.status === "user-approval") {
    return awaiting;
  }

  // approved (auto escalate): awaiting_approval → approved(system) → issued
  await svc.approveAction(proposed.id, {
    decidedBy: GOVERNOR_AUTO_PRINCIPAL,
    decidedAt: now,
    policyDecisions: gov.decisions,
  });
  return svc.issueAction(proposed.id);
}

/**
 * Seed non-escalate counter from ledger rows already committed this sweep+site
 * (I5-6). Count non-escalate, non-denied rows so rate_limit matches live-loop
 * accepts and cannot re-allow a rate-limited candidate at reconciliation.
 */
async function nonEscalateCommittedThisSweep(
  ledger: ActionLedger,
  siteId: string,
  sweepId: string,
): Promise<number> {
  const rows = await ledger.listActions({ siteId, sweepId });
  return rows.filter(
    (r) => r.kind !== "escalate" && r.status !== "denied_by_policy",
  ).length;
}

const SWEEP_INSTRUCTIONS = `You are the KREDIT credit-clock sweep agent for SolarPulse.

You NEVER invent action candidates. Candidates are listed in the user prompt with fixed ids.
Your only powers:
1. SELECT a candidate by id (commit_action) or escalate a site (escalate tool).
2. AUTHOR a grounded narrative (every RM / kWh figure must come from tool outputs or the candidate text).

WORKFLOW:
- For each site, call lookup_solar_site and detect_asset_underperformance as needed.
- For credit candidates (load_shift / reschedule_maintenance), call commit_action with the candidate_id and a grounded narrative.
- If commit_action is denied by policy, re-plan: call escalate for that site when an escalate candidate exists.
- For escalate candidates, call escalate with site_id, reason, and an evidence_ref from the candidate evidence list.
- Do not invent decidedBy, status, or verification fields.
- Stop when every site has been considered.`;

/**
 * Run a KREDIT sweep over all sites.
 * Offline = deterministic governor path (no LLM).
 * Live = ToolLoopAgent with toolApproval → governor; denied feeds back into the loop.
 * After the live loop (success or failure), reconciliation evaluates every
 * uncommitted candidate so denials land on the ledger (I5-2).
 */
export async function runSweep(opts: RunSweepOptions = {}): Promise<SweepResult> {
  // Ledger is explicit: never pulled off the service (I5-1 removed getLedger).
  const ledger =
    opts.ledger ?? (await import("../data/ledger")).getLedger();
  const svc =
    opts.svc ??
    createSolarOpsService(undefined, { ledger });

  const asOfDate = opts.asOfDate ?? svc.latestFixtureDate();
  const now = opts.now ?? `${asOfDate}T09:00:00+08:00`;
  const resolvedMode: "offline" | "live" =
    opts.mode === "live"
      ? "live"
      : opts.mode === "offline"
        ? "offline"
        : hasLiveCredentials()
          ? "live"
          : "offline";

  const sites = svc.listSites(asOfDate);
  const runId = sweepId(asOfDate);
  // Avoid colliding with an existing sweep id for the same day.
  const existing = await ledger.listSweeps();
  const sameDay = existing.filter((s) => s.asOfDate === asOfDate).length;
  const thisSweepId = sameDay === 0 ? runId : sweepId(asOfDate, sameDay + 1);

  const notes: string[] = [`mode=${resolvedMode}`, `as_of_date=${asOfDate}`];
  const actionIds: string[] = [];
  const siteSummaries: SweepResult["siteSummaries"] = [];
  let proposedActions = 0;
  let blockedActions = 0;

  // Shared candidate registry for live tools + offline.
  const candidatesById = new Map<string, ActionCandidate>();
  const candidatesBySite = new Map<string, ActionCandidate[]>();
  const decisionsById = new Map<string, ReturnType<typeof evaluate>["decisions"]>();
  const groundingOutputs: unknown[] = [];

  // Per-site: clock + detect + candidates + dedupe
  type SitePlan = {
    siteId: string;
    eligible: boolean;
    severity: string;
    candidates: ActionCandidate[];
    knownEvidence: string[];
    notes: string[];
  };
  const plans: SitePlan[] = [];

  for (const site of sites) {
    const siteId = site.site_id;
    const siteNotes: string[] = [];
    const clock = svc.atapCreditClock(siteId, asOfDate, now);
    const detect = svc.detectAssetUnderperformance(
      siteId,
      undefined,
      undefined,
      asOfDate,
    );
    groundingOutputs.push(clock, detect, site);

    if (!clock.eligibility.eligible) {
      siteNotes.push(
        `ineligible: ${clock.eligibility.reason ?? "ATAP cap"}`,
      );
      notes.push(`${siteId}: ineligible`);
    }

    let candidates = await svc.proposeCreditActionsDeterministic(siteId, asOfDate, {
      sweepId: thisSweepId,
      now,
    });
    // Stamp sweep id on all candidates.
    candidates = candidates.map((c) => ({ ...c, sweepId: thisSweepId }));

    // Dedupe: open rows always; denied/expired only same asOfDate (I5-3).
    const kept: ActionCandidate[] = [];
    for (const c of candidates) {
      if (await hasDuplicate(ledger, c.siteId, c.kind, c.deadline, asOfDate)) {
        siteNotes.push(`dedupe skip ${c.kind} deadline=${c.deadline}`);
        continue;
      }
      kept.push(c);
      candidatesById.set(c.id, c);
    }
    candidatesBySite.set(siteId, kept);

    if (kept.length === 0 && !clock.eligibility.eligible) {
      siteNotes.push("no credit actions (ineligible)");
    }

    plans.push({
      siteId,
      eligible: clock.eligibility.eligible,
      severity: detect.severity,
      candidates: kept,
      knownEvidence: [
        clock.source_manifest.runId,
        detect.anomaly_event_id,
      ],
      notes: siteNotes,
    });
  }

  if (resolvedMode === "offline") {
    for (const plan of plans) {
      let nonEscalate = 0;
      let committed = 0;
      let blocked = 0;
      for (const candidate of plan.candidates) {
        const gctx: GovernorContext = {
          siteEligible: plan.eligible,
          severity: plan.severity as GovernorContext["severity"],
          knownEvidenceRefs: plan.knownEvidence,
          nonEscalateCountThisSweep: nonEscalate,
        };
        const gov = evaluate(candidate, gctx);
        decisionsById.set(candidate.id, gov.decisions);
        const row = await recordCandidateOffline(svc, candidate, gov, now);
        actionIds.push(row.id);
        if (gov.status === "denied") {
          blocked += 1;
          blockedActions += 1;
          plan.notes.push(
            `${candidate.kind} DENIED (${gov.decisions[gov.decisions.length - 1]?.policyId})`,
          );
        } else {
          committed += 1;
          proposedActions += 1;
          if (candidate.kind !== "escalate") nonEscalate += 1;
          plan.notes.push(`${candidate.kind} → ${row.status}`);
        }
      }
      siteSummaries.push({
        siteId: plan.siteId,
        candidates: plan.candidates.length,
        committed,
        blocked,
        notes: plan.notes,
      });
    }
  } else {
    // LIVE path: ToolLoopAgent with toolApproval → governor.
    // toolApproval is persistence-free (I5-2): denials are written only by
    // reconciliation so a model retrying a denied candidate 3x creates 1 row.
    const actionTools = createActionTools({
      svc,
      getCandidate: (id) => candidatesById.get(id),
      getCandidatesForSite: (siteId) => candidatesBySite.get(siteId) ?? [],
      getDecisions: (id) => decisionsById.get(id),
      setDecisions: (id, d) => {
        decisionsById.set(id, d);
      },
      getGroundingOutputs: () => groundingOutputs,
      now,
    });

    // Per-site non-escalate counters for rate_limit during toolApproval.
    const nonEscalateBySite = new Map<string, number>();

    const model = opts.model ?? resolveModel();
    const agent = new ToolLoopAgent({
      model,
      instructions: SWEEP_INSTRUCTIONS,
      tools: {
        ...solaropsTools,
        ...actionTools,
      },
      toolApproval: async ({ toolCall }) => {
        if (toolCall.toolName !== "commit_action" && toolCall.toolName !== "escalate") {
          return "not-applicable";
        }
        const input = toolCall.input as Record<string, unknown>;
        let candidate: ActionCandidate | undefined;
        if (toolCall.toolName === "commit_action") {
          candidate = candidatesById.get(String(input.candidate_id ?? ""));
        } else {
          const siteId = String(input.site_id ?? "");
          candidate = (candidatesBySite.get(siteId) ?? []).find(
            (c) => c.kind === "escalate",
          );
        }
        if (!candidate) {
          return { type: "denied", reason: "unknown_candidate" };
        }
        const plan = plans.find((p) => p.siteId === candidate!.siteId);
        if (!plan) {
          return { type: "denied", reason: "unknown_site" };
        }
        const gctx: GovernorContext = {
          siteEligible: plan.eligible,
          severity: plan.severity as GovernorContext["severity"],
          knownEvidenceRefs: plan.knownEvidence,
          nonEscalateCountThisSweep: nonEscalateBySite.get(candidate.siteId) ?? 0,
        };
        const gov = evaluate(candidate, gctx);
        decisionsById.set(candidate.id, gov.decisions);
        if (gov.status !== "denied" && candidate.kind !== "escalate") {
          nonEscalateBySite.set(
            candidate.siteId,
            (nonEscalateBySite.get(candidate.siteId) ?? 0) + 1,
          );
        }
        return toToolApprovalStatus(gov);
      },
      stopWhen: stepCountIs(opts.maxSteps ?? 12),
    });

    const candidateListing = plans
      .map((p) => {
        const lines = p.candidates.map(
          (c) =>
            `  - id=${c.id} kind=${c.kind} rmImpact=${c.rmImpact} deadline=${c.deadline} evidence=${c.evidenceRefs.join("|")}\n    desc: ${c.description}`,
        );
        return `Site ${p.siteId} (eligible=${p.eligible}, severity=${p.severity}):\n${lines.join("\n") || "  (no candidates)"}`;
      })
      .join("\n\n");

    const prompt =
      `Run the KREDIT sweep for as_of_date=${asOfDate}.\n\n` +
      `Candidates (deterministic; select by id only):\n\n${candidateListing}\n\n` +
      `Commit credit candidates with commit_action. If denied, escalate the site. ` +
      `Use only figures present in tool outputs or candidate descriptions.`;

    try {
      const result = await agent.generate({ prompt });
      // Collect action ids from successful write tool results.
      for (const tr of result.toolResults ?? []) {
        const name = tr.toolName;
        if (name === "commit_action" || name === "escalate") {
          const out = tr.output as { action_id?: string; status?: string } | undefined;
          if (out?.action_id) {
            actionIds.push(out.action_id);
            if (out.status === "denied_by_policy") {
              blockedActions += 1;
            } else {
              proposedActions += 1;
            }
          }
        }
      }
      // Also scan ledger for this sweep in case the agent path missed counts.
      const sweepRows = await ledger.listActions({ sweepId: thisSweepId });
      for (const r of sweepRows) {
        if (!actionIds.includes(r.id)) actionIds.push(r.id);
      }
      proposedActions = sweepRows.filter((r) => r.status !== "denied_by_policy").length;
      blockedActions = sweepRows.filter((r) => r.status === "denied_by_policy").length;
      notes.push(`live_steps=${result.steps?.length ?? 0}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notes.push(`live_agent_failed: ${message}`);
    }

    // I5-2 + I5-6: reconciliation runs UNCONDITIONALLY after the live loop
    // (success or failure). Single writer for denials — every refusal on record,
    // including candidates the model never attempted. Seed nonEscalate from the
    // ledger so in-loop rate_limit denials cannot be re-allowed here.
    notes.push("reconcile=governor_for_uncommitted");
    for (const plan of plans) {
      let nonEscalate = await nonEscalateCommittedThisSweep(
        ledger,
        plan.siteId,
        thisSweepId,
      );
      // I5-7: already-written skip is keyed by (siteId, kind, deadline) within
      // this sweep — not candidate.id. C4 retries can reallocate ids, so an
      // id lookup would miss a row the live loop already committed.
      const writtenThisSweep = await ledger.listActions({
        siteId: plan.siteId,
        sweepId: thisSweepId,
      });
      for (const candidate of plan.candidates) {
        const alreadyWritten = writtenThisSweep.some(
          (r) => r.kind === candidate.kind && r.deadline === candidate.deadline,
        );
        if (alreadyWritten) continue;
        const gctx: GovernorContext = {
          siteEligible: plan.eligible,
          severity: plan.severity as GovernorContext["severity"],
          knownEvidenceRefs: plan.knownEvidence,
          nonEscalateCountThisSweep: nonEscalate,
        };
        const gov = evaluate(candidate, gctx);
        decisionsById.set(candidate.id, gov.decisions);
        const row = await recordCandidateOffline(svc, candidate, gov, now);
        writtenThisSweep.push(row);
        actionIds.push(row.id);
        if (gov.status === "denied") {
          blockedActions += 1;
          plan.notes.push(
            `${candidate.kind} DENIED (${gov.decisions[gov.decisions.length - 1]?.policyId})`,
          );
        } else {
          proposedActions += 1;
          if (candidate.kind !== "escalate") nonEscalate += 1;
          plan.notes.push(`${candidate.kind} → ${row.status}`);
        }
      }
    }

    for (const plan of plans) {
      const rows = (await ledger.listActions({ sweepId: thisSweepId })).filter(
        (r) => r.siteId === plan.siteId,
      );
      siteSummaries.push({
        siteId: plan.siteId,
        candidates: plan.candidates.length,
        committed: rows.filter((r) => r.status !== "denied_by_policy").length,
        blocked: rows.filter((r) => r.status === "denied_by_policy").length,
        notes: plan.notes,
      });
    }
  }

  // Recompute proposed/blocked from ledger for this sweep (authoritative).
  const finalRows = await ledger.listActions({ sweepId: thisSweepId });
  proposedActions = finalRows.filter((r) => r.status !== "denied_by_policy").length;
  blockedActions = finalRows.filter((r) => r.status === "denied_by_policy").length;
  const finalIds = finalRows.map((r) => r.id);

  const sweep: SweepRun = {
    id: thisSweepId,
    asOfDate,
    startedAt: now,
    siteCount: sites.length,
    proposedActions,
    blockedActions,
    notes,
  };
  await ledger.saveSweep(sweep);

  return {
    sweep,
    actionIds: finalIds,
    mode: resolvedMode,
    siteSummaries,
  };
}
