import { beforeAll, describe, expect, it } from "vitest";
import { InMemoryStore } from "../data/store";
import { createSolarOpsService } from "../services/solarops";
import { classifyKey, validateAnswer } from "../agent/safety";

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
    // Numbers must match live tool outputs for site_b day-4 (24h fixtures; night zeros
    // leave residual kWh unchanged; RM uses site tariff 0.2983).
    const answer =
      "Site B observed 12,172.58 kWh versus an expected 13,681.21 kWh — an 11.0% shortfall. " +
      "Likely inverter 3 underperformance. Estimated recovery 21,724.27 kWh/month " +
      "(RM 6,480.35, 14,164.23 kg CO₂), subject to field verification.";
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
      "The tools show an 11.0% shortfall (12,172.58 vs 13,681.21 kWh); I recommend inspecting inverter 3.";
    const res = validateAnswer(answer, toolOutputs);
    expect(res.blockedPhrases).toHaveLength(0);
    expect(res.ok).toBe(true);
  });
});

describe("safety: unit-aware grounding pool (I2c / KREDIT)", () => {
  // Synthetic pool mirroring the live leak surface: counts, carbon factor rate, and
  // legit energy/currency fields. Keys intentionally match production DTO shapes.
  const leakyPool = [
    {
      observed_kwh: 12172.58,
      expected_kwh: 13681.21,
      residual_kwh: -1508.63,
      residual_pct: -0.1103,
      evidence: {
        persistentIntervals: 5, // must NOT ground "5,000 kWh" via ×1000
        validIntervals: 24, // must NOT ground "24,000 kWh" via ×1000
        missingIntervals: 1, // must NOT ground "1 kWh" (count class)
      },
      estimated_rm_value: 6480.35,
      estimated_co2_kg: 14164.23,
      // rate, not a mass total — must not ground kg claims via ×100 / ×1000
      carbonFactorKgco2PerKwh: 0.652,
      carbon_factor_kgco2_per_kwh: 0.652,
      tariff_rm_per_kwh: 0.2983,
      // unkeyed array elements stay unclassified (identity mult only for energy)
      bare: [0, 0.5, 2, 20],
    },
  ];

  describe("key classification", () => {
    it("tags energy / currency / mass / percent / count keys", () => {
      expect(classifyKey("expected_kwh")).toBe("energy");
      expect(classifyKey("expected_recovery_kwh_month")).toBe("energy");
      expect(classifyKey("carbon_factor_kgco2_per_kwh")).toBe("energy"); // kwh wins over carbon
      expect(classifyKey("carbonFactorKgco2PerKwh")).toBe("energy");
      expect(classifyKey("estimated_rm_value")).toBe("currency");
      expect(classifyKey("rm_at_risk")).toBe("currency");
      expect(classifyKey("estimated_co2_kg")).toBe("mass_co2");
      expect(classifyKey("residual_pct")).toBe("percent_ratio");
      expect(classifyKey("recoverable_fraction")).toBe("percent_ratio");
      expect(classifyKey("validIntervals")).toBe("count");
      expect(classifyKey("persistentIntervals")).toBe("count");
      expect(classifyKey("recurrence_days_per_month")).toBe("count");
      expect(classifyKey(null)).toBe("unclassified");
      expect(classifyKey("value")).toBe("unclassified");
    });
  });

  describe("required-failing probes (review live attacks)", () => {
    it("does not ground '5,000 kWh' via count 5 × 1000", () => {
      const res = validateAnswer("Generation was 5,000 kWh.", leakyPool);
      expect(res.grounded).toBe(false);
      expect(res.ungroundedClaims.some((c) => c.raw.includes("5,000"))).toBe(true);
    });

    it("does not ground '1 kWh' via bare 1", () => {
      const res = validateAnswer("Only 1 kWh was produced.", leakyPool);
      expect(res.grounded).toBe(false);
      expect(res.ungroundedClaims.some((c) => c.canonical === 1 && c.unit === "kwh")).toBe(true);
    });

    it("does not ground '24,000 kWh' via validIntervals 24 × 1000", () => {
      const res = validateAnswer("Expected 24,000 kWh for the window.", leakyPool);
      expect(res.grounded).toBe(false);
      expect(res.ungroundedClaims.some((c) => c.raw.includes("24,000"))).toBe(true);
    });

    it("does not ground '64.80 kg' via carbon factor 0.652 × 100", () => {
      const res = validateAnswer("Avoided 64.80 kg CO₂.", leakyPool);
      expect(res.grounded).toBe(false);
      expect(res.ungroundedClaims.some((c) => c.raw.includes("64.80"))).toBe(true);
    });

    it("does not ground '648.03 kg' via carbon factor 0.652 × 1000", () => {
      const res = validateAnswer("Avoided 648.03 kg CO₂.", leakyPool);
      expect(res.grounded).toBe(false);
      expect(res.ungroundedClaims.some((c) => c.raw.includes("648.03"))).toBe(true);
    });
  });

  describe("honest-answer regression", () => {
    it("grounds exact kWh claims against expected_kwh / observed_kwh", () => {
      const res = validateAnswer(
        "Observed 12,172.58 kWh versus expected 13,681.21 kWh.",
        leakyPool,
      );
      expect(res.grounded).toBe(true);
      expect(res.ungroundedClaims).toHaveLength(0);
    });

    it("grounds human-rounded kWh within 2% (F19: 12,173 vs 12172.58)", () => {
      const res = validateAnswer("Observed 12,173 kWh.", leakyPool);
      expect(res.grounded).toBe(true);
      expect(res.ungroundedClaims).toHaveLength(0);
    });

    it("grounds RM claims against *_rm currency fields only", () => {
      const res = validateAnswer("Estimated recovery value is RM 6,480.35.", leakyPool);
      expect(res.grounded).toBe(true);
    });

    it("grounds percent claims against residual_pct (fraction→percent)", () => {
      // residual_pct = -0.1103 → 11.03%; claim 11.0% within 2%
      const res = validateAnswer("Shortfall of 11.0%.", leakyPool);
      expect(res.grounded).toBe(true);
    });

    it("grounds percent claims when tool stores percent-scale residual_pct", () => {
      const pool = [{ residual_pct: 11.03 }];
      const res = validateAnswer("Shortfall of 11.0%.", pool);
      expect(res.grounded).toBe(true);
    });

    it("grounds MWh claims via kWh pool with unit conversion (13.68 MWh vs 13681.21 kWh)", () => {
      const res = validateAnswer("Expected about 13.68 MWh.", leakyPool);
      expect(res.grounded).toBe(true);
    });

    it("grounds kg claims against estimated_co2_kg, not the carbon factor", () => {
      const res = validateAnswer("Avoided 14,164.23 kg CO₂.", leakyPool);
      expect(res.grounded).toBe(true);
    });
  });
});
