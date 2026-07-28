/**
 * Solar ATAP credit-clock engine — pure, deterministic, no I/O (ADR-0005).
 *
 * Regulatory basis — Malaysia Solar ATAP, gazette GP/ST/No.60/2025
 * (Suruhanjaya Tenaga, effective 1 Jan 2026, Peninsular Malaysia):
 * https://www.st.gov.my/sites/default/files/2026-03/GUIDELINES-FOR-SOLAR-ACCELERATED_0.pdf
 *
 * Clauses implemented (full sequence; the math is correct and matches these):
 *
 * - Section 2 definition: Non-Domestic exported energy is credited at Average SMP
 *   = monthly average System Marginal Price for 07:00–19:00 of the PRECEDING
 *   calendar month (price known at billing-period start; callers pass that entry).
 *
 * - Clause 3.6.1(b): "The exported Energy, up to the MAQ, may be used to offset
 *   the electricity imported or consumed from the EUC within the same Billing
 *   Period. Any exported energy that remains unutilized for offset purposes in
 *   the same Billing Period shall not be carried forward to subsequent billing
 *   periods and shall be deemed forfeited."
 *
 * - Settlement clause (d): "If the Energy exported exceeds the electricity
 *   consumed from the EUC or the MAQ, whichever is lower, during the Billing
 *   Period, such excess of the exported energy shall be forfeited."
 *   Implemented as offsettableExport = min(export, import, MAQ); remainder forfeited.
 *
 * - Pricing (Pricing and Tariff section), applied to the TRIMMED (offsettable) export:
 *   "Net Energy charge (RM) = (Energy imported × prevailing gazetted Energy rate)
 *    − (Energy export × Average SMP)"
 *
 * - Clause (e): negative net floored at zero (no cash out). The floor is normally
 *   unreachable for non-domestic (SMP < retail energy rate after the kWh trim) but
 *   kept per clause (e); reachable for domestic (credit rate = Energy Charge) and
 *   for synthetic low-tariff cases. Credit lost above the bill is tracked as
 *   valueLeak.flooredCreditLostRm.
 *
 * - MAQ = capacity (kWac) × 5 sun-hours × days in Billing Period (section 2).
 * - Credits cannot offset the AFA (Automatic Fuel Adjustment) component — this
 *   engine models the energy charge only for the bill; SMP-spread value-leak uses
 *   the full LV volumetric stack (energy + capacity + network) as the avoided-cost
 *   rate for LV sites (operational self-consumption value), or the energy charge
 *   alone for MV (capacity/network are RM/kW demand charges, not volumetric).
 * - Eligibility (non-domestic): PV capacity up to 100% of Maximum Demand, HARD CAP
 *   1,000 kWac. Capacity fields here are kWp used as a kWac proxy (stated assumption).
 */

import type { Assumptions } from "../config/assumptions";
import type { Observation, SourceType, TariffCategory } from "../domain/types";
import { round } from "./math";

export interface AtapSiteInput {
  id: string;
  capacityKwp: number;
  /** Resolved retail energy rate for this site (RM/kWh) — bill energy charge. */
  tariffRmPerKwh: number;
  /** Tariff category for avoided-cost stack selection (default lv_general). */
  tariffCategory?: TariffCategory;
}

export interface AtapAverageSmp {
  rmPerKwh: number;
  /** Preceding calendar month label, e.g. "2026-05". */
  monthLabel: string;
  provenance: SourceType;
  source: string;
}

export interface AtapCreditClockInput {
  site: AtapSiteInput;
  /** Site observations already scoped to the billing period up to asOfDate. */
  observations: Observation[];
  asOfDate: string; // YYYY-MM-DD
  averageSmp: AtapAverageSmp;
  assumptions: Assumptions;
}

export interface AtapEligibility {
  eligible: boolean;
  reason: string | null;
}

export interface AtapCoverage {
  periodStart: string;
  periodEnd: string;
  daysInPeriod: number;
  /**
   * Distinct days where any of load / import / export is non-null.
   * Daily-mean projections only use rows belonging to these counted days.
   */
  observedDays: number;
  asOfDate: string;
  /** Calendar days from asOfDate to periodEnd (inclusive of end, exclusive of asOf). */
  daysRemaining: number;
}

