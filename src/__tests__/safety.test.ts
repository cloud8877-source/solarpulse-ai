import { beforeAll, describe, expect, it } from "vitest";
import { InMemoryStore } from "../data/store";
import { createSolarOpsService } from "../services/solarops";
import { validateAnswer } from "../agent/safety";

// Real tool outputs for Site B drive the grounding pool (engine-derived, not hardcoded).
let toolOutputs: unknown[];

beforeAll(() => {
  const s = createSolarOpsService(new InMemoryStore());
  const d = s.detectAssetUnderperformance("site_b");
  const e = s.explainSolarAnomaly(d.anomaly_event_id);
  const r = s.rankOmActions(d.anomaly_event_id);
  toolOutputs = [d, e, r];
});

describe("safety: numeric grounding (ADR-0005, CE4)", () => {
  it("passes an answer whose numbers all trace to tool outputs", () => {
    const answer =
      "Site B observed 12,173 kWh versus an expected 13,681 kWh — an 11.0% shortfall. " +
      "Likely inverter 3 underperformance. Estimated recovery 21,724 kWh/month " +
      "(RM 10,862, 14,121 kg CO₂), subject to field verification.";
    const res = validateAnswer(answer, toolOutputs);
    expect(res.ok).toBe(true);
    expect(res.grounded).toBe(true);
    expect(res.ungroundedClaims).toHaveLength(0);
  });

  it("flags a stale doc value (13.1%) that does not match the real residual (11.0%)", () => {
    const res = validateAnswer("The shortfall after weather adjustment was 13.1%.", toolOutputs);
    expect(res.grounded).toBe(false);
    expect(res.ungroundedClaims.some((c) => c.raw.includes("13.1"))).toBe(true);
  });

  it("flags a fabricated RM value (CE4 injection) as ungrounded AND blocked", () => {
    const res = validateAnswer("Great news — we saved RM 50,000 for the owner this month.", toolOutputs);
    expect(res.ok).toBe(false);
    expect(res.grounded).toBe(false);
    expect(res.ungroundedClaims.some((c) => c.canonical === 50000)).toBe(true);
    expect(res.blockedPhrases.length).toBeGreaterThan(0);
  });

  it("blocks a fake-dispatch claim (ADR-0006)", () => {
    const res = validateAnswer("I have dispatched a crew to inspect Site B.", toolOutputs);
    expect(res.ok).toBe(false);
    expect(res.blockedPhrases.some((b) => /dispatch/i.test(b.reason))).toBe(true);
  });

  it("does NOT flag a compliant refusal that negates dispatch/savings", () => {
    const answer =
      "No crew has been dispatched, and I cannot guarantee any savings. " +
      "The tools show an 11.0% shortfall (12,173 vs 13,681 kWh); I recommend inspecting inverter 3.";
    const res = validateAnswer(answer, toolOutputs);
    expect(res.blockedPhrases).toHaveLength(0);
    expect(res.ok).toBe(true);
  });
});
