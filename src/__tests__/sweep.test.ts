/**
 * KREDIT sweep + action tools + CE7 binding-contract tests (I5).
 *
 * Offline end-to-end on fixtures:
 *  - site_a → load_shift awaiting_approval, rmImpact = smp_spread_rm (pinned)
 *  - site_c data_issue → load_shift DENIED (no_action_on_bad_data) + escalate issued
 *    with decidedBy system:governor/auto
 *  - site_b → no credit actions; notes say ineligible
 *  - second sweep same day → zero new rows
 *
 * CE7 through tool surface:
 *  - (a) decidedBy on payload → illegal_field; issued only via auto escalate
 *  - (b) verifyAction re-grade → verification_already_set / ledger_error
 *  - (c) decidedBy absent from both tool schemas
 * C4 retry on already_exists
 * Live-loop mock: denied commit_action then escalate (MockLanguageModelV4)
 */
import { describe, expect, it } from "vitest";
import { ToolLoopAgent, stepCountIs } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { evaluate } from "../agent/governor";
import { runSweep } from "../agent/sweep";
import { InMemoryLedger } from "../data/ledger";
import { InMemoryStore } from "../data/store";
import { actionId } from "../domain/actions";
import {
  createSolarOpsService,
  GOVERNOR_AUTO_PRINCIPAL,
  SolarOpsError,
  type ActionCandidate,
} from "../services/solarops";
import {
  commitActionInputSchema,
  createActionTools,
  escalateInputSchema,
} from "../tools/actions";

const AS_OF = "2026-06-21";
const NOW = "2026-06-21T09:00:00+08:00";

// site_a smp_spread_rm pin (from atap.test F15 / integration):
// load_shiftable 5241.15 × 0.3175 = 1664.07
const SITE_A_RM_IMPACT = 1664.07;

function fresh() {
  const store = new InMemoryStore();
  const ledger = new InMemoryLedger();
  const svc = createSolarOpsService(store, { ledger });
  return { store, ledger, svc };
}

function schemaKeys(schema: z.ZodObject<z.ZodRawShape>): string[] {
  return Object.keys(schema.shape);
}

