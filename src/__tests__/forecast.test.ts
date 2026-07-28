import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../data/store";
import { forecastSolarYield } from "../engine/forecast";

const store = new InMemoryStore();

const DAY4 = "2026-06-21";
const daySlice = <T extends { timestamp: string }>(rows: T[]) =>
  rows.filter((r) => r.timestamp.startsWith(DAY4));

describe("forecast baseline (PDR-004 §2)", () => {
  it("returns a plausible expected range + confidence band + metric for healthy Site A", () => {
    const site = store.getSite("site_a")!;
    const f = forecastSolarYield({
      site,
      weather: daySlice(store.getWeather("site_a")),
      observations: daySlice(store.getObservations("site_a")),
      horizon: "day_ahead",
      runAt: "2026-06-22T08:00:00+08:00",
    });

    // capacity 850 kWp × per-kWp daily ≈ 5.47 kWh → ≈ 4650 kWh
    expect(f.expectedKwh).toBeGreaterThan(4400);
    expect(f.expectedKwh).toBeLessThan(4900);
    expect(f.lowerKwh).toBeLessThan(f.expectedKwh);
    expect(f.upperKwh).toBeGreaterThan(f.expectedKwh);
    expect(f.modelVersion).toBe("solarops-baseline-v1");
    expect(f.metric.name).toBe("fixture_wape");
    // a healthy site tracks the baseline within a few percent
    expect(f.metric.value).toBeGreaterThanOrEqual(0);
    expect(f.metric.value).toBeLessThan(0.05);
    expect(f.qualityFlags).toContain("fixture_data");
    expect(f.intervals.length).toBe(24);
  });

  it("never reports a silent 0 (perfect) WAPE for an unmeasurable site (Site C)", () => {
    const site = store.getSite("site_c")!;
    const base = {
      site,
      weather: daySlice(store.getWeather("site_c")),
      observations: daySlice(store.getObservations("site_c")),
      horizon: "day_ahead" as const,
      runAt: "2026-06-22T08:00:00+08:00",
    };

    // No clean intervals + no reference -> metric is explicitly unavailable, not 0.
    const noRef = forecastSolarYield(base);
    expect(noRef.metric.value).toBeNull();
    expect(noRef.qualityFlags).toContain("metric_unavailable");

    // With a model reference WAPE -> reports it, flagged as borrowed (honest).
    const withRef = forecastSolarYield({ ...base, referenceWape: 0.0187 });
    expect(withRef.metric.value).toBeCloseTo(0.0187, 4);
    expect(withRef.qualityFlags).toContain("metric_from_reference");
  });
});
