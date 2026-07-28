import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../data/store";
import { createSolarOpsService, SolarOpsError } from "../services/solarops";

const svc = () => createSolarOpsService(new InMemoryStore());

describe("SolarOps service layer (PDR-005 contracts)", () => {
  it("lookup_solar_site returns metadata + latest computed status", () => {
    const b = svc().lookupSolarSite("site_b");
    expect(b.site_id).toBe("site_b");
    expect(b.capacity_kwp).toBe(2500);
    expect(b.latest_status).toBe("anomaly");
    expect(b.is_fixture).toBe(true);
  });

  it("default asOfDate equals latest fixture day (2026-06-21)", () => {
    const s = svc();
    expect(s.latestFixtureDate()).toBe("2026-06-21");
    // No-arg calls must match explicit asOfDate=2026-06-21
    expect(s.lookupSolarSite("site_b").latest_status).toBe(
      s.lookupSolarSite("site_b", "2026-06-21").latest_status,
    );
    expect(s.detectAssetUnderperformance("site_b").anomaly_event_id).toBe(
      s.detectAssetUnderperformance("site_b", undefined, undefined, "2026-06-21").anomaly_event_id,
    );
  });

  it("day-scoping: site_b degrades day-by-day; site_c day4 is data_issue", () => {
    const s = svc();
    expect(s.detectAssetUnderperformance("site_b", undefined, undefined, "2026-06-18").severity).toBe(
      "healthy",
    );
    expect(s.detectAssetUnderperformance("site_b", undefined, undefined, "2026-06-19").severity).toBe(
      "watch",
    );
    expect(s.detectAssetUnderperformance("site_b", undefined, undefined, "2026-06-20").severity).toBe(
      "anomaly",
    );
    expect(s.detectAssetUnderperformance("site_b", undefined, undefined, "2026-06-21").severity).toBe(
      "anomaly",
    );

    expect(s.detectAssetUnderperformance("site_c", undefined, undefined, "2026-06-18").severity).toBe(
      "healthy",
    );
    expect(s.detectAssetUnderperformance("site_c", undefined, undefined, "2026-06-21").severity).toBe(
      "data_issue",
    );
  });

  it("forecast surfaces a reference WAPE for Site C — never a silent 0", () => {
    const f = svc().forecast("site_c", "day_ahead");
    expect(f.metric.name).toBe("fixture_wape");
    expect(f.metric.value).toBeGreaterThan(0);
    expect(f.quality_flags).toContain("metric_from_reference");
  });

  // F1: reference WAPE must be day-scoped (day-4 ≡ old single-day fixture → 0.0187).
  it("forecast(site_c) default-path metric is day-scoped reference WAPE 0.0187", () => {
    const f = svc().forecast("site_c", "day_ahead");
    expect(f.metric.value).toBeCloseTo(0.0187, 4);
    expect(f.quality_flags).toContain("metric_from_reference");
  });

  // F2: lone window_start must not open-end through remaining days.
  it("lone window_start scopes to that single day (matches asOfDate)", () => {
    const s = svc();
    const lone = s.detectAssetUnderperformance("site_b", "2026-06-19T00:00:00+08:00");
    const day = s.detectAssetUnderperformance("site_b", undefined, undefined, "2026-06-19");
    expect(lone.observed_kwh).toBe(day.observed_kwh);
    expect(lone.severity).toBe(day.severity);
    expect(lone.anomaly_event_id).toBe(day.anomaly_event_id);
  });

  // F3: weather must be window-scoped (evidence matches full-day explicit window).
  it("detectEvent asOfDate evidence matches full-day explicit window", () => {
    const s = svc();
    const byDate = s.detectAssetUnderperformance("site_b", undefined, undefined, "2026-06-19");
    const byWindow = s.detectAssetUnderperformance(
      "site_b",
      "2026-06-19T00:00:00+08:00",
      "2026-06-19T23:59:59+08:00",
    );
    expect(byDate.evidence).toEqual(byWindow.evidence);
    expect(byDate.observed_kwh).toBe(byWindow.observed_kwh);
    expect(byDate.severity).toBe(byWindow.severity);

    // R3 / I2b-1: site_a day-2 is distinctly cloudier (0.45 vs usual 0.20).
    // Day-scoped detect must reflect that day's cloud, not the 4-day mean.
    const store = new InMemoryStore();
    const wxA = store.getWeather("site_a");
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const day2Clouds = wxA
      .filter((w) => w.timestamp.startsWith("2026-06-19"))
      .map((w) => w.cloudCover!)
      .filter((c): c is number => c != null);
    const allClouds = wxA.map((w) => w.cloudCover!).filter((c): c is number => c != null);
    const day2MeanCloud = mean(day2Clouds);
    const multiDayMeanCloud = mean(allClouds);
    expect(day2MeanCloud).toBeCloseTo(0.45, 5);
    // Would-be unscoped mean mixes clear days — must differ from day-2's value.
    expect(multiDayMeanCloud).not.toBeCloseTo(day2MeanCloud, 5);
    expect(multiDayMeanCloud).toBeLessThan(day2MeanCloud);

    const day2 = s.detectAssetUnderperformance("site_a", undefined, undefined, "2026-06-19");
    const day2Win = s.detectAssetUnderperformance(
      "site_a",
      "2026-06-19T00:00:00+08:00",
      "2026-06-19T23:59:59+08:00",
    );
    expect(day2.evidence).toEqual(day2Win.evidence);
    // Day-2 cloud 0.45 < 0.6 → weatherNormal true when scoped; residual healthy
    // because generation drops with the cloudier irradiance (weather explains it).
    expect(day2.evidence.weatherNormal).toBe(true);
    expect(day2.severity).toBe("healthy");
    expect(day2.residual_pct).toBeGreaterThan(-0.05);
    // Cloudier day-2 expected kWh is below clear day-1 — proves weather day-scoping
    // (unscoped multi-day weather would still match timestamps, but day-1 comparison
    // locks the fixture cloud→irradiance coupling the service must honour).
    const day1 = s.detectAssetUnderperformance("site_a", undefined, undefined, "2026-06-18");
    expect(day2.expected_kwh).toBeLessThan(day1.expected_kwh);
  });

  // F4: empty window must not fabricate high-confidence healthy / weather_explained.
  it("empty asOfDate window is not healthy and not high-confidence weather_explained", () => {
    const s = svc();
    const d = s.detectAssetUnderperformance("site_b", undefined, undefined, "2026-01-01");
    expect(d.severity).not.toBe("healthy");
    expect(d.severity).toBe("data_issue");
    const e = s.explainSolarAnomaly(d.anomaly_event_id);
    expect(e.likely_cause === "weather_explained" && e.confidence === "high").toBe(false);
  });

  it("chained flow detect -> explain -> rank -> report (Site B)", () => {
    const s = svc();
    const d = s.detectAssetUnderperformance("site_b");
    expect(d.severity).toBe("anomaly");
    expect(d.anomaly_event_id).toBe("anom_site_b_20260621");
    expect(d.residual_pct).toBeLessThan(-0.1);

    const e = s.explainSolarAnomaly(d.anomaly_event_id);
    expect(e.likely_cause).toBe("inverter_or_string_underperformance");
    expect(e.confidence).toBe("medium");

    const r = s.rankOmActions(d.anomaly_event_id);
    expect(r.recommendations.length).toBeGreaterThanOrEqual(2);
    expect(r.recommendations[0]!.action).toContain("inverter_3");
    expect(r.recommendations[0]!.expected_recovery_kwh_month).toBeGreaterThan(0);
    expect(r.recommendations[0]!.assumptions).toHaveProperty("tariff_rm_per_kwh");

    const rep = s.generateSolarReport("site_b", d.anomaly_event_id);
    expect(rep.includes_provenance).toBe(true);
    expect(rep.includes_assumptions).toBe(true);
    expect(rep.content).toContain("Source Provenance");
    expect(rep.url_or_path).toContain(rep.report_id);
  });

  it("explain/rank are robust to call order — event re-derived from its id", () => {
    const e = svc().explainSolarAnomaly("anom_site_b_20260621");
    expect(e.likely_cause).toBe("inverter_or_string_underperformance");
  });

  it("re-derives earlier-day events from day-keyed ids", () => {
    const e = svc().explainSolarAnomaly("anom_site_b_20260619");
    // day2 is watch → not data_issue / not healthy equipment path only
    expect(e.likely_cause).toBeDefined();
    const d = svc().detectAssetUnderperformance("site_b", undefined, undefined, "2026-06-19");
    expect(d.anomaly_event_id).toBe("anom_site_b_20260619");
    expect(d.severity).toBe("watch");
  });

  it("Site C explain returns telemetry/data-quality cause (CE3)", () => {
    const s = svc();
    const d = s.detectAssetUnderperformance("site_c");
    expect(d.severity).toBe("data_issue");
    expect(s.explainSolarAnomaly(d.anomaly_event_id).likely_cause).toBe("telemetry_data_quality_issue");
  });

  it("missing site throws a typed error (PDR-005 §6)", () => {
    const s = svc();
    expect(() => s.lookupSolarSite("site_zzz")).toThrowError(SolarOpsError);
    try {
      s.forecast("site_zzz");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SolarOpsError);
      expect((err as SolarOpsError).code).toBe("site_not_found");
    }
  });

  it("grid demand: snapshots for peninsular_malaysia; empty + flagged for unknown region", () => {
    const s = svc();
    expect(s.lookupGridDemand("peninsular_malaysia", "day_ahead").snapshots.length).toBeGreaterThan(0);
    const none = s.lookupGridDemand("atlantis", "day_ahead");
    expect(none.snapshots.length).toBe(0);
    expect(none.quality_flags).toContain("public_context_only");
  });
});
