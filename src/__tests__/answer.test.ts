import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../data/store";
import { createSolarOpsService, type SolarOpsService } from "../services/solarops";
import {
  renderPortfolioForecastAnswer,
  renderSiteTriageAnswer,
  type SiteTriage,
} from "../agent/answer";
import { validateAnswer } from "../agent/safety";

function triage(s: SolarOpsService, siteId: string): { t: SiteTriage; outputs: unknown[] } {
  const site = s.lookupSolarSite(siteId);
  const forecast = s.forecast(siteId);
  const detect = s.detectAssetUnderperformance(siteId);
  const explain = s.explainSolarAnomaly(detect.anomaly_event_id);
  const rank = s.rankOmActions(detect.anomaly_event_id);
  return { t: { site, forecast, detect, explain, rank }, outputs: [site, forecast, detect, explain, rank] };
}

const SECTIONS = [
  "Finding",
  "Evidence",
  "Likely cause",
  "Recommended action",
  "Estimated impact",
  "Assumptions",
  "Next step",
];

describe("deterministic answer renderer (PDR-005 §4)", () => {
  it("Site B triage answer is 7-part and grounded by construction", () => {
    const { t, outputs } = triage(createSolarOpsService(new InMemoryStore()), "site_b");
    const answer = renderSiteTriageAnswer(t);
    for (const s of SECTIONS) expect(answer).toContain(s);
    expect(answer).toContain("inverter_3");
    const res = validateAnswer(answer, outputs);
    expect(res.ok).toBe(true);
    expect(res.ungroundedClaims).toHaveLength(0);
  });

  it("Site C triage credits zero recovery and stays grounded (CE3)", () => {
    const { t, outputs } = triage(createSolarOpsService(new InMemoryStore()), "site_c");
    const answer = renderSiteTriageAnswer(t);
    expect(answer).toContain("data_issue");
    expect(answer.toLowerCase()).toContain("no recoverable energy");
    expect(validateAnswer(answer, outputs).ok).toBe(true);
  });

  it("portfolio forecast answer is grounded and includes demand context (CE2)", () => {
    const s = createSolarOpsService(new InMemoryStore());
    const sites = ["site_a", "site_b", "site_c"].map((id) => ({
      site: s.lookupSolarSite(id),
      forecast: s.forecast(id),
    }));
    const grid = s.lookupGridDemand("peninsular_malaysia", "day_ahead");
    const answer = renderPortfolioForecastAnswer({ sites, grid });
    const outputs = [...sites.flatMap((x) => [x.site, x.forecast]), grid];
    expect(answer).toContain("Demand context");
    expect(validateAnswer(answer, outputs).ok).toBe(true);
  });
});
