import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../data/store";
import { jsonError } from "../lib/http";
import { createSolarOpsService, SolarOpsError } from "../services/solarops";

const FIXED_NOW = "2026-06-22T09:00:00+08:00";

function svc() {
  return createSolarOpsService(new InMemoryStore());
}

describe("Green Performance Report (GPR)", () => {
  it("site_a (healthy) includes observed/expected kWh, RM value, CO2 kg, assumptions, fixture label", () => {
    const rep = svc().generateGreenPerformanceReport("site_a", FIXED_NOW);

    expect(rep.includes_provenance).toBe(true);
    expect(rep.includes_assumptions).toBe(true);
    expect(rep.format).toBe("markdown");
    expect(rep.content).toContain("Green Performance Report");
    expect(rep.content).toMatch(/Observed generation\s*\|\s*\*\*[\d.]+ kWh\*\*/);
    expect(rep.content).toMatch(/Weather-adjusted expected\s*\|\s*\*\*[\d.]+ kWh\*\*/);
    expect(rep.content).toMatch(/RM [\d.]+/);
    expect(rep.content).toMatch(/[\d.]+ kg CO₂e/);
    expect(rep.content).toContain("Assumptions");
    expect(rep.content).toContain("| Name | Value | Note |");
    expect(rep.content).toContain("fixture_data");
    expect(rep.content).toContain("solarops-baseline-v1");
    expect(rep.content).toContain(rep.report_id);
    // healthy path — no anomaly framing as primary status
    expect(rep.content).toMatch(/\*\*Status:\*\* healthy/);
  });

  it("site_b (anomalous) mentions the anomaly and its likely cause", () => {
    const rep = svc().generateGreenPerformanceReport("site_b", FIXED_NOW);

    expect(rep.content).toMatch(/\*\*Status:\*\* anomaly/);
    expect(rep.content).toContain("inverter or string underperformance");
    expect(rep.content).toContain("fixture_data");
    expect(rep.content).toContain("Assumptions");
  });

  it("determinism — two runs with the same injected now produce identical content", () => {
    const s = svc();
    const a = s.generateGreenPerformanceReport("site_a", FIXED_NOW);
    const b = s.generateGreenPerformanceReport("site_a", FIXED_NOW);
    expect(a.content).toBe(b.content);
    expect(a.report_id).toBe(b.report_id);
  });

  it("unknown site id throws at the service and maps to 404 via jsonError", async () => {
    const s = svc();
    expect(() => s.generateGreenPerformanceReport("site_zzz")).toThrowError(SolarOpsError);
    try {
      s.generateGreenPerformanceReport("site_zzz");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SolarOpsError);
      expect((err as SolarOpsError).code).toBe("site_not_found");
      // API route uses the same jsonError mapper for SolarOpsError
      const res = jsonError(err);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("site_not_found");
    }
  });
});
