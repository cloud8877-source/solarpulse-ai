/**
 * Solar ATAP credit-clock engine — pure, deterministic, no I/O (ADR-0005).
 *
 * Regulatory basis — Malaysia Solar ATAP, gazette GP/ST/No.60/2025
 * (Suruhanjaya Tenaga, effective 1 Jan 2026, Peninsular Malaysia):
 * https://www.st.gov.my/sites/default/files/2026-03/GUIDELINES-FOR-SOLAR-ACCELERATED_0.pdf
 *
 * Clauses implemented exactly:
 * - Section 2 definition: Non-Domestic exported energy is credited at Average SMP
 *   = monthly average System Marginal Price for 07:00–19:00 of the PRECEDING
 *   calendar month (price known at billing-period start; callers pass that entry).
 * - Clause 3.6.1(b): exported energy, up to the MAQ, may offset electricity imported
 *   within the SAME Billing Period; unused offset credit is NOT carried forward and
 *   is FORFEITED at period end.
 * - Additional forfeiture: exported energy exceeding the electricity imported from
 *   the utility OR the MAQ (whichever lower) in the period is forfeited; a negative
 *   net bill is floored at zero (no cash out).
 * - MAQ = capacity (kWac) × 5 sun-hours × days in Billing Period (section 2).
 * - Credits cannot offset the AFA (Automatic Fuel Adjustment) component — this engine
 *   models the energy charge only.
 * - Eligibility (non-domestic): PV capacity up to 100% of Maximum Demand, HARD CAP
 *   1,000 kWac. Capacity fields here are kWp used as a kWac proxy (stated assumption).
 * - Net energy charge (Pricing and Tariff section):
 *   Net (RM) = (Energy imported × prevailing gazetted Energy rate)
 *            − (Energy exported × Average SMP), floored at zero.
 */

import type { Assumptions } from "../config/assumptions";
import type { Observation, SourceType } from "../domain/types";
import { round } from "./math";

export interface AtapSiteInput {
  id: string;
  capacityKwp: number;
  /** Resolved retail energy rate for this site (RM/kWh). */
  tariffRmPerKwh: number;
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
  /** Distinct days with any non-null load or export data. */
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
  /** Headline "RM evaporating" = smpSpreadRm + forfeitedCreditRm. */
  totalRm: number;
}

export interface AtapCreditClockResult {
  eligibility: AtapEligibility;
  coverage: AtapCoverage;
  observedToDate: AtapObservedToDate;
  maqKwh: number;
  /** null when the site is ineligible (no financial projections). */
  projection: AtapProjection | null;
  /** null when the site is ineligible (no financial projections). */
  valueLeak: AtapValueLeak | null;
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

/**
 * Compute the ATAP credit-clock for one site and billing period.
 * All RM rounded to 2 dp; all kWh rounded to 2 dp on output.
 */
export function computeAtapCreditClock(input: AtapCreditClockInput): AtapCreditClockResult {
  const { site, observations, asOfDate, averageSmp, assumptions: A } = input;
  const { periodStart, periodEnd, daysInPeriod } = billingPeriodBounds(asOfDate);
  const daysRemaining = calendarDaysBetween(asOfDate, periodEnd);

  // --- Eligibility (hard cap 1,000 kWac; kWp used as kWac proxy) ---
  const cap = A.atap.nonDomesticCapKwac;
  const eligible = site.capacityKwp <= cap;
  const eligibility: AtapEligibility = eligible
    ? { eligible: true, reason: null }
    : {
        eligible: false,
        reason: `exceeds 1,000 kWac non-domestic cap, GP/ST/No.60/2025`,
      };

  // --- Observed sums: null intervals excluded (never treated as 0) ---
  const generationKwhRaw = sumNullable(observations.map((o) => o.generationKwh));
  const loadKwhRaw = sumNullable(observations.map((o) => o.loadKwh));
  const importKwhRaw = sumNullable(observations.map((o) => o.importKwh));
  const exportKwhRaw = sumNullable(observations.map((o) => o.exportKwh));

  const observedDaySet = new Set<string>();
  for (const o of observations) {
    if (o.loadKwh != null || o.exportKwh != null) {
      observedDaySet.add(dateKey(o.timestamp));
    }
  }
  const observedDays = observedDaySet.size;

  const generationKwh = round(generationKwhRaw);
  const loadKwh = round(loadKwhRaw);
  const importKwh = round(importKwhRaw);
  const exportKwh = round(exportKwhRaw);
  const selfConsumedKwh = round(generationKwhRaw - exportKwhRaw);
  const selfConsumptionRatio =
    generationKwhRaw === 0 ? null : round(selfConsumedKwh / generationKwhRaw, 4);

  // MAQ = capacity (kWac proxy) × sun-hours × days in Billing Period (gazette §2).
  const maqKwh = round(site.capacityKwp * A.atap.sunHoursPerDay * daysInPeriod);

  const statedAssumptions: string[] = [
    A.atap.kwpAsKwacProxy
      ? "capacity kWp used as kWac proxy (site capacity fields are kWp, not measured kWac)"
      : "capacity treated as kWac",
    `Average SMP for preceding month ${averageSmp.monthLabel}: RM ${averageSmp.rmPerKwh}/kWh (${averageSmp.provenance}; ${averageSmp.source})`,
    `retail energy tariff RM ${site.tariffRmPerKwh}/kWh (energy charge only; site override or config retailTariffRmPerKwh)`,
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
      `ineligible: capacity ${site.capacityKwp} kWp exceeds non-domestic hard cap ${cap} kWac`,
    );
    return {
      eligibility,
      coverage,
      observedToDate,
      maqKwh,
      projection: null,
      valueLeak: null,
      assumptions: statedAssumptions,
    };
  }

  // --- Full-period linear projection from observed daily means ---
  statedAssumptions.push(
    `projection method: linear_daily_mean over ${observedDays} observed day(s) × ${daysInPeriod} days in period`,
  );

  const dailyMeanExport = observedDays > 0 ? exportKwhRaw / observedDays : 0;
  const dailyMeanImport = observedDays > 0 ? importKwhRaw / observedDays : 0;
  const projectedExport = dailyMeanExport * daysInPeriod;
  const projectedImport = dailyMeanImport * daysInPeriod;

  // offsettable = min(export, import, MAQ); remainder of export is forfeited.
  const offsettableExportKwhRaw = Math.min(projectedExport, projectedImport, maqKwh);
  const forfeitedExportKwhRaw = Math.max(0, projectedExport - offsettableExportKwhRaw);

  const creditRmRaw = offsettableExportKwhRaw * averageSmp.rmPerKwh;
  const forfeitedCreditRmRaw = forfeitedExportKwhRaw * averageSmp.rmPerKwh;
  const energyChargeRmRaw = projectedImport * site.tariffRmPerKwh;
  // Net floored at zero — no cash out for a negative bill.
  const netEnergyChargeRmRaw = Math.max(0, energyChargeRmRaw - creditRmRaw);

  // Value leak: SMP-vs-retail spread on offsettable export + forfeited credit RM.
  const smpSpreadRmRaw = offsettableExportKwhRaw * (site.tariffRmPerKwh - averageSmp.rmPerKwh);
  const totalLeakRaw = smpSpreadRmRaw + forfeitedCreditRmRaw;

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
    totalRm: round(totalLeakRaw),
  };

  return {
    eligibility,
    coverage,
    observedToDate,
    maqKwh,
    projection,
    valueLeak,
    assumptions: statedAssumptions,
  };
}
