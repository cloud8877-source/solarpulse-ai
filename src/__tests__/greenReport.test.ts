import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../data/store";
import { jsonError } from "../lib/http";
import { createSolarOpsService, SolarOpsError } from "../services/solarops";

const FIXED_NOW = "2026-06-22T09:00:00+08:00";

function svc() {
  return createSolarOpsService(new InMemoryStore());
}

describe("Green Performance Report (GPR)", () => {
  it("site_a (healthy) asserts literal RM / CO2 / performance index and fixture provenance", () => {
    const rep = svc().generateGreenPerformanceReport("site_a", FIXED_NOW);

    expect(rep.includes_provenance).toBe(true);
    expect(rep.includes_assumptions).toBe(true);
    expect(rep.format).toBe("markdown");
    expect(rep.content).toContain("Green Performance Report");
    expect(rep.content).toContain("| Observed generation | **4659.14 kWh** |");
    expect(rep.content).toContain("| Weather-adjusted expected | **4651.61 kWh** |");
    expect(rep.content).toContain(
      "| Performance index (observed / expected) | **100.2%** |",
    );
    // Literal financial / carbon figures (must catch a broken calculation).
    // 4659.14 kWh × 0.2703 RM/kWh = 1259.365542 → 1259.37
    expect(rep.content).toContain("**RM 1259.37**");
    // 4659.14 kWh × 0.652 kgCO₂e/kWh = 3037.75928 → 3037.76
    expect(rep.content).toContain("**3037.76 kg CO₂e**");
    expect(rep.content).toContain("Assumptions");
    expect(rep.content).toContain("| Name | Value | Note |");
    expect(rep.content).toContain("fixture_data");
    expect(rep.content).toContain("solarops-baseline-v1");
    expect(rep.content).toContain(rep.report_id);
    expect(rep.content).toMatch(/\*\*Status:\*\* healthy/);
    // Structured data mirrors the same numbers for the JSX page.
    expect(rep.data.production.observedKwh).toBe(4659.14);
    expect(rep.data.production.expectedKwh).toBe(4651.61);
    expect(rep.data.production.performanceIndexDisplay).toBe("100.2%");
    expect(rep.data.value.rmValue).toBe(1259.37); // 4659.14 kWh × 0.2703
    expect(rep.data.value.co2Kg).toBe(3037.76); // 4659.14 kWh × 0.652
    expect(rep.data.incidents.severity).toBe("healthy");
  });

  it("site_b (anomalous) mentions the anomaly and its likely cause", () => {
    const rep = svc().generateGreenPerformanceReport("site_b", FIXED_NOW);

    expect(rep.content).toMatch(/\*\*Status:\*\* anomaly/);
    expect(rep.content).toContain("inverter or string underperformance");
    expect(rep.content).toContain("fixture_data");
    expect(rep.content).toContain("Assumptions");
    expect(rep.data.incidents.severity).toBe("anomaly");
    expect(rep.data.incidents.causePlain).toBe("inverter or string underperformance");
    expect(rep.data.incidents.evidence.length).toBeGreaterThan(0);
  });

  it("site_c (data_issue) states interval coverage, evidence lines, and does not present period totals", () => {
    const rep = svc().generateGreenPerformanceReport("site_c", FIXED_NOW);

    expect(rep.content).toMatch(/\*\*Status:\*\* data_issue/);
    expect(rep.data.incidents.severity).toBe("data_issue");
    // Interval coverage caveat next to observed figure (20 of 24 valid — 4 missing daylight of 24h).
    expect(rep.content).toContain("based on 20 of 24 valid intervals");
    expect(rep.data.production.coverageNote).toBe("based on 20 of 24 valid intervals");
    // Evidence lines from root cause (symmetric with anomalous branch).
    expect(rep.content).toContain("Evidence:");
    expect(rep.data.incidents.evidence.length).toBeGreaterThan(0);
    for (const line of rep.data.incidents.evidence) {
      expect(rep.content).toContain(line);
    }
    expect(rep.content).toContain(
      "No equipment fault is confirmed while telemetry quality is insufficient.",
    );
    expect(rep.content).toContain("telemetry / data-quality issue");
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
