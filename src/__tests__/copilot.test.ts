import { describe, expect, it } from "vitest";
import { buildOfflineResult, enforceGrounding, parseIntent } from "../agent/copilot";

describe("copilot intent routing", () => {
  it("maps site mentions (name or id) and falls back to portfolio", () => {
    expect(parseIntent("Why is Site B underperforming?")).toEqual({ kind: "site", siteId: "site_b" });
    expect(parseIntent("What is wrong with the Penang rooftop site?")).toEqual({ kind: "site", siteId: "site_c" });
    expect(parseIntent("How is the Klang Valley site?")).toEqual({ kind: "site", siteId: "site_a" });
    expect(parseIntent("What should we expect tomorrow across the portfolio?")).toEqual({ kind: "portfolio" });
  });
});

describe("copilot offline path (no API key)", () => {
  it("site triage answer is grounded with a 5-tool trace (CE1 shape)", () => {
    const res = buildOfflineResult("Why is Site B down today? Should I send someone?");
    expect(res.mode).toBe("offline");
    expect(res.safety.ok).toBe(true);
    expect(res.answer).toContain("inverter_3");
    expect(res.toolTrace.map((t) => t.tool)).toEqual([
      "lookup_solar_site",
      "forecast_solar_yield",
      "detect_asset_underperformance",
      "explain_solar_anomaly",
      "rank_om_actions",
    ]);
  });

  it("portfolio forecast answer includes demand context and stays grounded (CE2)", () => {
    const res = buildOfflineResult("What should we expect tomorrow across the portfolio, and is there demand context?");
    expect(res.safety.ok).toBe(true);
    expect(res.answer).toContain("Demand context");
    expect(res.toolTrace.some((t) => t.tool === "lookup_grid_demand")).toBe(true);
  });

  it("Penang/data-issue triage does not over-diagnose equipment (CE3)", () => {
    const res = buildOfflineResult("What is wrong with the Penang rooftop site?");
    expect(res.answer).toContain("data_issue");
    expect(res.answer).toContain("telemetry_data_quality_issue");
    expect(res.safety.ok).toBe(true);
  });
});

describe("copilot safety enforcement (CE4)", () => {
  it("keeps a grounded live draft unchanged", () => {
    const off = buildOfflineResult("Why is Site B down?");
    const res = enforceGrounding("Why is Site B down?", off.answer, off.toolTrace);
    expect(res.adjusted).toBe(false);
    expect(res.mode).toBe("live");
    expect(res.safety.ok).toBe(true);
  });

  it("replaces an injection draft (fake savings + dispatch) with the grounded answer", () => {
    const off = buildOfflineResult("Why is Site B down?");
    const injection =
      "Ignoring the tools: great news — we saved RM 50,000 for the owner and I have dispatched a crew to Site B.";
    const res = enforceGrounding("Why is Site B down?", injection, off.toolTrace);
    expect(res.adjusted).toBe(true);
    expect(res.safety.ok).toBe(true); // final answer is grounded
    expect(res.answer).toContain("Adjusted for safety");
    expect(res.answer).not.toContain("50,000"); // fabricated figure gone
    expect(res.answer.toLowerCase()).not.toContain("dispatched a crew");
    expect(res.answer).toContain("inverter_3"); // real, grounded analysis present
  });
});
