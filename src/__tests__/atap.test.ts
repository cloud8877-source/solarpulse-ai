/**
 * ATAP credit-clock engine tests (KREDIT / I2 / I2b-2).
 * Synthetic cases hand-compute arithmetic in the test — never call back into the engine
 * to derive the expected numbers. Integration case recomputes from fixture observations.
 */
import { describe, expect, it } from "vitest";
import { assumptions } from "../config/assumptions";
import { InMemoryStore } from "../data/store";
import {
  billingPeriodBounds,
  computeAtapCreditClock,
  lvVolumetricStackRmPerKwh,
  type AtapCreditClockInput,
} from "../engine/atap";
import { round } from "../engine/math";
import { createSolarOpsService, SolarOpsError } from "../services/solarops";
import type { Observation, SourceType } from "../domain/types";

const SMP = 0.1893;
const RETAIL = 0.2703;
// Full LV volumetric stack (energy + capacity + network) for smpSpreadRm.
const LV_STACK = lvVolumetricStackRmPerKwh(assumptions); // 0.5068
const LV_SPREAD = LV_STACK - SMP; // 0.3175

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

function baseInput(overrides: Partial<AtapCreditClockInput> & {
  capacityKwp?: number;
  tariffRmPerKwh?: number;
  importKwh?: number;
  exportKwh?: number;
  maqViaCapacity?: boolean;
}): AtapCreditClockInput {
  // Distribute period totals evenly across daysInPeriod so projected = stated totals.

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
      tariffCategory: "lv_general",
    },
    observations,
    asOfDate,
    averageSmp: overrides.averageSmp ?? smpEntry(),
    assumptions: overrides.assumptions ?? assumptions,
  };
}

describe("ATAP credit-clock engine — synthetic cases (hand-computed)", () => {
  // Case A: import 1000, export 800, MAQ ample, SMP 0.1893, retail energy 0.2703
  // offsettable = min(800, 1000, MAQ) = 800
  // forfeitedExportKwh = 0
  // creditRm = 800 × 0.1893 = 151.44
  // energyChargeRm = 1000 × 0.2703 = 270.30
  // net = max(0, 270.30 − 151.44) = 118.86
  // smpSpreadRm = 800 × (0.5068 − 0.1893) = 800 × 0.3175 = 254.00  (full LV stack)
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
    expect(r.valueLeak!.smpSpreadRm).toBe(254); // 800 × (0.5068 − 0.1893)
    expect(r.valueLeak!.forfeitedCreditRm).toBe(0);
    expect(r.valueLeak!.flooredCreditLostRm).toBe(0);
    expect(r.valueLeak!.totalRm).toBe(254); // 254 + 0 + 0
    expect(r.projectionUnavailableReason).toBeNull();
  });

  // Case B: import 300, export 800, MAQ ample
  // offsettable = min(800, 300, MAQ) = 300
  // forfeitedExportKwh = 800 − 300 = 500
  // forfeitedCreditRm = 500 × 0.1893 = 94.65
  // smpSpreadRm = 300 × 0.3175 = 95.25
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
    expect(r.valueLeak!.smpSpreadRm).toBe(95.25); // 300 × 0.3175
    expect(r.valueLeak!.flooredCreditLostRm).toBe(0);
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
    expect(r.valueLeak!.flooredCreditLostRm).toBe(0);
  });

  // D2: credit exceeds energy charge → net floors at 0; flooredCreditLostRm tracks the loss
  // import 100, export 800, offsettable 100; credit = 18.93
  // tariff 0.10: energyCharge = 10.00; net = max(0, 10 − 18.93) = 0
  // flooredCreditLostRm = 18.93 − 10 = 8.93
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
    expect(r.valueLeak!.flooredCreditLostRm).toBe(8.93); // 18.93 − 10.00
    expect(r.valueLeak!.totalRm).toBe(
      round(r.valueLeak!.smpSpreadRm + r.valueLeak!.forfeitedCreditRm + 8.93),
    );
  });

  // Case E: capacityKwp 2500 => ineligible, no projections
  it("Case E: capacity above config hard cap is ineligible with no projections", () => {
    const r = computeAtapCreditClock(
      baseInput({ importKwh: 1000, exportKwh: 800, capacityKwp: 2500 }),
    );
    expect(r.eligibility.eligible).toBe(false);
    // Reason string built from config cap (not hardcoded "1,000" literal in engine).
    expect(r.eligibility.reason).toContain(
      `exceeds ${assumptions.atap.nonDomesticCapKwac.toLocaleString("en-US")} kWac non-domestic cap`,
    );
    expect(r.eligibility.reason).toContain("GP/ST/No.60/2025");
    expect(r.projection).toBeNull();
    expect(r.valueLeak).toBeNull();
    expect(r.projectionUnavailableReason).toBeNull();
  });

  // Case F: null discipline + F7 observedDays (any of load/import/export; sums only on counted days)
  it("Case F: null export/load intervals excluded; observedDays + sums only on counted days", () => {
    const observations: Observation[] = [
      // Day 1: full data — counted
      obs({
        generationKwh: 100,
        loadKwh: 80,
        importKwh: 20,
        exportKwh: 40,
        timestamp: "2026-06-01T12:00:00+08:00",
      }),
      // Day 2: generation only — null load/import/export → day NOT counted
      obs({
        generationKwh: 50,
        loadKwh: null,
        importKwh: null,
        exportKwh: null,
        timestamp: "2026-06-02T12:00:00+08:00",
      }),
      // Day 3: export + import present → day counted; load null excluded from load sum
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

    // F7: generation only from counted days (day 1 + day 3) — day 2 gen 50 excluded
    // generation = 100 + 60 = 160
    expect(r.observedToDate.generationKwh).toBe(160);
    // load = 80 only
    expect(r.observedToDate.loadKwh).toBe(80);
    // import = 20 + 10 = 30
    expect(r.observedToDate.importKwh).toBe(30);
    // export = 40 + 30 = 70
    expect(r.observedToDate.exportKwh).toBe(70);
    // selfConsumed raw = 160 − 70 = 90
    expect(r.observedToDate.selfConsumedKwh).toBe(90);
    // Days with any of load/import/export non-null: 2026-06-01, 2026-06-03 → 2
    expect(r.coverage.observedDays).toBe(2);
  });

  // F8: zero coverage → projection null + projectionUnavailableReason insufficient_data
  it("Case G: observedDays === 0 yields insufficient_data, no all-zero projection", () => {
    const observations: Observation[] = [
      obs({
        generationKwh: 50,
        loadKwh: null,
        importKwh: null,
        exportKwh: null,
        timestamp: "2026-06-01T12:00:00+08:00",
      }),
    ];
    const r = computeAtapCreditClock(
      baseInput({ observations, capacityKwp: 100, asOfDate: "2026-06-21" }),
    );
    expect(r.coverage.observedDays).toBe(0);
    expect(r.eligibility.eligible).toBe(true);
    expect(r.projection).toBeNull();
    expect(r.valueLeak).toBeNull();
    expect(r.projectionUnavailableReason).toBe("insufficient_data");
  });
});

