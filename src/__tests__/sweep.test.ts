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
 * Live-loop mock: denied commit_action then escalate (MockLanguageModelV4);
 *   reconciliation records the durable denied row (I5-2 / I5-5)
 * I5-1: tool context must not expose getLedger
 * I5-3: denied/expired dedupe only same asOfDate
 * I5-4: C4 exhaustion message contains date string
 */
import { describe, expect, it } from "vitest";
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
  type ActionVerbs,
} from "../services/solarops";
import {
  commitActionInputSchema,
  createActionTools,
  escalateInputSchema,
  type ActionToolContext,
} from "../tools/actions";

const AS_OF = "2026-06-21";
const NOW = "2026-06-21T09:00:00+08:00";
/**
 * Clean-data day for site_c: healthy + medium confidence (obs≥2).
 * 06-18 is healthy but confidence=low (1 observed day) → evidence_required deny.
 */
const CLEAN_DAY = "2026-06-19";
const CLEAN_NOW = "2026-06-19T09:00:00+08:00";

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

  it("I5-3: denied_by_policy dedupes only same asOfDate — clean day recovers load_shift", async () => {
    const { svc, ledger } = fresh();

    // Day with data_issue: site_c load_shift denied (deadline = period end).
    const deniedRun = await runSweep({
      svc,
      ledger,
      asOfDate: AS_OF,
      now: NOW,
      mode: "offline",
    });
    const denied = (await ledger.listActions({ siteId: "site_c" })).find(
      (a) =>
        a.sweepId === deniedRun.sweep.id &&
        a.kind === "load_shift" &&
        a.status === "denied_by_policy",
    );
    expect(denied).toBeDefined();
    expect(denied!.createdAt.slice(0, 10)).toBe(AS_OF);
    const deadline = denied!.deadline;
    const countAfterDeny = (await ledger.listActions()).length;

    // Same day again → still zero new rows (denied still blocks same asOfDate).
    const sameDay = await runSweep({
      svc,
      ledger,
      asOfDate: AS_OF,
      now: NOW,
      mode: "offline",
    });
    expect((await ledger.listActions()).length).toBe(countAfterDeny);
    expect(sameDay.actionIds).toHaveLength(0);

    // Clean-data day (healthy site_c): prior denial must NOT block load_shift.
    const recovered = await runSweep({
      svc,
      ledger,
      asOfDate: CLEAN_DAY,
      now: CLEAN_NOW,
      mode: "offline",
    });
    const freshLoad = (await ledger.listActions({ siteId: "site_c" })).find(
      (a) =>
        a.sweepId === recovered.sweep.id &&
        a.kind === "load_shift" &&
        a.deadline === deadline,
    );
    expect(freshLoad).toBeDefined();
    expect(freshLoad!.status).toBe("awaiting_approval");
    expect(freshLoad!.id).not.toBe(denied!.id);
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

  it("I5-4: C4 exhaustion error message contains the date string (not Function)", async () => {
    const { svc, ledger } = fresh();
    const day = AS_OF;
    const colliding = actionId("site_a", day, 1);
    await svc.proposeAction({
      id: colliding,
      siteId: "site_a",
      sweepId: "swp_exh",
      kind: "load_shift",
      title: "pre",
      description: "seed for exhaustion",
      rmImpact: 1,
      kwhImpact: 1,
      confidence: "medium",
      evidenceRefs: ["pre"],
      deadline: "2026-06-30",
      approvalClass: "human_signature",
      createdAt: NOW,
    });
    // Force every retry onto the same colliding id so maxRetries exhausts.
    ledger.nextSeq = async () => 1;

    let caught: unknown;
    try {
      await svc.proposeAction({
        id: colliding,
        siteId: "site_a",
        sweepId: "swp_exh2",
        kind: "load_shift",
        title: "will fail",
        description: "exhaust retries",
        rmImpact: 1,
        kwhImpact: 1,
        confidence: "medium",
        evidenceRefs: ["x"],
        deadline: "2026-06-30",
        approvalClass: "human_signature",
        createdAt: NOW,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SolarOpsError);
    const msg = (caught as SolarOpsError).message;
    // Must interpolate the local idDateKey string, never the dateKey Function.
    expect(msg).toContain(day);
    expect(msg).toMatch(/2026-06-21/);
    expect(msg).not.toMatch(/function/i);
    expect(msg).toMatch(/exhausted/);
  });
});

describe("CE7 tool surface + service verbs", () => {
  function toolCtx(svc: ActionVerbs, candidates: ActionCandidate[]) {
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

  it("I5-1: tool context / service must not expose getLedger (ledger leak attack)", () => {
    const { svc } = fresh();
    // Public service return: getLedger is gone.
    expect(
      (svc as { getLedger?: unknown }).getLedger,
    ).toBeUndefined();
    expect(typeof (svc as { getLedger?: unknown }).getLedger).toBe("undefined");
    expect(Object.prototype.hasOwnProperty.call(svc, "getLedger")).toBe(false);

    // ActionToolContext.svc is ActionVerbs — same runtime object, no ledger.
    const ctx: ActionToolContext = {
      svc,
      getCandidate: () => undefined,
      getCandidatesForSite: () => [],
      getDecisions: () => undefined,
      setDecisions: () => {},
      getGroundingOutputs: () => [],
      now: NOW,
    };
    expect(
      (ctx.svc as { getLedger?: unknown }).getLedger,
    ).toBeUndefined();
    expect(typeof (ctx.svc as { getLedger?: unknown }).getLedger).toBe(
      "undefined",
    );
    // Narrow type surface: no raw ledger / transitionAction on ActionVerbs.
    expect(
      (ctx.svc as { transitionAction?: unknown }).transitionAction,
    ).toBeUndefined();
  });

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

describe("live-loop mock: denied feeds back then escalate (I5-2/I5-5)", () => {
  it("MockLanguageModelV4 via runSweep: commit denied → escalate; reconciliation records deny row", async () => {
    const { svc, ledger } = fresh();

    /** Flatten LanguageModelV4 prompt messages into searchable text. */
    function flattenPrompt(options: unknown): string {
      const prompt = (options as { prompt?: unknown }).prompt;
      if (typeof prompt === "string") return prompt;
      if (Array.isArray(prompt)) {
        return prompt
          .map((m: { role?: string; content?: unknown }) => {
            if (typeof m.content === "string") return m.content;
            if (Array.isArray(m.content)) {
              return m.content
                .map((part: { type?: string; text?: string }) =>
                  typeof part.text === "string" ? part.text : JSON.stringify(part),
                )
                .join("\n");
            }
            return JSON.stringify(m.content ?? "");
          })
          .join("\n");
      }
      return JSON.stringify(options);
    }

    function parseCandidate(
      promptText: string,
      siteId: string,
      kind: string,
    ): { id: string; evidence: string; desc: string } | null {
      const siteBlock = promptText
        .split(/Site /)
        .find((b) => b.startsWith(siteId));
      if (!siteBlock) return null;
      const re = new RegExp(
        `id=(\\S+) kind=${kind} rmImpact=\\S+ deadline=\\S+ evidence=(\\S+)\\n\\s+desc: (.+)`,
      );
      const m = siteBlock.match(re);
      if (!m) return null;
      return { id: m[1]!, evidence: m[2]!.split("|")[0]!, desc: m[3]!.trim() };
    }

    let calls = 0;
    let listing = "";
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        calls += 1;
        const src = flattenPrompt(options);
        if (src.includes("id=")) listing = src;
        const text = listing || src;

        if (calls === 1) {
          const load = parseCandidate(text, "site_c", "load_shift");
          expect(load).not.toBeNull();
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "commit_action",
                input: JSON.stringify({
                  site_id: "site_c",
                  candidate_id: load!.id,
                  narrative: load!.desc,
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
          const esc = parseCandidate(text, "site_c", "escalate");
          expect(esc).not.toBeNull();
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "c2",
                toolName: "escalate",
                input: JSON.stringify({
                  site_id: "site_c",
                  reason: "data_issue blocks load_shift",
                  evidence_ref: esc!.evidence,
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

    const result = await runSweep({
      svc,
      ledger,
      asOfDate: AS_OF,
      now: NOW,
      mode: "live",
      model,
      maxSteps: 8,
    });

    expect(result.mode).toBe("live");
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result.sweep.notes.some((n) => n.startsWith("reconcile="))).toBe(true);

    // Live path: toolApproval denied commit_action (execute never ran).
    // I5-2 reconciliation is the single writer for denials — durable red card.
    const siteC = (await ledger.listActions({ siteId: "site_c" })).filter(
      (a) => a.sweepId === result.sweep.id,
    );
    const loadRow = siteC.find((a) => a.kind === "load_shift");
    expect(loadRow).not.toBeNull();
    expect(loadRow).toBeDefined();
    expect(loadRow!.status).toBe("denied_by_policy");
    expect(
      loadRow!.policyDecisions.some(
        (d) => d.policyId === "no_action_on_bad_data" && d.outcome === "deny",
      ),
    ).toBe(true);

    const escRow = siteC.find((a) => a.kind === "escalate");
    expect(escRow).toBeDefined();
    expect(escRow!.status).toBe("issued");
    expect(escRow!.decidedBy).toBe(GOVERNOR_AUTO_PRINCIPAL);

    // Full offline-equivalent outcomes still hold after live + reconcile.
    const siteA = (await ledger.listActions({ siteId: "site_a" })).filter(
      (a) => a.sweepId === result.sweep.id,
    );
    expect(siteA.find((a) => a.kind === "load_shift")?.status).toBe(
      "awaiting_approval",
    );
    expect(siteA.find((a) => a.kind === "load_shift")?.rmImpact).toBe(
      SITE_A_RM_IMPACT,
    );
  });
});

describe("I5-7 reconciliation skip key (siteId, kind, deadline)", () => {
  it("skips already-written rows even when candidate id was reallocated (C4)", async () => {
    const { svc, ledger } = fresh();
    const thisSweepId = `swp_${AS_OF.replace(/-/g, "")}`;
    const clock = svc.atapCreditClock("site_a", AS_OF);
    const deadline = clock.coverage.period_end;

    // Simulate a live-loop write after C4 id reallocation: same site/kind/deadline
    // and sweep, but a different id than the deterministic candidate id (seq 1).
    const reallocatedId = actionId("site_a", AS_OF, 99);
    await ledger.saveAction({
      id: reallocatedId,
      siteId: "site_a",
      sweepId: thisSweepId,
      kind: "load_shift",
      title: "Pre-written load_shift (simulates C4 reallocated id)",
      description: "Already on ledger under a different id.",
      rmImpact: SITE_A_RM_IMPACT,
      kwhImpact: clock.projection!.load_shiftable_export_kwh,
      confidence: "high",
      evidenceRefs: ["prewrite"],
      deadline,
      approvalClass: "human_signature",
      status: "proposed",
      policyDecisions: [],
      verification: null,
      createdAt: NOW,
      decidedAt: null,
      decidedBy: null,
    });
    await ledger.transitionAction(reallocatedId, "awaiting_approval", {
      policyDecisions: [
        {
          policyId: "pol_human_signature",
          outcome: "require_approval",
          reason: "pre-written",
        },
      ],
    });

    // Live model that immediately stops — reconciliation is the only writer.
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "done" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
    });

    const result = await runSweep({
      svc,
      ledger,
      asOfDate: AS_OF,
      now: NOW,
      mode: "live",
      model,
      maxSteps: 2,
    });

    expect(result.mode).toBe("live");
    expect(result.sweep.id).toBe(thisSweepId);
    expect(result.sweep.notes.some((n) => n.startsWith("reconcile="))).toBe(true);

    const siteALoads = (await ledger.listActions({ siteId: "site_a", sweepId: thisSweepId })).filter(
      (a) => a.kind === "load_shift" && a.deadline === deadline,
    );
    // Must NOT double-write: still exactly one load_shift for this key.
    expect(siteALoads).toHaveLength(1);
    expect(siteALoads[0]!.id).toBe(reallocatedId);
    expect(siteALoads[0]!.status).toBe("awaiting_approval");
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
