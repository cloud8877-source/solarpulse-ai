import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../data/store";
import { detectUnderperformance } from "../engine/anomaly";

const store = new InMemoryStore();

/** Demo-day window (default asOfDate story). */
const DAY4 = {
  windowStart: "2026-06-21T00:00:00+08:00",
  windowEnd: "2026-06-21T23:59:59+08:00",
};

const detect = (id: string, window?: { windowStart: string; windowEnd: string }) =>
  detectUnderperformance({
    site: store.getSite(id)!,
    observations: store.getObservations(id),
    weather: store.getWeather(id),
    ...(window ?? DAY4),
  });

describe("anomaly detector (PDR-004 §3)", () => {
  it("Site A is healthy (observed ≈ expected)", () => {
    const a = detect("site_a");
    expect(a.severity).toBe("healthy");
    expect(a.residualPct).toBeGreaterThan(-0.05);
  });

  it("Site B is an anomaly: weather-normal, persistent, inverter_3 signal", () => {
    const a = detect("site_b");
    expect(a.severity).toBe("anomaly");
    expect(a.residualPct).toBeLessThan(-0.1);
    expect(a.residualPct).toBeGreaterThan(-0.2);
    expect(a.residualKwh).toBeLessThan(0);
    expect(a.evidence.weatherNormal).toBe(true);
    expect(a.evidence.persistentIntervals).toBeGreaterThanOrEqual(2);
    expect(a.evidence.inverterSignal ?? "").toContain("inverter_3");
  });

  it("Site C is a data_issue (missing/noisy), NOT critical — missing never summed as zero", () => {
    const a = detect("site_c");
    expect(a.severity).toBe("data_issue");
    expect(a.evidence.missingIntervals).toBeGreaterThanOrEqual(3);
    expect(a.qualityFlags).toContain("missing_generation");
    // residual over VALID intervals only stays mild — proving missing wasn't counted as zero
    expect(a.residualPct).toBeGreaterThan(-0.2);
  });

  it("day-scoped severities: site_b degrades; site_c day4 is data_issue", () => {
    const day = (d: string) => ({
      windowStart: `${d}T00:00:00+08:00`,
      windowEnd: `${d}T23:59:59+08:00`,
    });

    expect(detect("site_b", day("2026-06-18")).severity).toBe("healthy");
    expect(detect("site_b", day("2026-06-19")).severity).toBe("watch");
    expect(detect("site_b", day("2026-06-20")).severity).toBe("anomaly");
    expect(detect("site_b", day("2026-06-21")).severity).toBe("anomaly");

    expect(detect("site_c", day("2026-06-18")).severity).toBe("healthy");
    expect(detect("site_c", day("2026-06-19")).severity).toBe("healthy");
    expect(detect("site_c", day("2026-06-20")).severity).toBe("data_issue");
    expect(detect("site_c", day("2026-06-21")).severity).toBe("data_issue");
  });
});
