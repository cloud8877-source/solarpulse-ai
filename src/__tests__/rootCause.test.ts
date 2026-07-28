import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../data/store";
import { detectUnderperformance } from "../engine/anomaly";
import { classifyRootCause } from "../engine/rootCause";

const store = new InMemoryStore();

/** Demo-day window (default asOfDate story). */
const DAY4 = {
  windowStart: "2026-06-21T00:00:00+08:00",
  windowEnd: "2026-06-21T23:59:59+08:00",
};

const cause = (id: string) => {
  const site = store.getSite(id)!;
  const anomaly = detectUnderperformance({
    site,
    observations: store.getObservations(id),
    weather: store.getWeather(id),
    ...DAY4,
  });
  return classifyRootCause({ anomaly, site });
};

describe("root-cause classifier (PDR-004 §4)", () => {
  it("Site B -> inverter/string underperformance (medium), cites inverter_3", () => {
    const c = cause("site_b");
    expect(c.likelyCause).toBe("inverter_or_string_underperformance");
    expect(c.confidence).toBe("medium");
    expect(c.evidence.join(" ")).toContain("inverter_3");
    expect(c.caveats.length).toBeGreaterThan(0);
  });

  it("Site C -> telemetry/data quality issue, not an equipment diagnosis (CE3)", () => {
    const c = cause("site_c");
    expect(c.likelyCause).toBe("telemetry_data_quality_issue");
    expect(c.evidence.join(" ").toLowerCase()).toMatch(/missing|noisy|telemetry/);
  });
});
