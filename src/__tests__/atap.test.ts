/**
 * ATAP credit-clock engine tests (KREDIT / I2).
 * Synthetic cases hand-compute arithmetic in the test — never call back into the engine
 * to derive the expected numbers. Integration case recomputes from fixture observations.
 */
import { describe, expect, it } from "vitest";
import { assumptions } from "../config/assumptions";
import { InMemoryStore } from "../data/store";
import {
  billingPeriodBounds,
  computeAtapCreditClock,
  type AtapCreditClockInput,
} from "../engine/atap";
import { round } from "../engine/math";
import { createSolarOpsService, SolarOpsError } from "../services/solarops";
import type { Observation, SourceType } from "../domain/types";

const SMP = 0.1893;
const RETAIL = 0.2703;

function smpEntry(
  monthLabel = "2026-05",
  provenance: SourceType = "public",
): AtapCreditClockInput["averageSmp"] {
  return {
    rmPerKwh: SMP,
    monthLabel,
    provenance,
    source: "test",
  };
}

function obs(partial: {
  generationKwh?: number | null;
  loadKwh?: number | null;
  importKwh?: number | null;
  exportKwh?: number | null;
  timestamp?: string;
}): Observation {
  return {
    id: "obs_test",
    siteId: "site_test",
    timestamp: partial.timestamp ?? "2026-06-15T12:00:00+08:00",
    generationKwh: partial.generationKwh ?? null,
    loadKwh: partial.loadKwh ?? null,
    importKwh: partial.importKwh ?? null,
    exportKwh: partial.exportKwh ?? null,
    inverterId: null,
    stringId: null,
    availability: 1,
    source: "test",
    isFixture: true,
    qualityFlags: ["fixture_data"],
  };
}

/** One synthetic observation carrying period totals as a single interval (unit cases). */
function totalsObs(importKwh: number, exportKwh: number, generationKwh = exportKwh + 100): Observation[] {
  return [
    obs({
      generationKwh,
      loadKwh: importKwh + (generationKwh - exportKwh),
      importKwh,
      exportKwh,
      timestamp: "2026-06-15T12:00:00+08:00",
    }),
  ];
}

function baseInput(overrides: Partial<AtapCreditClockInput> & {
  capacityKwp?: number;
  tariffRmPerKwh?: number;
  importKwh?: number;
  exportKwh?: number;
  maqViaCapacity?: boolean;
}): AtapCreditClockInput {
  // For synthetic full-period cases we feed one observed day whose totals ARE the
  // period totals, with daysInPeriod forced by asOfDate month — but linear projection
  // multiplies daily mean × daysInPeriod. To make projected === raw totals, we either
  // use observedDays = daysInPeriod (one obs per day) or craft so mean × days = target.
  // Simplest: one obs day with daily totals = target / daysInPeriod is awkward for
  // hand cases. Instead: set capacity so MAQ is whatever the case needs, and pass
  // observations such that daily_mean × daysInPeriod equals the stated import/export.
  //
  // For Cases A–D the task states absolute period-level import/export. We model that
  // by using asOfDate in a 1-day-period month? No — June has 30 days.
  //
  // Approach: put the period totals into a single observed day, then the projection
  // becomes (total/1) * daysInPeriod = total * 30 — WRONG for the unit cases.
  //
  // Correct approach for unit tests that assert period-level numbers: provide
  // `daysInPeriod` synthetic days each carrying (period_total / daysInPeriod), OR
  // call the pure arithmetic path by controlling observedDays so that
  // mean * daysInPeriod = stated total. Easiest: daysInPeriod observations each
  // with import = statedImport/daysInPeriod.
  //
  // Even cleaner for Cases A–D: use a custom assumptions clone is overkill.
  // We'll distribute evenly across `daysInPeriod` days so projected = stated.

  const capacityKwp = overrides.capacityKwp ?? 100; // small; MAQ ample unless overridden
  const tariffRmPerKwh = overrides.tariffRmPerKwh ?? RETAIL;
  const asOfDate = overrides.asOfDate ?? "2026-06-21";
  const { daysInPeriod } = billingPeriodBounds(asOfDate);

  let observations: Observation[];
  if (overrides.observations) {
    observations = overrides.observations;
  } else {
    const importKwh = overrides.importKwh ?? 0;
    const exportKwh = overrides.exportKwh ?? 0;
    const perDayImport = importKwh / daysInPeriod;
    const perDayExport = exportKwh / daysInPeriod;
    observations = [];
    for (let d = 1; d <= daysInPeriod; d++) {
      const dd = String(d).padStart(2, "0");
      observations.push(
        obs({
          generationKwh: perDayExport + 10,
          loadKwh: perDayImport + 10,
          importKwh: perDayImport,
          exportKwh: perDayExport,
          timestamp: `2026-06-${dd}T12:00:00+08:00`,
        }),
      );
    }
  }

  return {
    site: {
      id: "site_test",
      capacityKwp,
      tariffRmPerKwh,
    },
    observations,
    asOfDate,
    averageSmp: overrides.averageSmp ?? smpEntry(),
    assumptions: overrides.assumptions ?? assumptions,
  };
}