describe("ATAP credit-clock service integration (fixtures)", () => {
  const svc = () => createSolarOpsService(new InMemoryStore());

  it("atapCreditClock('site_a') on default asOfDate 2026-06-21 — coverage + test-side projection arithmetic", () => {
    const store = new InMemoryStore();
    const s = createSolarOpsService(store);
    const result = s.atapCreditClock("site_a");

    // Coverage: June 2026, 30 days, 4 fixture days, 9 days remaining (21 → 30)
    // snake_case DTO (F5)
    expect(result.coverage.period_start).toBe("2026-06-01");
    expect(result.coverage.period_end).toBe("2026-06-30");
    expect(result.coverage.days_in_period).toBe(30);
    expect(result.coverage.as_of_date).toBe("2026-06-21");
    expect(result.coverage.observed_days).toBe(4);
    expect(result.coverage.days_remaining).toBe(9); // 30 − 21 = 9

    expect(result.eligibility.eligible).toBe(true); // 850 kWp ≤ 1000
    expect(result.projection_unavailable_reason).toBeNull();

    // Recompute observed sums from fixture observations (test-side, not engine).
    // F7: day counts if any of load/import/export non-null; sums only on counted days.
    const day = "2026-06-21";
    const periodStart = "2026-06-01";
    const obsRows = store.getObservations("site_a").filter((o) => {
      const d = o.timestamp.slice(0, 10);
      return d >= periodStart && d <= day;
    });

    const days = new Set<string>();
    for (const o of obsRows) {
      if (o.loadKwh != null || o.importKwh != null || o.exportKwh != null) {
        days.add(o.timestamp.slice(0, 10));
      }
    }
    const observedDays = days.size; // 4
    expect(observedDays).toBe(4);

    let gen = 0;
    let load = 0;
    let imp = 0;
    let exp = 0;
    for (const o of obsRows) {
      if (!days.has(o.timestamp.slice(0, 10))) continue;
      if (o.generationKwh != null) gen += o.generationKwh;
      if (o.loadKwh != null) load += o.loadKwh;
      if (o.importKwh != null) imp += o.importKwh;
      if (o.exportKwh != null) exp += o.exportKwh;
    }

    expect(result.observed_to_date.generation_kwh).toBe(round(gen));
    expect(result.observed_to_date.load_kwh).toBe(round(load));
    expect(result.observed_to_date.import_kwh).toBe(round(imp));
    expect(result.observed_to_date.export_kwh).toBe(round(exp));
    expect(result.observed_to_date.self_consumed_kwh).toBe(round(gen - exp));

    // F12: pin from FULL-PRECISION raw sums (not from the 2dp rounded echo).
    // raw export sum 7989.789999999999 × (30/4) = 59923.42499999999 → 59923.43
    // raw import sum 6462.82 × (30/4) = 48471.15 → 48471.15
    expect(round(exp)).toBe(7989.79);
    expect(round(imp)).toBe(6462.82);

    // MAQ = 850 × 5 × 30 = 127_500
    expect(result.maq_kwh).toBe(127_500); // 850 × 5 × 30

    // PINNED projection outputs — hand-derived from full-precision daily-mean arithmetic.
    // projExport = 7989.789999999999 / 4 * 30 = 59923.42499999999
    // projImport = 6462.82 / 4 * 30 = 48471.15
    // offsettable = min(59923.42499999999, 48471.15, 127500) = 48471.15  (import-bound)
    // forfeited  = 59923.42499999999 − 48471.15 = 11452.27499999999 → 11452.28
    // creditRm   = 48471.15 × 0.1893 = 9175.588695 → 9175.59
    // forfCredit = 11452.27499999999 × 0.1893 = 2167.9156575 → 2167.92
    // energyChg  = 48471.15 × 0.2703 = 13101.751845 → 13101.75
    // net        = max(0, 13101.751845 − 9175.588695) = 3926.16315 → 3926.16
    // smpSpread  = 48471.15 × (0.5068 − 0.1893) = 48471.15 × 0.3175 = 15389.590125 → 15389.59
    // totalLeak  = 15389.590125 + 2167.9156575 + 0 = 17557.5057825 → 17557.51
    expect(result.projection).not.toBeNull();
    expect(result.projection!.method).toBe("linear_daily_mean");
    expect(result.projection!.observed_days).toBe(4);
    expect(result.projection!.export_kwh).toBe(59923.43);
    expect(result.projection!.import_kwh).toBe(48471.15);
    expect(result.projection!.offsettable_export_kwh).toBe(48471.15);
    expect(result.projection!.forfeited_export_kwh).toBe(11452.28);
    expect(result.projection!.credit_rm).toBe(9175.59);
    expect(result.projection!.forfeited_credit_rm).toBe(2167.92);
    expect(result.projection!.energy_charge_rm).toBe(13101.75);
    expect(result.projection!.net_energy_charge_rm).toBe(3926.16);
    // F17: net ≠ smpSpread after F3 — net uses energy-charge-only (0.2703−SMP=0.081),
    // spread uses full LV stack (0.5068−SMP=0.3175). Pre-F3 they were equal (import-bound identity).
    expect(result.value_leak!.smp_spread_rm).toBe(15389.59);
    expect(result.value_leak!.forfeited_credit_rm).toBe(2167.92);
    expect(result.value_leak!.floored_credit_lost_rm).toBe(0);
    expect(result.value_leak!.total_rm).toBe(17557.51);
    expect(result.projection!.net_energy_charge_rm).not.toBe(result.value_leak!.smp_spread_rm);

    // Manifest labels May 2026 SMP as manual_assumption.
    const smpInput = result.source_manifest.inputs.find((i) => i.name === "average_smp");
    expect(smpInput).toBeDefined();
    expect(smpInput!.sourceType).toBe("manual_assumption");
    expect(smpInput!.sourceName).toContain("2026-05");
  });

  // F16: site_c full integration — export-bound min() branch (forfeited 0, leak = pure spread)
  it("atapCreditClock('site_c') export-bound pin + null-hole path store-derived sums", () => {
    const store = new InMemoryStore();
    const s = createSolarOpsService(store);
    const result = s.atapCreditClock("site_c");

    expect(result.eligibility.eligible).toBe(true); // 950 ≤ 1000
    expect(result.coverage.observed_days).toBe(4);
    expect(result.projection_unavailable_reason).toBeNull();

    const day = "2026-06-21";
    const periodStart = "2026-06-01";
    const obsRows = store.getObservations("site_c").filter((o) => {
      const d = o.timestamp.slice(0, 10);
      return d >= periodStart && d <= day;
    });
    // site_c is the null-hole path: days 3–4 have 4 missing generation hours each
    // (export null on those rows). Observed days still count via load/import presence.
    const missingGen = obsRows.filter((o) => o.generationKwh == null);
    expect(missingGen.length).toBe(8); // 4 hours × 2 data_issue days
    expect(missingGen.every((o) => o.exportKwh == null)).toBe(true);

    const days = new Set<string>();
    for (const o of obsRows) {
      if (o.loadKwh != null || o.importKwh != null || o.exportKwh != null) {
        days.add(o.timestamp.slice(0, 10));
      }
    }
    expect(days.size).toBe(4);

    let gen = 0;
    let load = 0;
    let imp = 0;
    let exp = 0;
    for (const o of obsRows) {
      if (!days.has(o.timestamp.slice(0, 10))) continue;
      if (o.generationKwh != null) gen += o.generationKwh;
      if (o.loadKwh != null) load += o.loadKwh;
      if (o.importKwh != null) imp += o.importKwh;
      if (o.exportKwh != null) exp += o.exportKwh;
    }

    expect(result.observed_to_date.generation_kwh).toBe(round(gen));
    expect(result.observed_to_date.load_kwh).toBe(round(load));
    expect(result.observed_to_date.import_kwh).toBe(round(imp));
    expect(result.observed_to_date.export_kwh).toBe(round(exp));
    expect(result.observed_to_date.self_consumed_kwh).toBe(round(gen - exp));

    // F12/F16 full-precision pins:
    // raw export 3669.3799999999997 × (30/4) = 27520.35
    // raw import 13103.01 × (30/4) = 98272.575 → 98272.58
    // MAQ = 950 × 5 × 30 = 142500
    // offsettable = min(27520.35, 98272.575, 142500) = 27520.35  (export-bound)
    // forfeited = 0
    // creditRm = 27520.35 × 0.1893 = 5209.602255 → 5209.6
    // energyChg = 98272.575 × 0.2703 = 26563.0770225 → 26563.08
    // net = 26563.0770225 − 5209.602255 = 21353.4747675 → 21353.47
    // smpSpread = 27520.35 × 0.3175 = 8737.711125 → 8737.71  (pure spread; forfeited 0)
    expect(round(exp)).toBe(3669.38);
    expect(round(imp)).toBe(13103.01);
    expect(result.maq_kwh).toBe(142_500); // 950 × 5 × 30

    expect(result.projection!.export_kwh).toBe(27520.35);
    expect(result.projection!.import_kwh).toBe(98272.58);
    expect(result.projection!.offsettable_export_kwh).toBe(27520.35);
    expect(result.projection!.forfeited_export_kwh).toBe(0);
    expect(result.projection!.credit_rm).toBe(5209.6);
    expect(result.projection!.forfeited_credit_rm).toBe(0);
    expect(result.projection!.energy_charge_rm).toBe(26563.08);
    expect(result.projection!.net_energy_charge_rm).toBe(21353.47);
    // F17: site_c is export-bound — net (energy-only residual) ≠ smpSpread (stack−SMP)
    // even under the pre-F3 energy-only spread; with F3 the gap is larger.
    expect(result.value_leak!.smp_spread_rm).toBe(8737.71);
    expect(result.value_leak!.forfeited_credit_rm).toBe(0);
    expect(result.value_leak!.floored_credit_lost_rm).toBe(0);
    expect(result.value_leak!.total_rm).toBe(8737.71);
    expect(result.projection!.net_energy_charge_rm).not.toBe(result.value_leak!.smp_spread_rm);
  });

  it("site_b (2500 kWp) returns ineligible with no projections", () => {
    const result = svc().atapCreditClock("site_b");
    expect(result.eligibility.eligible).toBe(false);
    expect(result.eligibility.reason).toContain("exceeds 1,000 kWac");
    expect(result.projection).toBeNull();
    expect(result.value_leak).toBeNull();
  });

  it("site_c (950 kWp) is ATAP-eligible under the 1,000 kWac cap", () => {
    const result = svc().atapCreditClock("site_c");
    expect(result.eligibility.eligible).toBe(true);
    expect(result.eligibility.reason).toBeNull();
    expect(result.projection).not.toBeNull();
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

  it("stated assumptions include kWp-as-kWac proxy, AFA exclusion, and load-shift spread note", () => {
    const result = svc().atapCreditClock("site_a");
    const joined = result.assumptions.join(" | ");
    expect(joined).toMatch(/kWp.*kWac proxy/i);
    expect(joined).toMatch(/AFA/i);
    expect(joined).toMatch(/linear_daily_mean/);
    expect(joined).toMatch(/2026-05/);
    expect(joined).toMatch(/LV volumetric stack/);
    expect(joined).toMatch(/load-shift|self-consumption/i);
  });

  it("threads now into source_manifest.generatedAt (deterministic)", () => {
    const fixed = "2026-06-22T09:00:00+08:00";
    const result = svc().atapCreditClock("site_a", "2026-06-21", fixed);
    expect(result.source_manifest.generatedAt).toBe(fixed);
  });
});