describe("KREDIT offline runSweep end-to-end (fixtures)", () => {
  it("site_a load_shift → awaiting_approval with pinned rmImpact", async () => {
    const { svc, ledger } = fresh();
    const result = await runSweep({
      svc,
      ledger,
      asOfDate: AS_OF,
      now: NOW,
      mode: "offline",
    });
    expect(result.mode).toBe("offline");

    const siteA = (await ledger.listActions({ siteId: "site_a" })).filter(
      (a) => a.sweepId === result.sweep.id,
    );
    const loadShift = siteA.find((a) => a.kind === "load_shift");
    expect(loadShift).toBeDefined();
    expect(loadShift!.status).toBe("awaiting_approval");
    // Recompute comment: load_shiftable_export_kwh(5241.15) × (0.5068−0.1893=0.3175) = 1664.07
    expect(loadShift!.rmImpact).toBe(SITE_A_RM_IMPACT);
    expect(loadShift!.decidedBy).toBeNull();
    expect(loadShift!.verification).toBeNull();
  });

  it("site_c data_issue: load_shift DENIED (no_action_on_bad_data) + escalate issued auto", async () => {
    const { svc, ledger } = fresh();
    const result = await runSweep({
      svc,
      ledger,
      asOfDate: AS_OF,
      now: NOW,
      mode: "offline",
    });

    const siteC = (await ledger.listActions({ siteId: "site_c" })).filter(
      (a) => a.sweepId === result.sweep.id,
    );
    const loadShift = siteC.find((a) => a.kind === "load_shift");
    expect(loadShift).toBeDefined();
    expect(loadShift!.status).toBe("denied_by_policy");
    expect(
      loadShift!.policyDecisions.some(
        (d) => d.policyId === "no_action_on_bad_data" && d.outcome === "deny",
      ),
    ).toBe(true);

    const esc = siteC.find((a) => a.kind === "escalate");
    expect(esc).toBeDefined();
    expect(esc!.status).toBe("issued");
    expect(esc!.decidedBy).toBe(GOVERNOR_AUTO_PRINCIPAL);
    expect(esc!.verification).toBeNull();
  });

  it("site_b: no credit actions; sweep notes say ineligible", async () => {
    const { svc, ledger } = fresh();
    const result = await runSweep({
      svc,
      ledger,
      asOfDate: AS_OF,
      now: NOW,
      mode: "offline",
    });

    const siteB = (await ledger.listActions({ siteId: "site_b" })).filter(
      (a) => a.sweepId === result.sweep.id,
    );
    const credit = siteB.filter(
      (a) => a.kind === "load_shift" || a.kind === "reschedule_maintenance",
    );
    expect(credit).toHaveLength(0);

    const summary = result.siteSummaries.find((s) => s.siteId === "site_b");
    expect(summary).toBeDefined();
    expect(summary!.notes.some((n) => /ineligible/i.test(n))).toBe(true);
    expect(result.sweep.notes.some((n) => /site_b.*ineligible/i.test(n))).toBe(true);

    // ineligible + anomalous → escalate candidate (not a "credit action")
    const esc = siteB.find((a) => a.kind === "escalate");
    expect(esc).toBeDefined();
    expect(esc!.status).toBe("issued");
    expect(esc!.decidedBy).toBe(GOVERNOR_AUTO_PRINCIPAL);
  });

  it("dedupe: second sweep same day creates zero new rows", async () => {
    const { svc, ledger } = fresh();
    const first = await runSweep({
      svc,
      ledger,
      asOfDate: AS_OF,
      now: NOW,
      mode: "offline",
    });
    const countAfterFirst = (await ledger.listActions()).length;

    const second = await runSweep({
      svc,
      ledger,
      asOfDate: AS_OF,
      now: NOW,
      mode: "offline",
    });
    const countAfterSecond = (await ledger.listActions()).length;

    expect(countAfterSecond).toBe(countAfterFirst);
    expect(second.actionIds).toHaveLength(0);
    expect(second.sweep.proposedActions).toBe(0);
    expect(second.sweep.blockedActions).toBe(0);
    // first sweep did create rows
    expect(first.actionIds.length).toBeGreaterThan(0);
  });

  it("prints offline sweep results for all 3 sites (status + policy + rm)", async () => {
    const { svc, ledger } = fresh();
    await runSweep({ svc, ledger, asOfDate: AS_OF, now: NOW, mode: "offline" });
    const rows = await ledger.listActions();
    // Filter out nothing — fresh ledger has no seed
    const bySite: Record<string, Array<{ kind: string; status: string; policies: string[]; rm: number | null }>> = {};
    for (const r of rows) {
      (bySite[r.siteId] ??= []).push({
        kind: r.kind,
        status: r.status,
        policies: r.policyDecisions.filter((d) => d.outcome === "deny" || d.outcome === "require_approval").map((d) => d.policyId),
        rm: r.rmImpact,
      });
    }
    // Stable snapshot for the acceptance printout in the agent response.
    expect(bySite.site_a).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "load_shift",
          status: "awaiting_approval",
          rm: SITE_A_RM_IMPACT,
        }),
      ]),
    );
    expect(bySite.site_c).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "load_shift",
          status: "denied_by_policy",
          policies: expect.arrayContaining(["no_action_on_bad_data"]),
        }),
        expect.objectContaining({
          kind: "escalate",
          status: "issued",
        }),
      ]),
    );
    expect(bySite.site_b?.every((r) => r.kind !== "load_shift")).toBe(true);
  });
});

