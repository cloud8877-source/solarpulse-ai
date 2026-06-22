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

  it("forecast surfaces a reference WAPE for Site C — never a silent 0", () => {
    const f = svc().forecast("site_c", "day_ahead");
    expect(f.metric.name).toBe("fixture_wape");
    expect(f.metric.value).toBeGreaterThan(0);
    expect(f.quality_flags).toContain("metric_from_reference");
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