export interface AtapObservedToDate {
  generationKwh: number;
  loadKwh: number;
  importKwh: number;
  exportKwh: number;
  selfConsumedKwh: number;
  /** null when generation is 0. */
  selfConsumptionRatio: number | null;
}

export interface AtapProjection {
  method: "linear_daily_mean";
  observedDays: number;
  exportKwh: number;
  importKwh: number;
  offsettableExportKwh: number;
  forfeitedExportKwh: number;
  creditRm: number;
  forfeitedCreditRm: number;
  energyChargeRm: number;
  netEnergyChargeRm: number;
}

export interface AtapValueLeak {
  /** RM that could be saved by self-consuming offsettable export instead of exporting at SMP. */
  smpSpreadRm: number;
  forfeitedCreditRm: number;
  /** Credit that would have pushed the net bill below zero (clause (e) floor). */
  flooredCreditLostRm: number;
  /** Headline "RM evaporating" = smpSpreadRm + forfeitedCreditRm + flooredCreditLostRm. */
  totalRm: number;
}

export type AtapProjectionUnavailableReason = "insufficient_data";

export interface AtapCreditClockResult {
  eligibility: AtapEligibility;
  coverage: AtapCoverage;
  observedToDate: AtapObservedToDate;
  maqKwh: number;
  /** null when the site is ineligible or observedDays === 0. */
  projection: AtapProjection | null;
  /** null when the site is ineligible or observedDays === 0. */
  valueLeak: AtapValueLeak | null;
  /**
   * Set when projection is null for a non-eligibility reason (e.g. zero coverage).
   * Ineligible sites leave this null (reason is on eligibility).
   */
  projectionUnavailableReason: AtapProjectionUnavailableReason | null;
  assumptions: string[];
}

function ymdParts(isoDate: string): { year: number; month: number; day: number } {
  return {
    year: Number(isoDate.slice(0, 4)),
    month: Number(isoDate.slice(5, 7)),
    day: Number(isoDate.slice(8, 10)),
  };
}

/** Days in the calendar month of YYYY-MM-DD (UTC date arithmetic — fixtures are +08:00 dates). */
export function daysInCalendarMonth(isoDate: string): number {
  const { year, month } = ymdParts(isoDate);
  // Date.UTC(year, month, 0) = last day of previous month; month is 1-indexed here so month is correct.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function billingPeriodBounds(asOfDate: string): {
  periodStart: string;
  periodEnd: string;
  daysInPeriod: number;
} {
  const { year, month } = ymdParts(asOfDate);
  const daysInPeriod = daysInCalendarMonth(asOfDate);
  const mm = String(month).padStart(2, "0");
  return {
    periodStart: `${year}-${mm}-01`,
    periodEnd: `${year}-${mm}-${String(daysInPeriod).padStart(2, "0")}`,
    daysInPeriod,
  };
}

/** Whole calendar days from `from` to `to` (YYYY-MM-DD), can be negative if from > to. */
export function calendarDaysBetween(from: string, to: string): number {
  const a = ymdParts(from);
  const b = ymdParts(to);
  const msA = Date.UTC(a.year, a.month - 1, a.day);
  const msB = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((msB - msA) / 86_400_000);
}

