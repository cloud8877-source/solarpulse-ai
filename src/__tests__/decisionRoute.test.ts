/**
 * POST /api/agent/actions/[id]/decision route tests (I7).
 * - approve happy path → issued with decidedBy
 * - blank decided_by → 400 illegal_field
 * - deny records human_rejected
 * - double-decide → ledger error surfaced cleanly
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as decisionPost } from "../app/api/agent/actions/[id]/decision/route";
import {
  _resetLedgerSingletonForTests,
  getLedger,
  InMemoryLedger,
} from "../data/ledger";
import { InMemoryStore } from "../data/store";
import { createSolarOpsService } from "../services/solarops";
import { runSweep } from "../agent/sweep";

const AS_OF = "2026-06-21";
const NOW = "2026-06-21T09:00:00+08:00";

async function seedAwaitingLoadShift(): Promise<string> {
  // Replace process singleton with a fresh ledger so the route's getLedger()
  // sees the sweep we just ran.
  _resetLedgerSingletonForTests();
  const ledger = getLedger() as InMemoryLedger;
  // getLedger seeds demo rows; runSweep on top with explicit asOfDate.
  const store = new InMemoryStore();
  const svc = createSolarOpsService(store, { ledger });
  const result = await runSweep({
    svc,
    ledger,
    asOfDate: AS_OF,
    now: NOW,
    mode: "offline",
  });
  const rows = await ledger.listActions({ siteId: "site_a", sweepId: result.sweep.id });
  const load = rows.find((a) => a.kind === "load_shift" && a.status === "awaiting_approval");
  if (!load) throw new Error("expected site_a load_shift awaiting_approval after sweep");
  return load.id;
}

function callDecision(
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
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

describe("POST /api/agent/actions/[id]/decision", () => {
  it("approve happy path flips awaiting_approval → issued with decidedBy", async () => {
    const id = await seedAwaitingLoadShift();
    const res = await callDecision(id, {
      decision: "approve",
      decided_by: "demo_operator",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      action: { status: string; decidedBy: string | null; id: string };
    };
    expect(json.action.id).toBe(id);
    expect(json.action.status).toBe("issued");
    expect(json.action.decidedBy).toBe("demo_operator");

    const row = await getLedger().getAction(id);
    expect(row?.status).toBe("issued");
    expect(row?.decidedBy).toBe("demo_operator");
  });

  it("blank decided_by → 400 illegal_field", async () => {
    const id = await seedAwaitingLoadShift();
    const res = await callDecision(id, { decision: "approve", decided_by: "   " });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe("illegal_field");
    expect(json.message.toLowerCase()).toContain("decided_by");
  });

  it("missing decided_by → 400 illegal_field", async () => {
    const id = await seedAwaitingLoadShift();
    const res = await callDecision(id, { decision: "deny" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("illegal_field");
  });

  it("deny records human_rejected and sets denied_by_policy", async () => {
    const id = await seedAwaitingLoadShift();
    const res = await callDecision(id, {
      decision: "deny",
      decided_by: "demo_operator",
      reason: "Not scheduling this week",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      action: {
        status: string;
        decidedBy: string | null;
        policyDecisions: Array<{ policyId: string; reason: string; outcome: string }>;
      };
    };
    expect(json.action.status).toBe("denied_by_policy");
    expect(json.action.decidedBy).toBe("demo_operator");
    const human = json.action.policyDecisions.find((p) => p.policyId === "human_rejected");
    expect(human).toBeDefined();
    expect(human!.outcome).toBe("deny");
    expect(human!.reason).toBe("Not scheduling this week");
  });

  it("double-decide surfaces ledger error cleanly", async () => {
    const id = await seedAwaitingLoadShift();
    const first = await callDecision(id, {
      decision: "approve",
      decided_by: "demo_operator",
    });
    expect(first.status).toBe(200);

    const second = await callDecision(id, {
      decision: "approve",
      decided_by: "demo_operator",
    });
    expect(second.status).toBe(400);
    const json = (await second.json()) as { error: string; message: string };
    expect(json.error).toBe("ledger_error");
    expect(json.message.toLowerCase()).toContain("illegal transition");
  });

  it("I7-1: stranded approved (approve via service, then route approve) → issued", async () => {
    // Simulate the mid-flight failure: approveAction succeeds, issueAction never ran.
    const id = await seedAwaitingLoadShift();
    const ledger = getLedger();
    const svc = createSolarOpsService(undefined, { ledger });
    await svc.approveAction(id, {
      decidedBy: "stranded_operator",
      decidedAt: NOW,
    });
    const mid = await ledger.getAction(id);
    expect(mid?.status).toBe("approved");
    expect(mid?.decidedBy).toBe("stranded_operator");

    // Route must skip re-approve and issue from the stranded state.
    const res = await callDecision(id, {
      decision: "approve",
      decided_by: "retry_operator",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      action: { status: string; decidedBy: string | null };
    };
    expect(json.action.status).toBe("issued");
    // Signature stays the original approver (issue does not rewrite decidedBy).
    expect(json.action.decidedBy).toBe("stranded_operator");

    const row = await ledger.getAction(id);
    expect(row?.status).toBe("issued");
    expect(row?.decidedBy).toBe("stranded_operator");
  });
});
