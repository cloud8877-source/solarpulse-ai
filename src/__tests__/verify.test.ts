/**
 * CE7-verifier shape (I6): closed-period verification + expiry.
 * - period_not_closed refusal
 * - full loop: sweep → approve site_a load_shift via decision route → verify
 * - measuredRm pinned from realized engine math on fixture CSVs
 * - no path grades a non-issued row
 * - no re-grade (verification_already_set → skipped)
 * - model cannot author grades (no verify tool in registry)
 * - expiry: awaiting June deadline → expired with period_closed_unsigned
 * - stranded-approved → issued then graded
 * - double-verify run → idempotent
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
 */
const SITE_A_REALIZED_SMP_SPREAD_RM = 221.88;

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

describe("runVerification full loop (CE7-verifier)", () => {
  it("sweep → decision approve → verify grades site_a load_shift with pinned measuredRm", async () => {
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
    expect(result.graded).toBeGreaterThanOrEqual(1);

    const graded = result.rows.find(
      (r) => r.action_id === load.id && r.disposition === "graded",
    );
    expect(graded).toBeDefined();
    expect(graded!.measured_rm).toBe(SITE_A_REALIZED_SMP_SPREAD_RM);
    // 221.88 / 1664.07 ≈ 0.133 < partialFloor 0.5 → falsified (honest partial coverage)
    expect(graded!.outcome).toBe("falsified");

    const row = await ledger.getAction(load.id);
    expect(row?.verification?.outcome).toBe("falsified");
    expect(row?.verification?.measuredRm).toBe(SITE_A_REALIZED_SMP_SPREAD_RM);
    expect(row?.verification?.assumptions?.some((a) => a.includes("verifyTolerancePct"))).toBe(
      true,
    );
    expect(row?.verification?.assumptions?.some((a) => a.includes("coverage caveat"))).toBe(
      true,
    );
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

  it("stranded-approved → issue then grade (honors recorded signature)", async () => {
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
    expect(row?.status).toBe("issued");
    expect(row?.decidedBy).toBe("stranded_op");
    expect(row?.verification).not.toBeNull();
    expect(row?.verification?.measuredRm).toBe(SITE_A_REALIZED_SMP_SPREAD_RM);
    expect(result.issued_then_graded).toBeGreaterThanOrEqual(1);
    expect(
      result.rows.some(
        (r) => r.action_id === load.id && r.disposition === "issued_then_graded",
      ),
    ).toBe(true);
  });

  it("double-verify run is idempotent (already-graded skipped)", async () => {
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
    expect(first.graded).toBeGreaterThanOrEqual(1);

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
    expect(skip!.note).toMatch(/verification_already_set|skipped/i);
    // Outcome unchanged
    const row = await ledger.getAction(load.id);
    expect(row?.verification?.outcome).toBe("falsified");
    expect(row?.verification?.measuredRm).toBe(SITE_A_REALIZED_SMP_SPREAD_RM);
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

  it("scoreboard uses seed verified/falsified rows (demo story)", async () => {
    const { svc } = fresh();
    // getLedger seeds demo rows on first construction (via fresh → getLedger).
    const sb = await svc.getKreditScoreboard();
    // Seed: verified measured 415.2 + falsified measured 12 (not counted in rm_verified)
    // rm_verified = sum measuredRm of verified+partial only → 415.2
    expect(sb.verified_count).toBeGreaterThanOrEqual(1);
    expect(sb.falsified_count).toBeGreaterThanOrEqual(1);
    expect(sb.rm_verified).toBeGreaterThanOrEqual(415.2);
    expect(sb.rm_identified).toBeGreaterThanOrEqual(420.5);
    expect(sb.action_accuracy).not.toBeNull();
  });
});
