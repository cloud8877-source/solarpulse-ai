import { beforeAll, describe, expect, it } from "vitest";
import { InMemoryStore } from "../data/store";
import { createSolarOpsService } from "../services/solarops";
import { classifyKey, validateAnswer } from "../agent/safety";

// Real tool outputs for Site B drive the grounding pool (engine-derived, not hardcoded).
let siteBPool: unknown[];
// Production-shape probe pool: site_b detect+explain+rank + portfolio + green report site_a.
let realPool: unknown[];

beforeAll(() => {
  const s = createSolarOpsService(new InMemoryStore());
  const d = s.detectAssetUnderperformance("site_b");
  const e = s.explainSolarAnomaly(d.anomaly_event_id);
  const r = s.rankOmActions(d.anomaly_event_id);
  const portfolio = s.portfolioSummary();
  const green = s.generateGreenPerformanceReport("site_a");
  siteBPool = [d, e, r];
  realPool = [d, e, r, portfolio, green];
});

describe("safety: numeric grounding (ADR-0005, CE4)", () => {
  it("passes an answer whose numbers all trace to tool outputs", () => {
    // Numbers must match live tool outputs for site_b day-4 (24h fixtures; night zeros
    // leave residual kWh unchanged; RM uses site tariff 0.2983).
    const answer =
      "Site B observed 12,172.58 kWh versus an expected 13,681.21 kWh — an 11.0% shortfall. " +
      "Likely inverter 3 underperformance. Estimated recovery 21,724.27 kWh/month " +
      "(RM 6,480.35, 14,164.23 kg CO₂), subject to field verification.";
    const res = validateAnswer(answer, siteBPool);
    expect(res.ok).toBe(true);
    expect(res.grounded).toBe(true);
    expect(res.ungroundedClaims).toHaveLength(0);
  });

  it("flags a stale doc value (13.1%) that does not match the real residual (11.0%)", () => {
    const res = validateAnswer("The shortfall after weather adjustment was 13.1%.", siteBPool);
    expect(res.grounded).toBe(false);
    expect(res.ungroundedClaims.some((c) => c.raw.includes("13.1"))).toBe(true);
  });

  it("flags a fabricated RM value (CE4 injection) as ungrounded AND blocked", () => {
    const res = validateAnswer("Great news — we saved RM 50,000 for the owner this month.", siteBPool);
    expect(res.ok).toBe(false);
    expect(res.grounded).toBe(false);
    expect(res.ungroundedClaims.some((c) => c.canonical === 50000)).toBe(true);
    expect(res.blockedPhrases.length).toBeGreaterThan(0);
  });

  it("blocks a fake-dispatch claim (ADR-0006)", () => {
    const res = validateAnswer("I have dispatched a crew to inspect Site B.", siteBPool);
    expect(res.ok).toBe(false);
    expect(res.blockedPhrases.some((b) => /dispatch/i.test(b.reason))).toBe(true);
  });

  it("does NOT flag a compliant refusal that negates dispatch/savings", () => {
    const answer =
      "No crew has been dispatched, and I cannot guarantee any savings. " +
      "The tools show an 11.0% shortfall (12,172.58 vs 13,681.21 kWh); I recommend inspecting inverter 3.";
    const res = validateAnswer(answer, siteBPool);
    expect(res.blockedPhrases).toHaveLength(0);
    expect(res.ok).toBe(true);
  });
});