describe("ATAP credit-clock engine — synthetic cases (hand-computed)", () => {
  // Case A: import 1000, export 800, MAQ ample, SMP 0.1893, retail 0.2703
  // offsettable = min(800, 1000, MAQ) = 800
  // forfeitedExportKwh = 0
  // creditRm = 800 × 0.1893 = 151.44
  // energyChargeRm = 1000 × 0.2703 = 270.30
  // net = max(0, 270.30 − 151.44) = 118.86
  // smpSpreadRm = 800 × (0.2703 − 0.1893) = 800 × 0.081 = 64.80
  it("Case A: ample MAQ, export < import — full export offsettable", () => {
    // capacity 100 kWp × 5 × 30 = 15_000 MAQ — ample vs 800 export
    const r = computeAtapCreditClock(
      baseInput({ importKwh: 1000, exportKwh: 800, capacityKwp: 100 }),
    );
    expect(r.eligibility.eligible).toBe(true);
    expect(r.projection).not.toBeNull();
    const p = r.projection!;
    expect(p.offsettableExportKwh).toBe(800); // min(800, 1000, 15000)
    expect(p.forfeitedExportKwh).toBe(0); // 800 − 800
    expect(p.creditRm).toBe(151.44); // 800 × 0.1893
    expect(p.energyChargeRm).toBe(270.3); // 1000 × 0.2703
    expect(p.netEnergyChargeRm).toBe(118.86); // 270.30 − 151.44
    expect(r.valueLeak!.smpSpreadRm).toBe(64.8); // 800 × (0.2703 − 0.1893)
    expect(r.valueLeak!.forfeitedCreditRm).toBe(0);
    expect(r.valueLeak!.totalRm).toBe(64.8); // 64.80 + 0
  });

  // Case B: import 300, export 800, MAQ ample
  // offsettable = min(800, 300, MAQ) = 300
  // forfeitedExportKwh = 800 − 300 = 500
  // forfeitedCreditRm = 500 × 0.1893 = 94.65
  it("Case B: export > import — import caps offsettable; excess forfeited", () => {
    const r = computeAtapCreditClock(
      baseInput({ importKwh: 300, exportKwh: 800, capacityKwp: 100 }),
    );
    const p = r.projection!;
    expect(p.offsettableExportKwh).toBe(300); // min(800, 300, 15000)
    expect(p.forfeitedExportKwh).toBe(500); // 800 − 300
    expect(p.forfeitedCreditRm).toBe(94.65); // 500 × 0.1893
    expect(p.creditRm).toBe(56.79); // 300 × 0.1893 = 56.79
    expect(p.energyChargeRm).toBe(81.09); // 300 × 0.2703
    expect(p.netEnergyChargeRm).toBe(24.3); // 81.09 − 56.79
    expect(r.valueLeak!.forfeitedCreditRm).toBe(94.65);
    expect(r.valueLeak!.smpSpreadRm).toBe(24.3); // 300 × 0.081
  });

  // Case C: import 1000, export 800, MAQ 600
  // MAQ = capacity × 5 × 30 = 600 → capacity = 600 / (5 × 30) = 4 kWp
  // offsettable = min(800, 1000, 600) = 600
  // forfeited = 800 − 600 = 200
  it("Case C: MAQ binds — export above MAQ forfeited", () => {
    // 4 kWp × 5 sun-hours × 30 days = 600 kWh MAQ
    const r = computeAtapCreditClock(
      baseInput({ importKwh: 1000, exportKwh: 800, capacityKwp: 4 }),
    );
    expect(r.maqKwh).toBe(600); // 4 × 5 × 30
    const p = r.projection!;
    expect(p.offsettableExportKwh).toBe(600); // min(800, 1000, 600)
    expect(p.forfeitedExportKwh).toBe(200); // 800 − 600
    expect(p.forfeitedCreditRm).toBe(37.86); // 200 × 0.1893
    expect(p.creditRm).toBe(113.58); // 600 × 0.1893
  });

  // Case D: net floor
  // D1: import 100, export 800, MAQ ample
  // offsettable = 100; creditRm = 100 × 0.1893 = 18.93
  // energyChargeRm = 100 × 0.2703 = 27.03
  // net = max(0, 27.03 − 18.93) = 8.10
  it("Case D1: net energy charge stays positive when credit < energy charge", () => {
    const r = computeAtapCreditClock(
      baseInput({ importKwh: 100, exportKwh: 800, capacityKwp: 100 }),
    );
    const p = r.projection!;
    expect(p.offsettableExportKwh).toBe(100);
    expect(p.creditRm).toBe(18.93); // 100 × 0.1893
    expect(p.energyChargeRm).toBe(27.03); // 100 × 0.2703
    expect(p.netEnergyChargeRm).toBe(8.1); // max(0, 27.03 − 18.93)
  });

  // D2: credit exceeds energy charge → net floors at 0
  // Craft: retail very low vs SMP, or more simply use high export-to-import with
  // a tariff where offsettable × SMP > import × tariff.
  // import 100, export 800, offsettable 100; credit = 18.93
  // If tariff is 0.10: energyCharge = 10.00; net = max(0, 10 − 18.93) = 0
  it("Case D2: net energy charge floors at zero when credit exceeds energy charge", () => {
    const r = computeAtapCreditClock(
      baseInput({
        importKwh: 100,
        exportKwh: 800,
        capacityKwp: 100,
        tariffRmPerKwh: 0.1,
      }),
    );
    const p = r.projection!;
    // creditRm = 100 × 0.1893 = 18.93; energyChargeRm = 100 × 0.10 = 10.00
    expect(p.creditRm).toBe(18.93);
    expect(p.energyChargeRm).toBe(10); // 100 × 0.10
    expect(p.netEnergyChargeRm).toBe(0); // max(0, 10 − 18.93)
  });

  // Case E: capacityKwp 2500 => ineligible, no projections
  it("Case E: capacity above 1,000 kWac hard cap is ineligible with no projections", () => {
    const r = computeAtapCreditClock(
      baseInput({ importKwh: 1000, exportKwh: 800, capacityKwp: 2500 }),
    );
    expect(r.eligibility.eligible).toBe(false);
    expect(r.eligibility.reason).toContain("exceeds 1,000 kWac non-domestic cap");
    expect(r.eligibility.reason).toContain("GP/ST/No.60/2025");
    expect(r.projection).toBeNull();
    expect(r.valueLeak).toBeNull();
  });

  // Case F: null discipline
  it("Case F: null export/load intervals excluded from sums; observedDays counts only days with data", () => {
    const observations: Observation[] = [
      // Day 1: full data
      obs({
        generationKwh: 100,
        loadKwh: 80,
        importKwh: 20,
        exportKwh: 40,
        timestamp: "2026-06-01T12:00:00+08:00",
      }),
      // Day 2: generation only — null load/export → day NOT counted in observedDays
      obs({
        generationKwh: 50,
        loadKwh: null,
        importKwh: null,
        exportKwh: null,
        timestamp: "2026-06-02T12:00:00+08:00",
      }),
      // Day 3: export present, load null → day counted; export summed; load not
      obs({
        generationKwh: 60,
        loadKwh: null,
        importKwh: 10,
        exportKwh: 30,
        timestamp: "2026-06-03T12:00:00+08:00",
      }),
      // Day 3 second interval with nulls — must not zero-fill
      obs({
        generationKwh: null,
        loadKwh: null,
        importKwh: null,
        exportKwh: null,
        timestamp: "2026-06-03T13:00:00+08:00",
      }),
    ];

    const r = computeAtapCreditClock(
      baseInput({ observations, capacityKwp: 100, asOfDate: "2026-06-21" }),
    );

    // generation = 100 + 50 + 60 = 210 (null excluded)
    expect(r.observedToDate.generationKwh).toBe(210);
    // load = 80 only
    expect(r.observedToDate.loadKwh).toBe(80);
    // import = 20 + 10 = 30
    expect(r.observedToDate.importKwh).toBe(30);
    // export = 40 + 30 = 70
    expect(r.observedToDate.exportKwh).toBe(70);
    // selfConsumed = 210 − 70 = 140
    expect(r.observedToDate.selfConsumedKwh).toBe(140);
    // Days with any non-null load OR export: 2026-06-01, 2026-06-03 → 2
    // (day 2 has neither load nor export)
    expect(r.coverage.observedDays).toBe(2);
  });
});

