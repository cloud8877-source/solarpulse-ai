/**
 * KREDIT closed-period verifier + expiry sweep (I6).
 *
 * Deterministic only — no LLM involvement in this increment.
 * Grades are permanent (ledger setVerification). Refuses any period whose
 * period_end >= today (partial-month grading would lock wrong verdicts).
 *
 * If a future increment exposes a verify tool, its schema must exclude
 * outcome / measuredRm (model must never author grades). No verify tool
 * exists today — asserted by tests against the tool registry.
 */

import { assumptions } from "../config/assumptions";
import type { ActionLedger } from "../data/ledger";
import type {
  ActionCommitment,
  ActionVerification,
  PolicyDecision,
} from "../domain/actions";
import { billingPeriodBounds } from "../engine/atap";
import {
  SolarOpsError,
  type SolarOpsService,
} from "../services/solarops";

export type VerificationRowResult = {
  action_id: string;
  site_id: string;
  kind: string;
  disposition: "graded" | "expired" | "issued_then_graded" | "skipped";
  outcome?: ActionVerification["outcome"];
  measured_rm?: number | null;
  note: string;
};

export type VerificationRunResult = {
  period_end: string;
  period_start: string;
  graded: number;
  expired: number;
  skipped: number;
  issued_then_graded: number;
  rows: VerificationRowResult[];
  assumptions: string[];
};

export type RunVerificationOpts = {
  /** Closed billing period end (YYYY-MM-DD). Must be last day of its month. */
  periodEnd: string;
  /** ISO now (or any timestamp with a local date); used for closed-period gate. */
  now: string;
  svc: SolarOpsService;
  ledger: ActionLedger;
};

