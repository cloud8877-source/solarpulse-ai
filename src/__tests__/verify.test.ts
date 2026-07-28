/**
 * CE7-verifier shape (I6 / I6b): closed-period verification + expiry.
 * - period_not_closed refusal
 * - coverage gate: partial-period actuals → skipped (insufficient_coverage), left ungraded
 * - full loop: sweep → approve site_a load_shift via decision route → verify
 * - SEED falsified beat (act_site_b_20260624_2) remains the graded falsified story
 * - no path grades a non-issued row
 * - no re-grade (verification_already_set → skipped)
 * - model cannot author grades (no verify tool in registry)
 * - expiry: awaiting June deadline → expired with period_closed_unsigned
 * - stranded-approved → issue then coverage-skip (signature honored, grade refused)
 * - double-verify run → idempotent
 * - synthetic full-coverage grades all three bands
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as decisionPost } from "../app/api/agent/actions/[id]/decision/route";
import { runSweep } from "../agent/sweep";
import { gradeMeasuredRm, runVerification } from "../agent/verify";
import { assumptions } from "../config/assumptions";
import {
  _resetLedgerSingletonForTests,
  getLedger,
  InMemoryLedger,
} from "../data/ledger";
import { InMemoryStore } from "../data/store";
import { createSolarOpsService, SolarOpsError } from "../services/solarops";
import { solaropsTools } from "../tools";
import { createActionTools } from "../tools/actions";

const AS_OF = "2026-06-21";
const SWEEP_NOW = "2026-06-21T09:00:00+08:00";
/** Closed period after June — grades permanent; period_end 2026-06-30 < today. */
const VERIFY_NOW = "2026-07-01T10:00:00+08:00";
const PERIOD_END = "2026-06-30";

/**
 * Realized smp_spread_rm for site_a June fixtures (06-18..21 only).
 * Recompute comments (same raw sums as atap.test F15, without projection):
 *   export_raw  = 7989.78999999999905413 → round 7989.79
 *   import_raw  = 6462.81999999999970896 → round 6462.82
 *   daylight_raw = 698.820000000000050022 → round 698.82
 *   MAQ = 850 × 5 × 30 = 127500
 *   offsettable = min(export, import, MAQ) = 6462.81999999999970896
 *   load_shiftable = min(offsettable, daylight) = 698.820000000000050022
 *   spreadRate = 0.5068 − 0.1893 = 0.3175
 *   smp_spread = 698.820000000000050022 × 0.3175 = 221.875350000000016957 → 221.88
 *
 * Coverage: 4/30 days = 13.3% < verifyCoverageFloor 0.8 → gate REFUSES grade.
 */
const SITE_A_REALIZED_SMP_SPREAD_RM = 221.88;

/** SEED falsified row (buildDemoSeed with DEMO_SEED_NOW 2026-07-01 → prior 2026-06-24). */
const SEED_FALSIFIED_ID = "act_site_b_20260624_2";
const SEED_VERIFIED_RM_IMPACT = 420.5;
const SEED_VERIFIED_MEASURED = 415.2;
const SEED_FALSIFIED_RM_IMPACT = 210;
const SEED_FALSIFIED_MEASURED = 12;

function fresh() {
  _resetLedgerSingletonForTests();
  const ledger = getLedger() as InMemoryLedger;
  const store = new InMemoryStore();
  const svc = createSolarOpsService(store, { ledger });
  return { ledger, store, svc };
}

async function sweepAndAwaitingLoadShift(svc: ReturnType<typeof createSolarOpsService>, ledger: InMemoryLedger) {
  const result = await runSweep({
    svc,
    ledger,
    asOfDate: AS_OF,
    now: SWEEP_NOW,
    mode: "offline",
  });
  const rows = await ledger.listActions({ siteId: "site_a", sweepId: result.sweep.id });
  const load = rows.find((a) => a.kind === "load_shift" && a.status === "awaiting_approval");
  if (!load) throw new Error("expected site_a load_shift awaiting_approval after sweep");
  return { result, load };
}