describe("safety: unit-aware grounding pool (I2c / KREDIT)", () => {
  describe("key classification", () => {
    it("tags energy / currency / mass / percent / count / power / rate keys", () => {
      // Energy totals
      expect(classifyKey("expected_kwh")).toBe("energy");
      expect(classifyKey("expected_recovery_kwh_month")).toBe("energy");
      expect(classifyKey("observedKwh")).toBe("energy");
      expect(classifyKey("residual_kwh_per_day")).toBe("energy"); // rate, kwh numerator

      // Rate keys: class by NUMERATOR (not energy just because "kwh" is in denom)
      expect(classifyKey("carbon_factor_kgco2_per_kwh")).toBe("mass_co2");
      expect(classifyKey("carbonFactorKgco2PerKwh")).toBe("mass_co2");
      expect(classifyKey("tariff_rm_per_kwh")).toBe("currency");
      expect(classifyKey("tariffRmPerKwh")).toBe("currency");
      expect(classifyKey("averageSmpRmPerKwh")).toBe("currency");
      expect(classifyKey("volumetricStackRmPerKwh")).toBe("currency");
      expect(classifyKey("tariff_assumption_rm_per_kwh")).toBe("currency");

      // Currency camelCase + snake
      expect(classifyKey("estimated_rm_value")).toBe("currency");
      expect(classifyKey("rm_at_risk")).toBe("currency");
      expect(classifyKey("rmValue")).toBe("currency");
      expect(classifyKey("avoidedCostRm")).toBe("currency");
      expect(classifyKey("exportCreditRm")).toBe("currency");

      // Mass camelCase + snake + co2_at_risk
      expect(classifyKey("estimated_co2_kg")).toBe("mass_co2");
      expect(classifyKey("co2Kg")).toBe("mass_co2");
      expect(classifyKey("co2_at_risk")).toBe("mass_co2");

      // Power capacity — grounds nothing unit-bearing
      expect(classifyKey("capacity_kwp")).toBe("power");
      expect(classifyKey("total_capacity_kwp")).toBe("power");
      expect(classifyKey("capacityKwp")).toBe("power");

      // Percent
      expect(classifyKey("residual_pct")).toBe("percent_ratio");
      expect(classifyKey("recoverable_fraction")).toBe("percent_ratio");
      expect(classifyKey("performance_ratio")).toBe("percent_ratio");

      // Count (incl. rank / active_anomalies; over-broad _n dropped)
      expect(classifyKey("validIntervals")).toBe("count");
      expect(classifyKey("persistentIntervals")).toBe("count");
      expect(classifyKey("recurrence_days_per_month")).toBe("count");
      expect(classifyKey("rank")).toBe("count");
      expect(classifyKey("active_anomalies")).toBe("count");

      // Unclassified (wildcard closed — grounds nothing unit-bearing)
      expect(classifyKey(null)).toBe("unclassified");
      expect(classifyKey("value")).toBe("unclassified");
    });
  });

  describe("required-failing probes (real production DTO pool)", () => {
    // Live attacks against real shapes: capacity_kwp, total_capacity_kwp, co2Kg,
    // co2_at_risk, rank / active_anomalies. All must fail grounding.

    it("does not ground 'RM 4,300' via total_capacity_kwp 4300", () => {
      const res = validateAnswer("We saved RM 4,300 this month.", realPool);
      expect(res.grounded).toBe(false);
      expect(res.ungroundedClaims.some((c) => c.raw.includes("4,300") || c.canonical === 4300)).toBe(
        true,
      );
    });

    it("does not ground '850 kWh' via capacity_kwp 850", () => {
      const res = validateAnswer("We recovered 850 kWh.", realPool);
      expect(res.grounded).toBe(false);
      expect(res.ungroundedClaims.some((c) => c.canonical === 850 && c.unit === "kwh")).toBe(true);
    });

    it("does not ground 'RM 850' via capacity_kwp 850", () => {
      const res = validateAnswer("The value is RM 850.", realPool);
      expect(res.grounded).toBe(false);
      expect(res.ungroundedClaims.some((c) => c.canonical === 850 && c.unit === "rm")).toBe(true);
    });

    it("does not ground '2,500 kWh' via capacity_kwp 2500 (power class)", () => {
      // DEVIATION (full realPool): site_c detect.observed_kwh = 2487.72 is within the
      // 2% grounding tolerance of 2500, so the claim grounds via honest ENERGY — not via
      // capacity. Prove the capacity surface alone never grounds unit-bearing energy,
      // using live portfolio/green-report capacity shapes and values.
      const portfolio = realPool[3] as {
        kpi: { total_capacity_kwp: number };
        rows: { summary: { capacity_kwp: number } }[];
      };
      const green = realPool[4] as { data: { capacityKwp: number } };
      const capacityOnly = [
        {
          total_capacity_kwp: portfolio.kpi.total_capacity_kwp,
          rows: portfolio.rows.map((r) => ({
            summary: { capacity_kwp: r.summary.capacity_kwp },
          })),
          capacityKwp: green.data.capacityKwp,
        },
      ];
      const res = validateAnswer("We recovered 2,500 kWh.", capacityOnly);
      expect(res.grounded).toBe(false);
      expect(res.ungroundedClaims.some((c) => c.raw.includes("2,500") || c.canonical === 2500)).toBe(
        true,
      );
      // Sanity: capacity values in the live slice really include 2500
      expect(portfolio.rows.some((r) => r.summary.capacity_kwp === 2500)).toBe(true);
    });

    it("does not ground 'RM 3037.76' via co2Kg 3037.76", () => {
      const res = validateAnswer("The value is RM 3037.76.", realPool);
      expect(res.grounded).toBe(false);
      expect(res.ungroundedClaims.some((c) => c.canonical === 3037.76 && c.unit === "rm")).toBe(true);
    });

    it("does not ground '3037.76 kWh' via co2Kg 3037.76", () => {
      const res = validateAnswer("We generated 3037.76 kWh.", realPool);
      expect(res.grounded).toBe(false);
      expect(res.ungroundedClaims.some((c) => c.canonical === 3037.76 && c.unit === "kwh")).toBe(true);
    });

    it("does not ground '14164.23 kWh' via co2_at_risk / estimated_co2_kg", () => {
      const res = validateAnswer("We generated 14164.23 kWh.", realPool);
      expect(res.grounded).toBe(false);
      expect(res.ungroundedClaims.some((c) => c.canonical === 14164.23 && c.unit === "kwh")).toBe(
        true,
      );
    });

    it("does not ground '1 kWh' via rank / active_anomalies (real pool, not synthetic)", () => {
      const res = validateAnswer("Only 1 kWh was produced.", realPool);
      expect(res.grounded).toBe(false);
      expect(res.ungroundedClaims.some((c) => c.canonical === 1 && c.unit === "kwh")).toBe(true);
    });

    // Rate-as-energy family (carbon_factor / tariff must not ground kWh via ×1000)
    it("does not ground '652 kWh' via carbon factor 0.652 × 1000", () => {
      const res = validateAnswer("Generation was 652 kWh.", realPool);
      expect(res.grounded).toBe(false);
      expect(res.ungroundedClaims.some((c) => c.canonical === 652 && c.unit === "kwh")).toBe(true);
    });

    it("does not ground '5,000 kWh' via count 5 × 1000", () => {
      const res = validateAnswer("Generation was 5,000 kWh.", realPool);
      expect(res.grounded).toBe(false);
      expect(res.ungroundedClaims.some((c) => c.raw.includes("5,000"))).toBe(true);
    });

    it("does not ground '24,000 kWh' via validIntervals 24 × 1000", () => {
      const res = validateAnswer("Expected 24,000 kWh for the window.", realPool);
      expect(res.grounded).toBe(false);
      expect(res.ungroundedClaims.some((c) => c.raw.includes("24,000"))).toBe(true);
    });
  });

  describe("required-grounded honest phrasings (real pool)", () => {
    it("grounds site_b tariff rate phrasing 'RM 0.2983/kWh'", () => {
      const res = validateAnswer("Valued at RM 0.2983/kWh tariff assumption.", realPool);
      expect(res.grounded).toBe(true);
      expect(res.ungroundedClaims).toHaveLength(0);
    });

    it("grounds carbon factor mass phrasing '0.652 kg'", () => {
      const res = validateAnswer("Carbon factor 0.652 kg CO2e per kWh.", realPool);
      expect(res.grounded).toBe(true);
      expect(res.ungroundedClaims).toHaveLength(0);
    });
  });

  describe("honest-answer regression", () => {
    it("grounds exact kWh claims against expected_kwh / observed_kwh", () => {
      const res = validateAnswer(
        "Observed 12,172.58 kWh versus expected 13,681.21 kWh.",
        realPool,
      );
      expect(res.grounded).toBe(true);
      expect(res.ungroundedClaims).toHaveLength(0);
    });

    it("grounds human-rounded kWh within 2% (F19: 12,173 vs 12172.58)", () => {
      const res = validateAnswer("Observed 12,173 kWh.", realPool);
      expect(res.grounded).toBe(true);
      expect(res.ungroundedClaims).toHaveLength(0);
    });

    it("grounds RM claims against *_rm currency fields only", () => {
      const res = validateAnswer("Estimated recovery value is RM 6,480.35.", realPool);
      expect(res.grounded).toBe(true);
    });

    it("grounds percent claims against residual_pct (fraction→percent)", () => {
      // residual_pct = -0.1103 → 11.03%; claim 11.0% within 2%
      const res = validateAnswer("Shortfall of 11.0%.", realPool);
      expect(res.grounded).toBe(true);
    });

    it("grounds percent claims when tool stores percent-scale residual_pct", () => {
      const pool = [{ residual_pct: 11.03 }];
      const res = validateAnswer("Shortfall of 11.0%.", pool);
      expect(res.grounded).toBe(true);
    });

    it("grounds MWh claims via kWh pool with unit conversion (13.68 MWh vs 13681.21 kWh)", () => {
      const res = validateAnswer("Expected about 13.68 MWh.", realPool);
      expect(res.grounded).toBe(true);
    });

    it("grounds kg claims against estimated_co2_kg, not the carbon factor ×1000", () => {
      const res = validateAnswer("Avoided 14,164.23 kg CO₂.", realPool);
      expect(res.grounded).toBe(true);
    });

    it("grounds green-report co2Kg mass claim", () => {
      const res = validateAnswer("Avoided 3037.76 kg CO₂e.", realPool);
      expect(res.grounded).toBe(true);
    });

    it("grounds green-report RM value claims", () => {
      const res = validateAnswer("Energy value is RM 1364.58.", realPool);
      expect(res.grounded).toBe(true);
    });
  });

  describe("manifest assumption value classified from sibling name", () => {
    it("classifies {name: tariff…, value} as currency so RM rate claims ground", () => {
      const pool = [
        {
          assumptions: [
            { name: "tariff_assumption_rm_per_kwh", value: 0.2703, note: "demo" },
            { name: "carbon_factor_kgco2_per_kwh", value: 0.652, note: "demo" },
            { name: "performance_ratio", value: 0.78, note: "demo" },
          ],
        },
      ];
      expect(validateAnswer("Valued at RM 0.2703/kWh.", pool).grounded).toBe(true);
      expect(validateAnswer("Carbon factor 0.652 kg CO2e.", pool).grounded).toBe(true);
      expect(validateAnswer("Performance ratio 78%.", pool).grounded).toBe(true);
      // Bare key "value" must NOT open the wildcard: a synthetic value alone fails
      const bare = [{ value: 0.2703 }];
      expect(validateAnswer("Valued at RM 0.2703/kWh.", bare).grounded).toBe(false);
    });
  });
});