describe("C4 proposeAction already_exists retry", () => {
  it("retries with fresh nextSeq when preferred id collides", async () => {
    const { svc, ledger } = fresh();
    const day = AS_OF;
    const colliding = actionId("site_a", day, 1);
    // Pre-insert a colliding proposed-shaped row via public path with a different sweep.
    await svc.proposeAction({
      id: colliding,
      siteId: "site_a",
      sweepId: "swp_pre",
      kind: "load_shift",
      title: "pre",
      description: "pre-inserted collision fixture",
      rmImpact: 1,
      kwhImpact: 1,
      confidence: "medium",
      evidenceRefs: ["pre"],
      deadline: "2026-06-30",
      approvalClass: "human_signature",
      createdAt: NOW,
    });

    const saved = await svc.proposeAction({
      id: colliding, // same preferred id → already_exists → retry
      siteId: "site_a",
      sweepId: "swp_retry",
      kind: "load_shift",
      title: "retry",
      description: "should land on next seq",
      rmImpact: 2,
      kwhImpact: 2,
      confidence: "medium",
      evidenceRefs: ["retry"],
      deadline: "2026-06-30",
      approvalClass: "human_signature",
      createdAt: NOW,
    });

    expect(saved.id).not.toBe(colliding);
    expect(saved.id).toBe(actionId("site_a", day, 2));
    expect(await ledger.getAction(colliding)).not.toBeNull();
    expect(await ledger.getAction(saved.id)).not.toBeNull();
  });
});