/** Local (+08) calendar day from an ISO timestamp or bare YYYY-MM-DD. */
function localDateKey(timestamp: string): string {
  const bare = timestamp.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(bare)) return bare;
  const ms = Date.parse(bare);
  if (!Number.isFinite(ms)) {
    throw new SolarOpsError("illegal_field", `Cannot parse now/date '${timestamp}'`);
  }
  const myt = new Date(ms + 8 * 60 * 60 * 1000);
  const y = myt.getUTCFullYear();
  const m = String(myt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(myt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Grade measuredRm vs claimed rmImpact using config bands only (B2).
 * Never hardcode the thresholds in the grader.
 */
export function gradeMeasuredRm(
  measuredRm: number,
  rmImpact: number,
  bands: { verifyTolerancePct: number; partialFloorPct: number } = {
    verifyTolerancePct: assumptions.kredit.verifyTolerancePct,
    partialFloorPct: assumptions.kredit.partialFloorPct,
  },
): "verified" | "partial" | "falsified" {
  if (rmImpact <= 0) {
    // Non-positive claim: any non-negative measured is "verified"; negative falsified.
    return measuredRm >= 0 ? "verified" : "falsified";
  }
  if (measuredRm >= rmImpact * (1 - bands.verifyTolerancePct)) return "verified";
  if (measuredRm >= rmImpact * bands.partialFloorPct) return "partial";
  return "falsified";
}

function deadlineInPeriod(
  deadline: string,
  periodStart: string,
  periodEnd: string,
): boolean {
  const d = deadline.slice(0, 10);
  return d >= periodStart && d <= periodEnd;
}

function gradeBandAssumptions(): string[] {
  const t = assumptions.kredit.verifyTolerancePct;
  const p = assumptions.kredit.partialFloorPct;
  const floor = assumptions.kredit.verifyCoverageFloor;
  return [
    `verifyTolerancePct=${t}: verified when measuredRm >= rmImpact × (1 − ${t})`,
    `partialFloorPct=${p}: partial when measuredRm >= rmImpact × ${p}; else falsified`,
    `verifyCoverageFloor=${floor}: below this, verification is REFUSED (insufficient_coverage) and the action is left ungraded — a full-period claim cannot be graded against partial actuals`,
  ];
}

/**
 * Run closed-period verification + expiry for one billing period.
 *
 * Decisions disclosed:
 *  - Auto-escalates (rmImpact null / non load_shift): SKIPPED with note
 *    (no RM claim to grade) — not auto-verified.
 *  - Stranded approved rows with closed-period deadlines: issueAction first
 *    (honors the recorded human signature), then grade.
 *  - Coverage gate: if observed_days/days_in_period < verifyCoverageFloor,
 *    SKIP (insufficient_coverage) — do NOT write a permanent grade (a
 *    full-period claim cannot be graded against partial-period actuals).
 *  - proposed→expired remains illegal (no path strands at proposed).
 */
export async function runVerification(
  opts: RunVerificationOpts,
): Promise<VerificationRunResult> {
  const periodEnd = opts.periodEnd.slice(0, 10);
  const { periodStart, periodEnd: expectedEnd } = billingPeriodBounds(periodEnd);
  if (periodEnd !== expectedEnd) {
    throw new SolarOpsError(
      "illegal_field",
      `period_end must be the last calendar day of the billing period (got '${periodEnd}', expected '${expectedEnd}')`,
    );
  }

  const today = localDateKey(opts.now);
  // Grades are permanent — refuse open / current periods.
  if (periodEnd >= today) {
    throw new SolarOpsError(
      "period_not_closed",
      `period_not_closed: period_end ${periodEnd} is not before today ${today}`,
    );
  }

  const { svc, ledger } = opts;
  const nowIso =
    opts.now.includes("T") ? opts.now : `${opts.now.slice(0, 10)}T12:00:00+08:00`;

  // Demo-scale bound: load a capped action set and filter in-process.
  const all = await ledger.listActions({ limit: 500 });
  const inPeriod = all.filter((a) =>
    deadlineInPeriod(a.deadline, periodStart, periodEnd),
  );

  const rows: VerificationRowResult[] = [];
  let graded = 0;
  let expired = 0;
  let skipped = 0;
  let issuedThenGraded = 0;

  const bandAssumptions = gradeBandAssumptions();

  // Cache realized values per site (one engine call per site in this period).
  const realizedBySite = new Map<
    string,
    ReturnType<SolarOpsService["atapRealizedValue"]>
  >();
  function realizedFor(siteId: string) {
    let r = realizedBySite.get(siteId);
    if (!r) {
      r = svc.atapRealizedValue(siteId, periodEnd, nowIso);
      realizedBySite.set(siteId, r);
    }
    return r;
  }

  // --- EXPIRY: awaiting_approval with closed-period deadline ---
  for (const a of inPeriod) {
    if (a.status !== "awaiting_approval") continue;
    const policy: PolicyDecision = {
      policyId: "period_closed_unsigned",
      outcome: "deny",
      reason: "credit forfeited — action was never signed before period end",
    };
    const updated = await svc.expireAction(a.id, {
      policyDecisions: [...a.policyDecisions, policy],
      decidedAt: nowIso,
    });
    expired += 1;
    rows.push({
      action_id: updated.id,
      site_id: updated.siteId,
      kind: updated.kind,
      disposition: "expired",
      note: policy.reason,
    });
  }

  // --- STRANDED APPROVED: issue first (honor signature), then grade below ---
  const strandedIssuedIds = new Set<string>();
  for (const a of inPeriod) {
    if (a.status !== "approved") continue;
    const issued = await svc.issueAction(a.id);
    strandedIssuedIds.add(issued.id);
    // Fall through to grading via re-fetch path below.
  }

  // Re-load after expiry + stranded issue so grades see current status.
  const after = await ledger.listActions({ limit: 500 });
  const gradeCandidates = after.filter(
    (a) =>
      deadlineInPeriod(a.deadline, periodStart, periodEnd) &&
      a.status === "issued",
  );

  for (const a of gradeCandidates) {
    if (a.verification !== null) {
      skipped += 1;
      rows.push({
        action_id: a.id,
        site_id: a.siteId,
        kind: a.kind,
        disposition: "skipped",
        outcome: a.verification.outcome,
        measured_rm: a.verification.measuredRm,
        note: "verification_already_set — skipped (idempotent)",
      });
      continue;
    }

    // Only load_shift with a non-null RM claim is graded on meters.
    if (a.kind !== "load_shift" || a.rmImpact == null) {
      // DISCLOSE: auto-escalates / null-RM rows are skipped (not auto-verified).
      skipped += 1;
      rows.push({
        action_id: a.id,
        site_id: a.siteId,
        kind: a.kind,
        disposition: "skipped",
        note:
          a.kind === "escalate" || a.rmImpact == null
            ? "escalation/no-RM-claim skipped — no meter grade (escalation completed without RM claim)"
            : `kind ${a.kind} not graded in this increment (load_shift only)`,
      });
      continue;
    }

    const realized = realizedFor(a.siteId);
    const coverageRatio =
      realized.days_in_period > 0
        ? realized.observed_days / realized.days_in_period
        : 0;
    const floor = assumptions.kredit.verifyCoverageFloor;

    // Coverage gate: refuse permanent grades on partial-period actuals.
    // Spurious FALSIFIED cannot be corrected (verification_already_set).
    // Period is deadline-pinned (e.g. June); coverage never grows for this
    // closed period, so the action is PERMANENTLY ungraded — not deferred.
    if (coverageRatio < floor) {
      skipped += 1;
      const pct = (coverageRatio * 100).toFixed(1);
      const floorPct = (floor * 100).toFixed(0);
      rows.push({
        action_id: a.id,
        site_id: a.siteId,
        kind: a.kind,
        disposition: "skipped",
        note:
          `insufficient_coverage: ${realized.observed_days}/${realized.days_in_period} days observed ` +
          `(${pct}% < floor ${floorPct}%) — a full-period claim cannot be graded against a ` +
          `partial-period actual; action left ungraded`,
      });
      continue;
    }

    const measuredRm = realized.smp_spread_rm;
    const outcome = gradeMeasuredRm(measuredRm, a.rmImpact);
    const coverageNote = `coverage ${realized.observed_days}/${realized.days_in_period} days observed`;

    const vAssumptions = [
      ...bandAssumptions,
      coverageNote,
      ...realized.assumptions,
      `claimed rmImpact=RM ${a.rmImpact}; measuredRm=RM ${measuredRm} (realized smp_spread_rm)`,
      `export_kwh=${realized.export_kwh}; import_kwh=${realized.import_kwh}; daylight_import_kwh=${realized.daylight_import_kwh}; load_shiftable_export_kwh=${realized.load_shiftable_export_kwh}`,
    ];

    const verification: ActionVerification = {
      outcome,
      measuredRm,
      note:
        `${outcome}: measured RM ${measuredRm} vs claimed RM ${a.rmImpact} ` +
        `(tolerance ${(assumptions.kredit.verifyTolerancePct * 100).toFixed(0)}% / ` +
        `partial floor ${(assumptions.kredit.partialFloorPct * 100).toFixed(0)}%). ` +
        coverageNote,
      verifiedAt: nowIso,
      assumptions: vAssumptions,
    };

    const gradedRow = await svc.verifyAction(a.id, verification);
    const wasStranded = strandedIssuedIds.has(a.id);
    if (wasStranded) issuedThenGraded += 1;
    graded += 1;
    rows.push({
      action_id: gradedRow.id,
      site_id: gradedRow.siteId,
      kind: gradedRow.kind,
      disposition: wasStranded ? "issued_then_graded" : "graded",
      outcome,
      measured_rm: measuredRm,
      note: verification.note,
    });
  }

  return {
    period_end: periodEnd,
    period_start: periodStart,
    graded,
    expired,
    skipped,
    issued_then_graded: issuedThenGraded,
    rows,
    assumptions: [
      ...bandAssumptions,
      "period gate: period_end must be strictly before today (local +08)",
      "coverage gate: observed_days/days_in_period < verifyCoverageFloor → skipped (insufficient_coverage), action left ungraded",
      "stranded approved → issueAction then grade (honors recorded signature)",
      "awaiting_approval with closed deadline → expired (period_closed_unsigned)",
      "auto-escalate / null-RM issued rows skipped (no RM claim to grade)",
      "re-grade refused by ledger (verification_already_set) → skipped idempotently",
    ],
  };
}

/** @deprecated internal helper re-export for tests that inspect ActionCommitment after run. */
export type { ActionCommitment };
