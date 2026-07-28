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
    // F3 ATAP-eligible valuation: selfConsumed × LV stack + export × SMP
    // day-4 site_a: selfConsumed 1520 kWh × 0.5068 = 770.336 → 770.34 (avoided cost)
    //               exported 3139.14 kWh × 0.1893 = 594.239202 → 594.24 (export credit)
    //               total = 770.34 + 594.24 = 1364.58
    expect(rep.content).toContain("**RM 1364.58**");
    expect(rep.content).toContain("avoided cost");
    expect(rep.content).toContain("export credit");
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
    expect(rep.data.value.rmValue).toBe(1364.58);
    expect(rep.data.value.valuationMode).toBe("atap_stack");
    expect(rep.data.value.avoidedCostRm).toBe(770.34); // 1520 × 0.5068
    expect(rep.data.value.exportCreditRm).toBe(594.24); // 3139.14 × 0.1893
    expect(rep.data.value.co2Kg).toBe(3037.76); // 4659.14 kWh × 0.652
    expect(rep.data.incidents.severity).toBe("healthy");
  });

  it("site_b (anomalous, ATAP-ineligible) keeps single-rate valuation and mentions anomaly", () => {
    const rep = svc().generateGreenPerformanceReport("site_b", FIXED_NOW);

    expect(rep.content).toMatch(/\*\*Status:\*\* anomaly/);
    expect(rep.content).toContain("inverter or string underperformance");
    expect(rep.content).toContain("fixture_data");
    expect(rep.content).toContain("Assumptions");
    expect(rep.data.incidents.severity).toBe("anomaly");
    expect(rep.data.incidents.causePlain).toBe("inverter or string underperformance");
    expect(rep.data.incidents.evidence.length).toBeGreaterThan(0);
    // Ineligible → single-rate (site tariff 0.2983), not stack+SMP.
    expect(rep.data.value.valuationMode).toBe("single_rate");
    expect(rep.content).toContain("tariff assumption");
  });

  it("site_c (data_issue) states measurable-interval coverage, evidence lines, and does not present period totals", () => {
    const rep = svc().generateGreenPerformanceReport("site_c", FIXED_NOW);

    expect(rep.content).toMatch(/\*\*Status:\*\* data_issue/);
    expect(rep.data.incidents.severity).toBe("data_issue");
    // F15: denominator = intervals with expected generation > 0 (daylight ~11),
    // not the full 24h window. 4 missing daylight → 7 of ~11 measurable.
    expect(rep.content).toContain("based on 7 of ~11 measurable intervals");
    expect(rep.data.production.coverageNote).toBe("based on 7 of ~11 measurable intervals");
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