describe("ATAP credit-clock service integration (fixtures)", () => {
  const svc = () => createSolarOpsService(new InMemoryStore());

  it("atapCreditClock('site_a') on default asOfDate 2026-06-21 — coverage + test-side projection arithmetic", () => {
    const store = new InMemoryStore();
    const s = createSolarOpsService(store);
    const result = s.atapCreditClock("site_a");

    // Coverage: June 2026, 30 days, 4 fixture days, 9 days remaining (21 → 30)
    expect(result.coverage.periodStart).toBe("2026-06-01");
    expect(result.coverage.periodEnd).toBe("2026-06-30");
    expect(result.coverage.daysInPeriod).toBe(30);
    expect(result.coverage.asOfDate).toBe("2026-06-21");
    expect(result.coverage.observedDays).toBe(4);
    expect(result.coverage.daysRemaining).toBe(9); // 30 − 21 = 9

    expect(result.eligibility.eligible).toBe(true); // 850 kWp ≤ 1000

    // Recompute observed sums from fixture observations (test-side, not engine).
    const site = store.getSite("site_a")!;
    const day = "2026-06-21";
    const periodStart = "2026-06-01";
    const obsRows = store.getObservations("site_a").filter((o) => {
      const d = o.timestamp.slice(0, 10);
      return d >= periodStart && d <= day;
    });

    let gen = 0;
    let load = 0;
    let imp = 0;
    let exp = 0;
    const days = new Set<string>();
    for (const o of obsRows) {
      if (o.generationKwh != null) gen += o.generationKwh;
      if (o.loadKwh != null) load += o.loadKwh;
      if (o.importKwh != null) imp += o.importKwh;
      if (o.exportKwh != null) exp += o.exportKwh;
      if (o.loadKwh != null || o.exportKwh != null) days.add(o.timestamp.slice(0, 10));
    }
    const observedDays = days.size; // 4
    expect(observedDays).toBe(4);

    expect(result.observedToDate.generationKwh).toBe(round(gen));
    expect(result.observedToDate.loadKwh).toBe(round(load));
    expect(result.observedToDate.importKwh).toBe(round(imp));
    expect(result.observedToDate.exportKwh).toBe(round(exp));
    expect(result.observedToDate.selfConsumedKwh).toBe(round(gen - exp));

    // MAQ = 850 × 5 × 30 = 127_500
    expect(result.maqKwh).toBe(127_500); // 850 × 5 × 30

    // Linear daily-mean projection (test-side arithmetic).
    const daysInPeriod = 30;
    const projExp = (exp / observedDays) * daysInPeriod;
    const projImp = (imp / observedDays) * daysInPeriod;
    const smp = assumptions.atap.averageSmpByMonth["2026-05"]!.rmPerKwh; // 0.1893
    const retail = site.tariffAssumptionRmPerKwh ?? assumptions.retailTariffRmPerKwh; // 0.2703
    const offsettable = Math.min(projExp, projImp, 127_500);
    const forfeited = projExp - offsettable;
    const creditRm = offsettable * smp;
    const forfeitedCreditRm = forfeited * smp;
    const energyChargeRm = projImp * retail;
    const net = Math.max(0, energyChargeRm - creditRm);
    const smpSpreadRm = offsettable * (retail - smp);
    const totalLeak = smpSpreadRm + forfeitedCreditRm;

    expect(result.projection).not.toBeNull();
    expect(result.projection!.method).toBe("linear_daily_mean");
    expect(result.projection!.observedDays).toBe(4);
    expect(result.projection!.exportKwh).toBe(round(projExp));
    expect(result.projection!.importKwh).toBe(round(projImp));
    expect(result.projection!.offsettableExportKwh).toBe(round(offsettable));
    expect(result.projection!.forfeitedExportKwh).toBe(round(forfeited));
    expect(result.projection!.creditRm).toBe(round(creditRm));
    expect(result.projection!.forfeitedCreditRm).toBe(round(forfeitedCreditRm));
    expect(result.projection!.energyChargeRm).toBe(round(energyChargeRm));
    expect(result.projection!.netEnergyChargeRm).toBe(round(net));
    expect(result.valueLeak!.smpSpreadRm).toBe(round(smpSpreadRm));
    expect(result.valueLeak!.forfeitedCreditRm).toBe(round(forfeitedCreditRm));
    expect(result.valueLeak!.totalRm).toBe(round(totalLeak));

    // Manifest labels May 2026 SMP as manual_assumption.
    const smpInput = result.source_manifest.inputs.find((i) => i.name === "average_smp");
    expect(smpInput).toBeDefined();
    expect(smpInput!.sourceType).toBe("manual_assumption");
    expect(smpInput!.sourceName).toContain("2026-05");
  });

  it("site_b (2500 kWp) returns ineligible with no projections", () => {
    const result = svc().atapCreditClock("site_b");
    expect(result.eligibility.eligible).toBe(false);
    expect(result.eligibility.reason).toContain("exceeds 1,000 kWac");
    expect(result.projection).toBeNull();
    expect(result.valueLeak).toBeNull();
  });

  it("throws smp_unavailable when preceding-month SMP entry is missing", () => {
    const s = svc();
    expect(() => s.atapCreditClock("site_a", "2026-04-15")).toThrowError(SolarOpsError);
    try {
      s.atapCreditClock("site_a", "2026-04-15");
    } catch (err) {
      expect(err).toBeInstanceOf(SolarOpsError);
      expect((err as SolarOpsError).code).toBe("smp_unavailable");
      // Preceding month of 2026-04 is 2026-03 — not in averageSmpByMonth.
      expect((err as SolarOpsError).message).toContain("2026-03");
    }
  });

  it("stated assumptions include kWp-as-kWac proxy and AFA exclusion", () => {
    const result = svc().atapCreditClock("site_a");
    const joined = result.assumptions.join(" | ");
    expect(joined).toMatch(/kWp.*kWac proxy/i);
    expect(joined).toMatch(/AFA/i);
    expect(joined).toMatch(/linear_daily_mean/);
    expect(joined).toMatch(/2026-05/);
  });
});
