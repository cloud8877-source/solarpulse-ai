/**
 * KREDIT governor unit tests (I5 / C3).
 * Policies evaluated in order; first deny short-circuits.
 */
import { describe, expect, it } from "vitest";
import {
  evaluate,
  toToolApprovalStatus,
  type GovernorCandidate,
  type GovernorContext,
} from "../agent/governor";

function candidate(overrides: Partial<GovernorCandidate> = {}): GovernorCandidate {
  return {
    id: "act_site_a_20260621_1",
    siteId: "site_a",
    kind: "load_shift",
    confidence: "medium",
    evidenceRefs: ["atap_site_a_20260621", "anom_site_a_20260621"],
    deadline: "2026-06-30",
    title: "test",
    ...overrides,
  };
}

function ctx(overrides: Partial<GovernorContext> = {}): GovernorContext {
  return {
    siteEligible: true,
    severity: "healthy",
    knownEvidenceRefs: ["atap_site_a_20260621", "anom_site_a_20260621"],
    nonEscalateCountThisSweep: 0,
    ...overrides,
  };
}

describe("governor.evaluate — policy order", () => {
  it("eligibility_required denies credit kinds on ineligible sites", () => {
    const r = evaluate(candidate(), ctx({ siteEligible: false }));
    expect(r.status).toBe("denied");
    expect(r.decisions.map((d) => d.policyId)).toEqual(["eligibility_required"]);
    expect(r.decisions[0]!.outcome).toBe("deny");
  });

  it("eligibility_required allows escalate on ineligible sites", () => {
    const r = evaluate(
      candidate({ kind: "escalate" }),
      ctx({ siteEligible: false, severity: "anomaly" }),
    );
    // escalate continues past eligibility; ends auto_class approved
    expect(r.status).toBe("approved");
    expect(r.decisions[0]!.policyId).toBe("eligibility_required");
    expect(r.decisions[0]!.outcome).toBe("allow");
    expect(r.decisions.some((d) => d.policyId === "auto_class")).toBe(true);
  });

  it("no_action_on_bad_data denies load_shift on data_issue day", () => {
    const r = evaluate(candidate(), ctx({ severity: "data_issue" }));
    expect(r.status).toBe("denied");
    expect(r.decisions.map((d) => d.policyId)).toEqual([
      "eligibility_required",
      "no_action_on_bad_data",
    ]);
    expect(r.decisions.at(-1)!.policyId).toBe("no_action_on_bad_data");
    expect(r.decisions.at(-1)!.outcome).toBe("deny");
  });

  it("no_action_on_bad_data allows escalate on data_issue day", () => {
    const r = evaluate(candidate({ kind: "escalate" }), ctx({ severity: "data_issue" }));
    expect(r.status).toBe("approved");
    const bad = r.decisions.find((d) => d.policyId === "no_action_on_bad_data");
    expect(bad?.outcome).toBe("allow");
  });

  it("evidence_required denies commit kinds with low confidence", () => {
    const r = evaluate(candidate({ confidence: "low" }), ctx());
    expect(r.status).toBe("denied");
    expect(r.decisions.at(-1)!.policyId).toBe("evidence_required");
  });

  it("evidence_required denies commit kinds with unresolvable evidence refs", () => {
    const r = evaluate(
      candidate({ evidenceRefs: ["missing_ref"] }),
      ctx({ knownEvidenceRefs: ["other"] }),
    );
    expect(r.status).toBe("denied");
    expect(r.decisions.at(-1)!.policyId).toBe("evidence_required");
    expect(r.decisions.at(-1)!.reason).toContain("missing_ref");
  });

  it("rate_limit_per_site denies when non-escalate count is at max", () => {
    const r = evaluate(
      candidate(),
      ctx({ nonEscalateCountThisSweep: 3, maxNonEscalateActionsPerSite: 3 }),
    );
    expect(r.status).toBe("denied");
    expect(r.decisions.at(-1)!.policyId).toBe("rate_limit_per_site");
  });

  it("human_signature_required → user-approval for load_shift", () => {
    const r = evaluate(candidate(), ctx());
    expect(r.status).toBe("user-approval");
    expect(r.decisions.map((d) => d.policyId)).toEqual([
      "eligibility_required",
      "no_action_on_bad_data",
      "evidence_required",
      "rate_limit_per_site",
      "human_signature_required",
    ]);
    expect(r.decisions.at(-1)!.outcome).toBe("require_approval");
  });

  it("auto_class → approved for escalate", () => {
    const r = evaluate(candidate({ kind: "escalate" }), ctx());
    expect(r.status).toBe("approved");
    expect(r.decisions.at(-1)!.policyId).toBe("auto_class");
    expect(r.decisions.at(-1)!.outcome).toBe("allow");
  });

  it("toToolApprovalStatus maps denied / approved correctly", () => {
    const denied = evaluate(candidate(), ctx({ severity: "data_issue" }));
    const d = toToolApprovalStatus(denied);
    expect(d).toMatchObject({ type: "denied" });

    const ok = evaluate(candidate(), ctx());
    const a = toToolApprovalStatus(ok);
    expect(a).toMatchObject({ type: "approved" });
  });
});