function callDecision(id: string, body: Record<string, unknown>): Promise<Response> {
  return decisionPost(
    new Request(`http://localhost/api/agent/actions/${id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  _resetLedgerSingletonForTests();
});

afterEach(() => {
  _resetLedgerSingletonForTests();
});

describe("gradeMeasuredRm (config bands)", () => {
  it("reads bands from assumptions — never hardcodes", () => {
    expect(assumptions.kredit.verifyTolerancePct).toBe(0.25);
    expect(assumptions.kredit.partialFloorPct).toBe(0.5);
    // claim 100: verified ≥ 75, partial ≥ 50, else falsified
    expect(gradeMeasuredRm(75, 100)).toBe("verified");
    expect(gradeMeasuredRm(74.9, 100)).toBe("partial");
    expect(gradeMeasuredRm(50, 100)).toBe("partial");
    expect(gradeMeasuredRm(49.9, 100)).toBe("falsified");
  });
});

describe("computeAtapRealizedValue / atapRealizedValue (fixture pins)", () => {
  it("site_a June realized smp_spread_rm pins to hand-derived 221.88", () => {
    const { svc } = fresh();
    const r = svc.atapRealizedValue("site_a", PERIOD_END, VERIFY_NOW);
    expect(r.period_end).toBe(PERIOD_END);
    expect(r.observed_days).toBe(4);
    expect(r.days_in_period).toBe(30);
    expect(r.export_kwh).toBe(7989.79);
    expect(r.import_kwh).toBe(6462.82);
    expect(r.daylight_import_kwh).toBe(698.82);
    expect(r.load_shiftable_export_kwh).toBe(698.82);
    expect(r.smp_spread_rm).toBe(SITE_A_REALIZED_SMP_SPREAD_RM);
    expect(r.assumptions.some((a) => a.includes("no linear_daily_mean"))).toBe(true);
    expect(r.source_manifest.runId).toContain("atap_realized_site_a");
    // 4/30 = 0.133… < verifyCoverageFloor 0.8
    expect(r.observed_days / r.days_in_period).toBeLessThan(
      assumptions.kredit.verifyCoverageFloor,
    );
  });
});

describe("runVerification period gate", () => {
  it("refuses period_not_closed when period_end >= today", async () => {
    const { svc, ledger } = fresh();
    await expect(
      runVerification({
        periodEnd: PERIOD_END,
        now: "2026-06-30T12:00:00+08:00", // period still open
        svc,
        ledger,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(SolarOpsError);
      expect((err as SolarOpsError).code).toBe("period_not_closed");
      expect((err as SolarOpsError).message).toMatch(/period_not_closed/);
      return true;
    });
  });

  it("refuses open future period", async () => {
    const { svc, ledger } = fresh();
    await expect(
      runVerification({
        periodEnd: "2026-07-31",
        now: VERIFY_NOW,
        svc,
        ledger,
      }),
    ).rejects.toMatchObject({ code: "period_not_closed" });
  });
});

describe("runVerification full loop (CE7-verifier / I6b coverage gate)", () => {
  it("sweep → decision approve → verify SKIPS site_a load_shift (insufficient_coverage)", async () => {
    const { svc, ledger } = fresh();
    const { load } = await sweepAndAwaitingLoadShift(svc, ledger);

    // Approve via the decision route (two-await path).
    const res = await callDecision(load.id, {
      decision: "approve",
      decided_by: "demo_operator",
    });
    expect(res.status).toBe(200);
    const issued = await ledger.getAction(load.id);
    expect(issued?.status).toBe("issued");
    expect(issued?.rmImpact).toBe(1664.07); // projected claim from value_leak.smp_spread_rm

    const result = await runVerification({
      periodEnd: PERIOD_END,
      now: VERIFY_NOW,
      svc,
      ledger,
    });

    expect(result.period_end).toBe(PERIOD_END);
    // Coverage gate: 4/30 days observed → skipped, NOT graded.
    expect(result.graded).toBe(0);

    const skipped = result.rows.find(
      (r) => r.action_id === load.id && r.disposition === "skipped",
    );
    expect(skipped).toBeDefined();
    expect(skipped!.note).toMatch(/^insufficient_coverage:/);
    expect(skipped!.note).toMatch(/4\/30 days observed/);
    expect(skipped!.note).toMatch(/13\.3% < floor 80%/);
    expect(skipped!.note).toMatch(/action left ungraded/);
    expect(skipped!.outcome).toBeUndefined();

    // Ledger: action stays issued, verification null (not-writing refusal).
    const row = await ledger.getAction(load.id);
    expect(row?.status).toBe("issued");
    expect(row?.verification).toBeNull();

    // SEED falsified beat still present and unchanged (graded offline in seed).
    const seedFalsified = await ledger.getAction(SEED_FALSIFIED_ID);
    expect(seedFalsified?.verification?.outcome).toBe("falsified");
    expect(seedFalsified?.rmImpact).toBe(SEED_FALSIFIED_RM_IMPACT);
    expect(seedFalsified?.verification?.measuredRm).toBe(SEED_FALSIFIED_MEASURED);
  });

  it("no path grades a non-issued row", async () => {
    const { svc, ledger } = fresh();
    const { load } = await sweepAndAwaitingLoadShift(svc, ledger);
    // Leave at awaiting_approval — should expire, not grade.
    const result = await runVerification({
      periodEnd: PERIOD_END,
      now: VERIFY_NOW,
      svc,
      ledger,
    });
    const row = await ledger.getAction(load.id);
    expect(row?.status).toBe("expired");
    expect(row?.verification).toBeNull();
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(
      result.rows.some(
        (r) => r.action_id === load.id && r.disposition === "expired",
      ),
    ).toBe(true);
  });

  it("expiry: awaiting June deadline → expired with period_closed_unsigned", async () => {
    const { svc, ledger } = fresh();
    const { load } = await sweepAndAwaitingLoadShift(svc, ledger);
    await runVerification({
      periodEnd: PERIOD_END,
      now: VERIFY_NOW,
      svc,
      ledger,
    });
    const row = await ledger.getAction(load.id);
    expect(row?.status).toBe("expired");
    const pd = row?.policyDecisions.find((p) => p.policyId === "period_closed_unsigned");
    expect(pd).toBeDefined();
    expect(pd!.outcome).toBe("deny");
    expect(pd!.reason).toMatch(/credit forfeited/i);
  });

  it("stranded-approved → issue then coverage-skip (honors signature, leaves ungraded)", async () => {
    const { svc, ledger } = fresh();
    const { load } = await sweepAndAwaitingLoadShift(svc, ledger);
    await svc.approveAction(load.id, {
      decidedBy: "stranded_op",
      decidedAt: SWEEP_NOW,
    });
    expect((await ledger.getAction(load.id))?.status).toBe("approved");

    const result = await runVerification({
      periodEnd: PERIOD_END,
      now: VERIFY_NOW,
      svc,
      ledger,
    });

    const row = await ledger.getAction(load.id);
    // Signature honored (issued); grade refused by coverage gate.
    expect(row?.status).toBe("issued");
    expect(row?.decidedBy).toBe("stranded_op");
    expect(row?.verification).toBeNull();
    expect(result.issued_then_graded).toBe(0);
    expect(
      result.rows.some(
        (r) =>
          r.action_id === load.id &&
          r.disposition === "skipped" &&
          /insufficient_coverage/.test(r.note),
      ),
    ).toBe(true);
  });

  it("double-verify run is idempotent (coverage skip both times; still ungraded)", async () => {
    const { svc, ledger } = fresh();
    const { load } = await sweepAndAwaitingLoadShift(svc, ledger);
    await callDecision(load.id, {
      decision: "approve",
      decided_by: "demo_operator",
    });

    const first = await runVerification({
      periodEnd: PERIOD_END,
      now: VERIFY_NOW,
      svc,
      ledger,
    });
    expect(first.graded).toBe(0);
    const firstSkip = first.rows.find(
      (r) => r.action_id === load.id && r.disposition === "skipped",
    );
    expect(firstSkip?.note).toMatch(/insufficient_coverage/);

    const second = await runVerification({
      periodEnd: PERIOD_END,
      now: VERIFY_NOW,
      svc,
      ledger,
    });
    const skip = second.rows.find(
      (r) => r.action_id === load.id && r.disposition === "skipped",
    );
    expect(skip).toBeDefined();
    expect(skip!.note).toMatch(/insufficient_coverage/);
    // Still ungraded — no permanent write either run
    const row = await ledger.getAction(load.id);
    expect(row?.verification).toBeNull();
    expect(second.graded).toBe(0);
  });

  it("manual verifyAction re-grade still raises ledger_error", async () => {
    const { svc, ledger } = fresh();
    const proposed = await svc.proposeAction({
      siteId: "site_a",
      sweepId: "swp_regrade",
      kind: "load_shift",
      title: "r",
      description: "regrade",
      rmImpact: 10,
      kwhImpact: 40,
      confidence: "medium",
      evidenceRefs: ["e"],
      deadline: PERIOD_END,
      approvalClass: "human_signature",
      createdAt: SWEEP_NOW,
    });
    await svc.requestApproval(proposed.id);
    await svc.approveAction(proposed.id, { decidedBy: "alice", decidedAt: SWEEP_NOW });
    await svc.issueAction(proposed.id);
    await svc.verifyAction(proposed.id, {
      outcome: "verified",
      measuredRm: 9,
      note: "first",
      verifiedAt: VERIFY_NOW,
    });
    await expect(
      svc.verifyAction(proposed.id, {
        outcome: "falsified",
        measuredRm: 0,
        note: "attack",
        verifiedAt: VERIFY_NOW,
      }),
    ).rejects.toMatchObject({ code: "ledger_error" });
  });
});

describe("synthetic full-coverage grades all three bands (gate does not break real grading)", () => {
  it("verified / partial / falsified when coverage ≥ floor", async () => {
    const { svc, ledger } = fresh();

    // Stub realized path: full coverage + controlled measuredRm per site.
    // Bands: claim 100 → verified ≥ 75, partial ≥ 50, else falsified.
    const measuredBySite: Record<string, number> = {
      site_a: 90, // verified
      site_b: 60, // partial
      site_c: 10, // falsified
    };
    const original = svc.atapRealizedValue.bind(svc);
    (svc as { atapRealizedValue: typeof svc.atapRealizedValue }).atapRealizedValue = (
      siteId: string,
      periodEnd: string,
      now?: string,
    ) => {
      const base = original(siteId, periodEnd, now);
      return {
        ...base,
        observed_days: base.days_in_period, // 100% coverage
        smp_spread_rm: measuredBySite[siteId] ?? base.smp_spread_rm,
      };
    };

    const claim = 100;
    const sites = ["site_a", "site_b", "site_c"] as const;
    const expectedOutcomes = ["verified", "partial", "falsified"] as const;
    const expectedMeasured = [90, 60, 10] as const;
    const ids: [string, string, string] = ["", "", ""];
    for (let i = 0; i < sites.length; i++) {
      const siteId = sites[i]!;
      const proposed = await svc.proposeAction({
        siteId,
        sweepId: "swp_full_cov",
        kind: "load_shift",
        title: `full-cov ${siteId}`,
        description: "synthetic full-coverage grade band",
        rmImpact: claim,
        kwhImpact: 400,
        confidence: "high",
        evidenceRefs: ["synthetic_full_coverage"],
        deadline: PERIOD_END,
        approvalClass: "human_signature",
        createdAt: SWEEP_NOW,
      });
      await svc.requestApproval(proposed.id);
      await svc.approveAction(proposed.id, {
        decidedBy: "band_tester",
        decidedAt: SWEEP_NOW,
      });
      await svc.issueAction(proposed.id);
      ids[i] = proposed.id;
    }

    const result = await runVerification({
      periodEnd: PERIOD_END,
      now: VERIFY_NOW,
      svc,
      ledger,
    });

    expect(result.graded).toBeGreaterThanOrEqual(3);
    const byId = Object.fromEntries(result.rows.map((r) => [r.action_id, r]));

    for (let i = 0; i < 3; i++) {
      const id = ids[i]!;
      expect(byId[id]?.disposition).toBe("graded");
      expect(byId[id]?.outcome).toBe(expectedOutcomes[i]);
      expect(byId[id]?.measured_rm).toBe(expectedMeasured[i]);
      expect((await ledger.getAction(id))?.verification?.outcome).toBe(
        expectedOutcomes[i],
      );
    }
  });
});

describe("model cannot author grades", () => {
  it("tool registry exposes no verify tool", () => {
    const readKeys = Object.keys(solaropsTools);
    expect(readKeys.some((k) => /verif/i.test(k))).toBe(false);

    // Action tools: only commit_action + escalate
    const actionTools = createActionTools({
      svc: createSolarOpsService(new InMemoryStore(), {
        ledger: new InMemoryLedger(),
      }),
      getCandidate: () => undefined,
      getCandidatesForSite: () => [],
      getDecisions: () => undefined,
      setDecisions: () => {},
      getGroundingOutputs: () => [],
    });
    const actionKeys = Object.keys(actionTools);
    expect(actionKeys).toEqual(expect.arrayContaining(["commit_action", "escalate"]));
    expect(actionKeys.some((k) => /verif/i.test(k))).toBe(false);
  });
});

describe("ActionReads surface (I7-3 / scoreboard)", () => {
  it("listSweepFeed is bounded; page does not need getLedger", async () => {
    const { svc, ledger } = fresh();
    await runSweep({
      svc,
      ledger,
      asOfDate: AS_OF,
      now: SWEEP_NOW,
      mode: "offline",
    });
    const feed = await svc.listSweepFeed(10);
    expect(feed.length).toBeLessThanOrEqual(10);
    expect(feed.length).toBeGreaterThan(0);
    for (const s of feed) {
      const acts = await svc.listSweepActions(s.id, 50);
      expect(acts.length).toBeLessThanOrEqual(50);
    }
  });

  it("scoreboard pins SEED demo story (I6b post-fix expected state)", async () => {
    const { svc } = fresh();
    // getLedger seeds demo rows on first construction (via fresh → getLedger).
    //
    // Recompute (SEED only — ungraded rows excluded from denominators):
    //   rm_identified = 420.5 (verified) + 210 (falsified) = 630.5
    //   rm_verified   = 415.2 (verified measured only; falsified measured 12 excluded)
    //   action_accuracy = 1 verified / 2 graded = 0.5
    //   ungraded_insufficient_coverage = 0 (no issued ungraded load_shift yet)
    const sb = await svc.getKreditScoreboard();
    expect(sb.verified_count).toBe(1);
    expect(sb.falsified_count).toBe(1);
    expect(sb.partial_count).toBe(0);
    expect(sb.graded_count).toBe(2);
    expect(sb.rm_identified).toBe(SEED_VERIFIED_RM_IMPACT + SEED_FALSIFIED_RM_IMPACT); // 630.5
    expect(sb.rm_verified).toBe(SEED_VERIFIED_MEASURED); // 415.2
    expect(sb.action_accuracy).toBe(0.5);
    expect(sb.ungraded_insufficient_coverage).toBe(0);
  });

  it("scoreboard counts June load_shift left ungraded by coverage gate", async () => {
    const { svc, ledger } = fresh();
    const { load } = await sweepAndAwaitingLoadShift(svc, ledger);
    await callDecision(load.id, {
      decision: "approve",
      decided_by: "demo_operator",
    });
    await runVerification({
      periodEnd: PERIOD_END,
      now: VERIFY_NOW,
      svc,
      ledger,
    });

    const sb = await svc.getKreditScoreboard();
    // SEED grades unchanged; June action ungraded and excluded from accuracy denom.
    expect(sb.rm_identified).toBe(630.5);
    expect(sb.rm_verified).toBe(415.2);
    expect(sb.action_accuracy).toBe(0.5);
    expect(sb.ungraded_insufficient_coverage).toBe(1);
  });
});
