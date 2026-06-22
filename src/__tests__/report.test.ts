import { describe, expect, it } from "vitest";
import { buildSourceManifest, FIXTURE_INPUTS } from "../data/sourceManifest";
import { InMemoryStore } from "../data/store";
import { detectUnderperformance } from "../engine/anomaly";
import { generateReport } from "../engine/report";
import { rankActions } from "../engine/recommend";
import { classifyRootCause } from "../engine/rootCause";

const store = new InMemoryStore();

describe("report generator (PDR-006 §4, PDR-007 provenance)", () => {
  it("Site B report includes manifest, assumptions, model version, and fixture label", () => {
    const site = store.getSite("site_b")!;
    const anomaly = detectUnderperformance({
      site,
      observations: store.getObservations("site_b"),
      weather: store.getWeather("site_b"),
    });
    const rootCause = classifyRootCause({ anomaly, site });
    const recommendations = rankActions({ anomaly, rootCause, site });
    const manifest = buildSourceManifest({
      runId: "report_site_b_test",
      inputs: [
        FIXTURE_INPUTS.solar_observations!,
        FIXTURE_INPUTS.weather_observations!,
        FIXTURE_INPUTS.grid_demand!,
      ],
      now: "2026-06-22T09:00:00+08:00",
    });

    const report = generateReport({
      site,
      anomaly,
      rootCause,
      recommendations,
      manifest,
      reportId: "report_site_b_test",
      now: "2026-06-22T09:00:00+08:00",
    });

    expect(report.includesProvenance).toBe(true);
    expect(report.includesAssumptions).toBe(true);
    expect(report.content).toContain("Source Provenance");
    expect(report.content).toContain("report_site_b_test"); // manifest run id
    expect(report.content).toContain("tariff_rm_per_kwh"); // action assumptions
    expect(report.content).toContain("fixture_data"); // fixture labeled
    expect(report.content).toContain("solarops-baseline-v1"); // model version
    expect(report.content).toContain("inverter_3"); // engine-derived, not hardcoded
    expect(report.sourceManifest.inputs.length).toBeGreaterThan(0);
  });
});