describe("CE7 tool surface + service verbs", () => {
  function toolCtx(svc: ReturnType<typeof createSolarOpsService>, candidates: ActionCandidate[]) {
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const decisions = new Map<string, ReturnType<typeof evaluate>["decisions"]>();
    return createActionTools({
      svc,
      getCandidate: (id) => byId.get(id),
      getCandidatesForSite: (siteId) => candidates.filter((c) => c.siteId === siteId),
      getDecisions: (id) => decisions.get(id),
      setDecisions: (id, d) => {
        decisions.set(id, d);
      },
      getGroundingOutputs: () =>
        candidates.map((c) => ({
          description: c.description,
          rm_impact: c.rmImpact,
          kwh_impact: c.kwhImpact,
        })),
      now: NOW,
    });
  }

  it("CE7-(a): payload carrying decidedBy → illegal_field on proposeAction", async () => {
    const { svc } = fresh();
    await expect(
      svc.proposeAction({
        siteId: "site_a",
        sweepId: "swp_x",
        kind: "load_shift",
        title: "x",
        description: "x",
        rmImpact: 1,
        kwhImpact: 1,
        confidence: "medium",
        evidenceRefs: ["e"],
        deadline: "2026-06-30",
        approvalClass: "human_signature",
        // @ts-expect-error intentional adversarial field
        decidedBy: "attacker",
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(SolarOpsError);
      expect((err as SolarOpsError).code).toBe("illegal_field");
      return true;
    });
  });

  it("CE7-(a): no tool-call sequence reaches issued without approveAction (except auto escalate)", async () => {
    const { svc, ledger } = fresh();
    const candidates = await svc.proposeCreditActionsDeterministic("site_a", AS_OF, {
      sweepId: "swp_ce7a",
      now: NOW,
    });
    const load = candidates.find((c) => c.kind === "load_shift");
    expect(load).toBeDefined();

    const tools = toolCtx(svc, candidates);
    // Drive commit_action execute directly — lands awaiting_approval, never issued.
    const exec = tools.commit_action.execute;
    expect(exec).toBeTypeOf("function");
    const raw = await exec!(
      {
        site_id: "site_a",
        candidate_id: load!.id,
        narrative: load!.description, // grounded in candidate pool
      },
      { toolCallId: "t1", messages: [] } as never,
    );
    const out = raw as {
      action_id: string;
      status: string;
      kind: string;
      narrative_adjusted: boolean;
      rm_impact: number | null;
    };
    expect(out.status).toBe("awaiting_approval");

    const row = await ledger.getAction(load!.id);
    expect(row!.status).toBe("awaiting_approval");
    expect(row!.decidedBy).toBeNull();

    // The only way to issued is approveAction (human/system) then issueAction.
    await svc.approveAction(load!.id, { decidedBy: "human_operator", decidedAt: NOW });
    const issued = await svc.issueAction(load!.id);
    expect(issued.status).toBe("issued");
    expect(issued.decidedBy).toBe("human_operator");
  });

  it("CE7-(a): auto-escalate is the only issued path with system principal from tools", async () => {
    const { svc, ledger } = fresh();
    const candidates = await svc.proposeCreditActionsDeterministic("site_c", AS_OF, {
      sweepId: "swp_ce7a2",
      now: NOW,
    });
    const esc = candidates.find((c) => c.kind === "escalate");
    expect(esc).toBeDefined();
    const tools = toolCtx(svc, candidates);
    const raw = await tools.escalate.execute!(
      {
        site_id: "site_c",
        reason: "data quality blocks credit actions",
        evidence_ref: esc!.evidenceRefs[0]!,
      },
      { toolCallId: "t2", messages: [] } as never,
    );
    const out = raw as {
      action_id: string;
      status: string;
      kind: "escalate";
      decided_by: string | null;
      narrative_adjusted: boolean;
    };
    expect(out.status).toBe("issued");
    expect(out.decided_by).toBe(GOVERNOR_AUTO_PRINCIPAL);
    const row = await ledger.getAction(out.action_id);
    expect(row!.decidedBy).toBe(GOVERNOR_AUTO_PRINCIPAL);
  });

  it("CE7-(b): verifyAction on a graded row → verification_already_set (ledger_error)", async () => {
    const { svc } = fresh();
    // Walk a row to issued + grade, then re-grade.
    const proposed = await svc.proposeAction({
      siteId: "site_a",
      sweepId: "swp_ver",
      kind: "load_shift",
      title: "v",
      description: "verify test",
      rmImpact: 10,
      kwhImpact: 40,
      confidence: "medium",
      evidenceRefs: ["e"],
      deadline: "2026-06-30",
      approvalClass: "human_signature",
      createdAt: NOW,
    });
    await svc.requestApproval(proposed.id);
    await svc.approveAction(proposed.id, { decidedBy: "alice", decidedAt: NOW });
    await svc.issueAction(proposed.id);
    await svc.verifyAction(proposed.id, {
      outcome: "verified",
      measuredRm: 9,
      note: "first grade",
      verifiedAt: NOW,
    });
    await expect(
      svc.verifyAction(proposed.id, {
        outcome: "falsified",
        measuredRm: 0,
        note: "re-grade attack",
        verifiedAt: NOW,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(SolarOpsError);
      expect((err as SolarOpsError).code).toBe("ledger_error");
      expect((err as SolarOpsError).message).toMatch(/verification_already_set|already set/i);
      return true;
    });
  });

  it("CE7-(c): decidedBy absent from both tool schemas", () => {
    expect(schemaKeys(commitActionInputSchema)).toEqual([
      "site_id",
      "candidate_id",
      "narrative",
    ]);
    expect(schemaKeys(escalateInputSchema)).toEqual([
      "site_id",
      "reason",
      "evidence_ref",
    ]);
    expect(schemaKeys(commitActionInputSchema)).not.toContain("decidedBy");
    expect(schemaKeys(escalateInputSchema)).not.toContain("decidedBy");
    // Also ensure the shape JSON has no decidedBy substring in keys.
    const commitJson = JSON.stringify(commitActionInputSchema.shape);
    const escJson = JSON.stringify(escalateInputSchema.shape);
    expect(commitJson.toLowerCase()).not.toContain("decidedby");
    expect(escJson.toLowerCase()).not.toContain("decidedby");
  });
});

describe("live-loop mock: denied feeds back then escalate", () => {
  it("MockLanguageModelV4: commit_action denied → agent calls escalate", async () => {
    const { svc, ledger } = fresh();
    // Build site_c candidates (load_shift will be governor-denied on data_issue).
    const candidates = await svc.proposeCreditActionsDeterministic("site_c", AS_OF, {
      sweepId: "swp_live",
      now: NOW,
    });
    const load = candidates.find((c) => c.kind === "load_shift");
    const esc = candidates.find((c) => c.kind === "escalate");
    expect(load).toBeDefined();
    expect(esc).toBeDefined();

    const clock = svc.atapCreditClock("site_c", AS_OF, NOW);
    const detect = svc.detectAssetUnderperformance("site_c", undefined, undefined, AS_OF);
    const known = [clock.source_manifest.runId, detect.anomaly_event_id];
    const decisions = new Map<string, ReturnType<typeof evaluate>["decisions"]>();
    const tools = createActionTools({
      svc,
      getCandidate: (id) => candidates.find((c) => c.id === id),
      getCandidatesForSite: (siteId) => candidates.filter((c) => c.siteId === siteId),
      getDecisions: (id) => decisions.get(id),
      setDecisions: (id, d) => {
        decisions.set(id, d);
      },
      getGroundingOutputs: () => [clock, detect, ...candidates],
      now: NOW,
    });

    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "commit_action",
                input: JSON.stringify({
                  site_id: "site_c",
                  candidate_id: load!.id,
                  narrative: load!.description,
                }),
              },
            ],
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
            warnings: [],
          };
        }
        if (calls === 2) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "c2",
                toolName: "escalate",
                input: JSON.stringify({
                  site_id: "site_c",
                  reason: "data_issue blocks load_shift",
                  evidence_ref: esc!.evidenceRefs[0]!,
                }),
              },
            ],
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: "sweep complete" }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });

    const agent = new ToolLoopAgent({
      model,
      tools,
      toolApproval: async ({ toolCall }) => {
        const input = toolCall.input as Record<string, unknown>;
        let cand: ActionCandidate | undefined;
        if (toolCall.toolName === "commit_action") {
          cand = candidates.find((c) => c.id === input.candidate_id);
        } else if (toolCall.toolName === "escalate") {
          cand = esc;
        }
        if (!cand) return { type: "denied", reason: "unknown" };
        const gov = evaluate(cand, {
          siteEligible: true,
          severity: "data_issue",
          knownEvidenceRefs: known,
          nonEscalateCountThisSweep: 0,
        });
        decisions.set(cand.id, gov.decisions);
        if (gov.status === "denied") {
          // Mirror offline: still record denied row so the beat is durable.
          // (toolApproval deny means execute does not run — record here for parity
          //  with offline path; live runSweep offline-fallback also covers this.)
          return {
            type: "denied",
            reason: gov.decisions.at(-1)?.policyId ?? "denied",
          };
        }
        return { type: "approved", reason: gov.status };
      },
      stopWhen: stepCountIs(5),
    });

    const result = await agent.generate({ prompt: "run site_c sweep" });
    expect(calls).toBeGreaterThanOrEqual(2);
    // escalate executed after deny
    const escResult = (result.toolResults ?? []).find((t) => t.toolName === "escalate");
    expect(escResult).toBeDefined();
    const out = escResult!.output as { status: string; decided_by: string };
    expect(out.status).toBe("issued");
    expect(out.decided_by).toBe(GOVERNOR_AUTO_PRINCIPAL);

    // commit_action must NOT have executed (denied by toolApproval)
    const loadRow = await ledger.getAction(load!.id);
    expect(loadRow).toBeNull();

    const escRow = await ledger.getAction(esc!.id);
    expect(escRow?.status).toBe("issued");
  });
});

describe("proposeCreditActionsDeterministic honesty", () => {
  it("every load_shift number traces to the ATAP DTO", async () => {
    const { svc } = fresh();
    const clock = svc.atapCreditClock("site_a", AS_OF);
    const cands = await svc.proposeCreditActionsDeterministic("site_a", AS_OF, {
      sweepId: "swp_h",
      now: NOW,
    });
    const load = cands.find((c) => c.kind === "load_shift");
    expect(load).toBeDefined();
    expect(load!.rmImpact).toBe(clock.value_leak!.smp_spread_rm);
    expect(load!.kwhImpact).toBe(clock.projection!.load_shiftable_export_kwh);
    expect(load!.deadline).toBe(clock.coverage.period_end);
    expect(load!.description).toContain(String(clock.projection!.load_shiftable_export_kwh));
    expect(load!.description).toContain(String(clock.value_leak!.smp_spread_rm));
    expect(load!.evidenceRefs).toContain(clock.source_manifest.runId);
  });
});