function dateKey(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function sumNullable(values: Array<number | null | undefined>): number {
  let total = 0;
  for (const v of values) {
    if (v != null) total += v;
  }
  return total;
}

/** Full LV volumetric stack (energy + capacity + network), RM/kWh. */
export function lvVolumetricStackRmPerKwh(A: Assumptions): number {
  const c = A.lvVolumetricComponents;
  // 4 dp matches the component literals (0.2703 + 0.0883 + 0.1482 = 0.5068).
  return round(c.energyRmPerKwh + c.capacityRmPerKwh + c.networkRmPerKwh, 4);
}

/**
 * Avoided-cost rate for SMP-spread value leak.
 * LV: full volumetric stack. MV: energy charge only (capacity/network are demand charges).
 */
export function avoidedCostRmPerKwh(
  site: AtapSiteInput,
  A: Assumptions,
): { rate: number; label: string } {
  const category = site.tariffCategory ?? "lv_general";
  if (category === "mv_general") {
    return {
      rate: site.tariffRmPerKwh,
      label: `MV energy charge RM ${site.tariffRmPerKwh}/kWh (capacity/network are RM/kW demand charges, not volumetric)`,
    };
  }
  const stack = lvVolumetricStackRmPerKwh(A);
  const c = A.lvVolumetricComponents;
  return {
    rate: stack,
    label:
      `LV volumetric stack RM ${stack}/kWh ` +
      `(energy ${c.energyRmPerKwh} + capacity ${c.capacityRmPerKwh} + network ${c.networkRmPerKwh})`,
  };
}

/**
 * Compute the ATAP credit-clock for one site and billing period.
 * All RM rounded to 2 dp; all kWh rounded to 2 dp on output.
 */
export function computeAtapCreditClock(input: AtapCreditClockInput): AtapCreditClockResult {
  const { site, observations, asOfDate, averageSmp, assumptions: A } = input;
  const { periodStart, periodEnd, daysInPeriod } = billingPeriodBounds(asOfDate);
  const daysRemaining = calendarDaysBetween(asOfDate, periodEnd);

  // --- Eligibility (hard cap from config; kWp used as kWac proxy) ---
  const cap = A.atap.nonDomesticCapKwac;
  const capLabel = cap.toLocaleString("en-US");
  const eligible = site.capacityKwp <= cap;
  const eligibility: AtapEligibility = eligible
    ? { eligible: true, reason: null }
    : {
        eligible: false,
        reason: `exceeds ${capLabel} kWac non-domestic cap, GP/ST/No.60/2025`,
      };

  // --- Observed days: any of load / import / export non-null ---
  const observedDaySet = new Set<string>();
  for (const o of observations) {
    if (o.loadKwh != null || o.importKwh != null || o.exportKwh != null) {
      observedDaySet.add(dateKey(o.timestamp));
    }
  }
  const observedDays = observedDaySet.size;

  // Sums draw only from rows belonging to counted days (no uncounted-day inflation).
  const countedRows = observations.filter((o) => observedDaySet.has(dateKey(o.timestamp)));
  const generationKwhRaw = sumNullable(countedRows.map((o) => o.generationKwh));
  const loadKwhRaw = sumNullable(countedRows.map((o) => o.loadKwh));
  const importKwhRaw = sumNullable(countedRows.map((o) => o.importKwh));
  const exportKwhRaw = sumNullable(countedRows.map((o) => o.exportKwh));

  const generationKwh = round(generationKwhRaw);
  const loadKwh = round(loadKwhRaw);
  const importKwh = round(importKwhRaw);
  const exportKwh = round(exportKwhRaw);
  // self-consumption ratio: raw/raw then round at output (never round-then-divide).
  const selfConsumedKwhRaw = generationKwhRaw - exportKwhRaw;
  const selfConsumedKwh = round(selfConsumedKwhRaw);
  const selfConsumptionRatio =
    generationKwhRaw === 0 ? null : round(selfConsumedKwhRaw / generationKwhRaw, 4);

  // MAQ = capacity (kWac proxy) × sun-hours × days in Billing Period (gazette §2).
  const maqKwh = round(site.capacityKwp * A.atap.sunHoursPerDay * daysInPeriod);

  const avoided = avoidedCostRmPerKwh(site, A);

  const statedAssumptions: string[] = [
    A.atap.kwpAsKwacProxy
      ? "capacity kWp used as kWac proxy (site capacity fields are kWp, not measured kWac)"
      : "capacity treated as kWac",
    `Average SMP for preceding month ${averageSmp.monthLabel}: RM ${averageSmp.rmPerKwh}/kWh (${averageSmp.provenance}; ${averageSmp.source})`,
    `retail energy tariff RM ${site.tariffRmPerKwh}/kWh (energy charge only for net bill; site override or config retailTariffRmPerKwh)`,
    `smpSpreadRm avoided-cost rate: ${avoided.label}`,
    "smpSpreadRm assumes offsettable exported energy could be shifted to self-consumption (load-shift / scheduling) — operational assumption, not a gazette requirement",
    "AFA (Automatic Fuel Adjustment) excluded — credits cannot offset AFA (GP/ST/No.60/2025)",
    `MAQ = ${site.capacityKwp} kWp × ${A.atap.sunHoursPerDay} sun-hours × ${daysInPeriod} days = ${maqKwh} kWh (gazette §2)`,
    "unused ATAP offset credit is forfeited at billing-period end (clause 3.6.1(b); no carry-forward)",
  ];

  const coverage: AtapCoverage = {
    periodStart,
    periodEnd,
    daysInPeriod,
    observedDays,
    asOfDate,
    daysRemaining,
  };

  const observedToDate: AtapObservedToDate = {
    generationKwh,
    loadKwh,
    importKwh,
    exportKwh,
    selfConsumedKwh,
    selfConsumptionRatio,
  };

  // Ineligible sites: no financial projections (gazette eligibility hard cap).
  if (!eligible) {
    statedAssumptions.push(
      `ineligible: capacity ${site.capacityKwp} kWp exceeds non-domestic hard cap ${capLabel} kWac`,
    );
    return {
      eligibility,
      coverage,
      observedToDate,
      maqKwh,
      projection: null,
      valueLeak: null,
      projectionUnavailableReason: null,
      assumptions: statedAssumptions,
    };
  }

  // Zero coverage: no all-zero pseudo-projection (mirror eligibility-null pattern).
  if (observedDays === 0) {
    statedAssumptions.push("projection unavailable: insufficient_data (observedDays = 0)");
    return {
      eligibility,
      coverage,
      observedToDate,
      maqKwh,
      projection: null,
      valueLeak: null,
      projectionUnavailableReason: "insufficient_data",
      assumptions: statedAssumptions,
    };
  }

  // --- Full-period linear projection from observed daily means ---
  statedAssumptions.push(
    `projection method: linear_daily_mean over ${observedDays} observed day(s) × ${daysInPeriod} days in period`,
  );

  const dailyMeanExport = exportKwhRaw / observedDays;
  const dailyMeanImport = importKwhRaw / observedDays;
  const projectedExport = dailyMeanExport * daysInPeriod;
  const projectedImport = dailyMeanImport * daysInPeriod;

  // offsettable = min(export, import, MAQ); remainder of export is forfeited (clause d).
  const offsettableExportKwhRaw = Math.min(projectedExport, projectedImport, maqKwh);
  const forfeitedExportKwhRaw = Math.max(0, projectedExport - offsettableExportKwhRaw);

  const creditRmRaw = offsettableExportKwhRaw * averageSmp.rmPerKwh;
  const forfeitedCreditRmRaw = forfeitedExportKwhRaw * averageSmp.rmPerKwh;
  const energyChargeRmRaw = projectedImport * site.tariffRmPerKwh;
  // Net floored at zero — clause (e); track credit lost above the bill.
  const preFloorNetRaw = energyChargeRmRaw - creditRmRaw;
  const flooredCreditLostRmRaw = preFloorNetRaw < 0 ? -preFloorNetRaw : 0;
  const netEnergyChargeRmRaw = Math.max(0, preFloorNetRaw);

  // Value leak: avoided-cost-vs-SMP spread on offsettable export + forfeited + floor.
  const smpSpreadRmRaw = offsettableExportKwhRaw * (avoided.rate - averageSmp.rmPerKwh);
  const totalLeakRaw = smpSpreadRmRaw + forfeitedCreditRmRaw + flooredCreditLostRmRaw;

  const projection: AtapProjection = {
    method: "linear_daily_mean",
    observedDays,
    exportKwh: round(projectedExport),
    importKwh: round(projectedImport),
    offsettableExportKwh: round(offsettableExportKwhRaw),
    forfeitedExportKwh: round(forfeitedExportKwhRaw),
    creditRm: round(creditRmRaw),
    forfeitedCreditRm: round(forfeitedCreditRmRaw),
    energyChargeRm: round(energyChargeRmRaw),
    netEnergyChargeRm: round(netEnergyChargeRmRaw),
  };

  const valueLeak: AtapValueLeak = {
    smpSpreadRm: round(smpSpreadRmRaw),
    forfeitedCreditRm: round(forfeitedCreditRmRaw),
    flooredCreditLostRm: round(flooredCreditLostRmRaw),
    totalRm: round(totalLeakRaw),
  };

  return {
    eligibility,
    coverage,
    observedToDate,
    maqKwh,
    projection,
    valueLeak,
    projectionUnavailableReason: null,
    assumptions: statedAssumptions,
  };
}
