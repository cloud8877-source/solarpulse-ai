import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../data/store";
import { detectUnderperformance } from "../engine/anomaly";
import { rankActions } from "../engine/recommend";
import { classifyRootCause } from "../engine/rootCause";

const store = new InMemoryStore();

/** Demo-day window (default asOfDate story). */
const DAY4 = {
  windowStart: "2026-06-21T00:00:00+08:00",
  windowEnd: "2026-06-21T23:59:59+08:00",
};

const recommend = (id: string) => {
  const site = store.getSite(id)!;
  const anomaly = detectUnderperformance({
    site,
    observations: store.getObservations(id),
    weather: store.getWeather(id),
    ...DAY4,
  });
  const rootCause = classifyRootCause({ anomaly, site });
  return rankActions({ anomaly, rootCause, site });
};

describe("recommendation ranker (PDR-004 §5, US-005)", () => {
  it("Site B: ≥2 ranked actions, top names inverter_3, full impact + assumptions returned", () => {
    const recs = recommend("site_b");
    expect(recs.length).toBeGreaterThanOrEqual(2);
    expect(recs[0]!.rank).toBe(1);
    expect(recs[0]!.action).toContain("inverter_3");
    expect(recs[0]!.expectedRecoveryKwhMonth).toBeGreaterThan(0);
    expect(recs[0]!.estimatedRmValue).toBeGreaterThan(0);
    expect(recs[0]!.estimatedCo2Kg).toBeGreaterThan(0);

    const a = recs[0]!.assumptions;
    expect(a).toHaveProperty("tariff_rm_per_kwh");
    expect(a).toHaveProperty("carbon_factor_kgco2_per_kwh");
    expect(a).toHaveProperty("recoverable_fraction");
    expect(a).toHaveProperty("recurrence_days_per_month");
    expect(a).toHaveProperty("residual_kwh_per_day");
  });

  it("Site C (data issue): low confidence, steers to data/telemetry review, zero credited recovery", () => {
    const recs = recommend("site_c");
    expect(recs.length).toBeGreaterThanOrEqual(2);
    expect(recs[0]!.confidence).toBe("low");
    expect(recs[0]!.action.toLowerCase()).toMatch(/data|telemetry|review/);
    expect(recs[0]!.expectedRecoveryKwhMonth).toBe(0);
  });
});
