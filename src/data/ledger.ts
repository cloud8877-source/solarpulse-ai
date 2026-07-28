// Durable action commitment ledger for the KREDIT agent.
// Sits BESIDE the sync in-memory SolarStore — never inside it.
// Local/dev/tests: InMemoryLedger. Workers: D1Ledger when KREDIT_LEDGER is bound.

import {
  actionId,
  sweepId,
  type ActionCommitment,
  type ActionStatus,
  type ActionVerification,
  type PolicyDecision,
  type SweepRun,
} from "../domain/actions";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type LedgerErrorCode =
  | "illegal_transition"
  | "not_found"
  | "verification_not_allowed";

export class LedgerError extends Error {
  constructor(
    public readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

// ---------------------------------------------------------------------------
// Transition guard (single shared implementation — BOTH backends call this)
// ---------------------------------------------------------------------------

/** Legal edges only. Reaching issued requires approved; approved requires decidedBy. */
const LEGAL_TRANSITIONS: Readonly<Record<ActionStatus, readonly ActionStatus[]>> = {
  proposed: ["awaiting_approval", "denied_by_policy"],
  awaiting_approval: ["approved", "denied_by_policy", "expired"],
  approved: ["issued"],
  issued: [],
  denied_by_policy: [],
  expired: [],
};

export interface TransitionMeta {
  decidedBy?: string;
  decidedAt?: string;
  policyDecisions?: PolicyDecision[];
}

/**
 * Load-bearing invariant for the action lifecycle.
 * Used by InMemoryLedger and D1Ledger before any storage write.
 */
export function assertLegalTransition(
  current: ActionStatus,
  next: ActionStatus,
  meta?: TransitionMeta,
): void {
  const allowed = LEGAL_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new LedgerError(
      "illegal_transition",
      `Illegal transition ${current} -> ${next}`,
    );
  }
  // CRITICAL: approved requires a human signature (decidedBy).
  if (next === "approved") {
    const signer = meta?.decidedBy?.trim();
    if (!signer) {
      throw new LedgerError(
        "illegal_transition",
        "Transition to approved requires meta.decidedBy (human signature)",
      );
    }
  }
  // CRITICAL: issued is only reachable from approved (already encoded above);
  // restate for explicit defense-in-depth.
  if (next === "issued" && current !== "approved") {
    throw new LedgerError(
      "illegal_transition",
      `Illegal transition ${current} -> issued (only approved may issue)`,
    );
  }
}

export function assertCanSetVerification(status: ActionStatus): void {
  if (status !== "issued") {
    throw new LedgerError(
      "verification_not_allowed",
      `Verification can only be set on status 'issued' (got '${status}')`,
    );
  }
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ActionListFilter {
  siteId?: string;
  status?: ActionStatus;
  sweepId?: string;
  limit?: number;
}

export interface ActionLedger {
  saveAction(a: ActionCommitment): Promise<void>;
  getAction(id: string): Promise<ActionCommitment | null>;
  listActions(filter?: ActionListFilter): Promise<ActionCommitment[]>;
  transitionAction(
    id: string,
    next: ActionStatus,
    meta?: TransitionMeta,
  ): Promise<ActionCommitment>;
  setVerification(id: string, v: ActionVerification): Promise<ActionCommitment>;
  saveSweep(s: SweepRun): Promise<void>;
  listSweeps(limit?: number): Promise<SweepRun[]>;
  latestSweep(): Promise<SweepRun | null>;
}

// ---------------------------------------------------------------------------
// Demo seed (deterministic fixtures for local/dev self-grading demo)
// ---------------------------------------------------------------------------

export interface DemoSeed {
  sweeps: SweepRun[];
  actions: ActionCommitment[];
}

/** Labeled prior sweep + 3 historical actions for the later self-grading demo beat. */
export function buildDemoSeed(nowIso: string): DemoSeed {
  const asOfDate = nowIso.slice(0, 10);
  const priorDate = shiftIsoDate(asOfDate, -7);
  const swp = sweepId(priorDate, 1);
  const createdBase = `${priorDate}T08:00:00+08:00`;

  const sweep: SweepRun = {
    id: swp,
    asOfDate: priorDate,
    startedAt: createdBase,
    siteCount: 3,
    proposedActions: 3,
    blockedActions: 1,
    notes: ["seed_fixture", "prior_sweep_for_self_grading_demo"],
  };

  const verified: ActionCommitment = {
    id: actionId("site_a", priorDate, 1),
    siteId: "site_a",
    sweepId: swp,
    kind: "load_shift",
    title: "[SEED] Shift chiller load earlier — verified",
    description:
      "Historical seed fixture: load shift completed and later meter-verified.",
    rmImpact: 420.5,
    kwhImpact: 1800,
    confidence: "high",
    evidenceRefs: ["seed_fixture", "demo_verified"],
    deadline: priorDate,
    approvalClass: "human_signature",
    status: "issued",
    policyDecisions: [
      {
        policyId: "pol_human_signature",
        outcome: "require_approval",
        reason: "RM impact above auto threshold",
      },
    ],
    verification: {
      outcome: "verified",
      measuredRm: 415.2,
      note: "seed_fixture: measured within band",
      verifiedAt: `${asOfDate}T10:00:00+08:00`,
    },
    createdAt: createdBase,
    decidedAt: `${priorDate}T09:00:00+08:00`,
    decidedBy: "seed_operator",
  };

  const falsified: ActionCommitment = {
    id: actionId("site_b", priorDate, 2),
    siteId: "site_b",
    sweepId: swp,
    kind: "reschedule_maintenance",
    title: "[SEED] Reschedule inverter clean — falsified",
    description:
      "Historical seed fixture: issued but later meter-falsified (no measured lift).",
    rmImpact: 210,
    kwhImpact: 900,
    confidence: "medium",
    evidenceRefs: ["seed_fixture", "demo_falsified"],
    deadline: priorDate,
    approvalClass: "human_signature",
    status: "issued",
    policyDecisions: [
      {
        policyId: "pol_human_signature",
        outcome: "require_approval",
        reason: "Maintenance window change needs sign-off",
      },
    ],
    verification: {
      outcome: "falsified",
      measuredRm: 12,
      note: "seed_fixture: no material RM lift after deadline",
      verifiedAt: `${asOfDate}T10:05:00+08:00`,
    },
    createdAt: `${priorDate}T08:05:00+08:00`,
    decidedAt: `${priorDate}T09:10:00+08:00`,
    decidedBy: "seed_operator",
  };

  const denied: ActionCommitment = {
    id: actionId("site_c", priorDate, 3),
    siteId: "site_c",
    sweepId: swp,
    kind: "escalate",
    title: "[SEED] Escalate to OEM — denied_by_policy",
    description:
      "Historical seed fixture: blocked by deterministic governor (policy deny).",
    rmImpact: null,
    kwhImpact: null,
    confidence: "low",
    evidenceRefs: ["seed_fixture", "demo_denied_by_policy"],
    deadline: priorDate,
    approvalClass: "auto",
    status: "denied_by_policy",
    policyDecisions: [
      {
        policyId: "pol_no_control_path",
        outcome: "deny",
        reason: "Escalate would imply external control path; out of policy",
      },
    ],
    verification: null,
    createdAt: `${priorDate}T08:10:00+08:00`,
    decidedAt: `${priorDate}T08:10:00+08:00`,
    decidedBy: "policy_engine",
  };

  return { sweeps: [sweep], actions: [verified, falsified, denied] };
}

/** Shift a YYYY-MM-DD (or ISO) date by whole days using UTC noon to avoid DST edges. */
function shiftIsoDate(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export interface LedgerSeed {
  actions?: ActionCommitment[];
  sweeps?: SweepRun[];
}

export class InMemoryLedger implements ActionLedger {
  private readonly actions = new Map<string, ActionCommitment>();
  private readonly sweeps = new Map<string, SweepRun>();

  constructor(seed: LedgerSeed = {}) {
    for (const a of seed.actions ?? []) {
      this.actions.set(a.id, cloneAction(a));
    }
    for (const s of seed.sweeps ?? []) {
      this.sweeps.set(s.id, cloneSweep(s));
    }
  }

  async saveAction(a: ActionCommitment): Promise<void> {
    this.actions.set(a.id, cloneAction(a));
  }

  async getAction(id: string): Promise<ActionCommitment | null> {
    const a = this.actions.get(id);
    return a ? cloneAction(a) : null;
  }

  async listActions(filter: ActionListFilter = {}): Promise<ActionCommitment[]> {
    let rows = [...this.actions.values()];
    if (filter.siteId !== undefined) {
      rows = rows.filter((a) => a.siteId === filter.siteId);
    }
    if (filter.status !== undefined) {
      rows = rows.filter((a) => a.status === filter.status);
    }
    if (filter.sweepId !== undefined) {
      rows = rows.filter((a) => a.sweepId === filter.sweepId);
    }
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    if (filter.limit !== undefined) {
      rows = rows.slice(0, filter.limit);
    }
    return rows.map(cloneAction);
  }

  async transitionAction(
    id: string,
    next: ActionStatus,
    meta?: TransitionMeta,
  ): Promise<ActionCommitment> {
    const current = this.actions.get(id);
    if (!current) {
      throw new LedgerError("not_found", `Unknown action '${id}'`);
    }
    assertLegalTransition(current.status, next, meta);
    const updated: ActionCommitment = {
      ...cloneAction(current),
      status: next,
      decidedBy: meta?.decidedBy !== undefined ? meta.decidedBy : current.decidedBy,
      decidedAt: meta?.decidedAt !== undefined ? meta.decidedAt : current.decidedAt,
      policyDecisions:
        meta?.policyDecisions !== undefined
          ? meta.policyDecisions.map((p) => ({ ...p }))
          : current.policyDecisions.map((p) => ({ ...p })),
    };
    this.actions.set(id, updated);
    return cloneAction(updated);
  }

  async setVerification(
    id: string,
    v: ActionVerification,
  ): Promise<ActionCommitment> {
    const current = this.actions.get(id);
    if (!current) {
      throw new LedgerError("not_found", `Unknown action '${id}'`);
    }
    assertCanSetVerification(current.status);
    const updated: ActionCommitment = {
      ...cloneAction(current),
      verification: { ...v },
    };
    this.actions.set(id, updated);
    return cloneAction(updated);
  }

  async saveSweep(s: SweepRun): Promise<void> {
    this.sweeps.set(s.id, cloneSweep(s));
  }

  async listSweeps(limit?: number): Promise<SweepRun[]> {
    let rows = [...this.sweeps.values()];
    rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    if (limit !== undefined) rows = rows.slice(0, limit);
    return rows.map(cloneSweep);
  }

  async latestSweep(): Promise<SweepRun | null> {
    const rows = await this.listSweeps(1);
    return rows[0] ?? null;
  }
}

function cloneAction(a: ActionCommitment): ActionCommitment {
  return {
    ...a,
    evidenceRefs: [...a.evidenceRefs],
    policyDecisions: a.policyDecisions.map((p) => ({ ...p })),
    verification: a.verification ? { ...a.verification } : null,
  };
}

function cloneSweep(s: SweepRun): SweepRun {
  return { ...s, notes: [...s.notes] };
}

// ---------------------------------------------------------------------------
// Minimal structural D1 surface (so tests can fake Workers without runtime)
// ---------------------------------------------------------------------------

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1BoundStatement;
}

export interface D1BoundStatement {
  run(): Promise<unknown>;
  all(): Promise<{ results: Record<string, unknown>[] }>;
  first(): Promise<Record<string, unknown> | null>;
}

export interface D1Like {
  prepare(sql: string): D1PreparedStatement;
}

// ---------------------------------------------------------------------------
// Row <-> domain mapping (tested precisely via D1Ledger round-trips)
// ---------------------------------------------------------------------------

export interface ActionRow {
  id: string;
  siteId: string;
  sweepId: string;
  kind: string;
  title: string;
  description: string;
  rmImpact: number | null;
  kwhImpact: number | null;
  confidence: string;
  evidenceRefs: string;
  deadline: string;
  approvalClass: string;
  status: string;
  policyDecisions: string;
  verification: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface SweepRow {
  id: string;
  asOfDate: string;
  startedAt: string;
  siteCount: number;
  proposedActions: number;
  blockedActions: number;
  notes: string;
}

export function actionToRow(a: ActionCommitment): ActionRow {
  return {
    id: a.id,
    siteId: a.siteId,
    sweepId: a.sweepId,
    kind: a.kind,
    title: a.title,
    description: a.description,
    rmImpact: a.rmImpact,
    kwhImpact: a.kwhImpact,
    confidence: a.confidence,
    evidenceRefs: JSON.stringify(a.evidenceRefs),
    deadline: a.deadline,
    approvalClass: a.approvalClass,
    status: a.status,
    policyDecisions: JSON.stringify(a.policyDecisions),
    verification: a.verification === null ? null : JSON.stringify(a.verification),
    createdAt: a.createdAt,
    decidedAt: a.decidedAt,
    decidedBy: a.decidedBy,
  };
}

export function rowToAction(row: Record<string, unknown>): ActionCommitment {
  const verificationRaw = row.verification;
  let verification: ActionVerification | null = null;
  if (verificationRaw !== null && verificationRaw !== undefined && verificationRaw !== "") {
    verification =
      typeof verificationRaw === "string"
        ? (JSON.parse(verificationRaw) as ActionVerification)
        : (verificationRaw as ActionVerification);
  }

  const evidenceRefsRaw = row.evidenceRefs;
  const policyRaw = row.policyDecisions;

  return {
    id: String(row.id),
    siteId: String(row.siteId),
    sweepId: String(row.sweepId),
    kind: row.kind as ActionCommitment["kind"],
    title: String(row.title),
    description: String(row.description),
    rmImpact: row.rmImpact === null || row.rmImpact === undefined ? null : Number(row.rmImpact),
    kwhImpact:
      row.kwhImpact === null || row.kwhImpact === undefined ? null : Number(row.kwhImpact),
    confidence: row.confidence as ActionCommitment["confidence"],
    evidenceRefs:
      typeof evidenceRefsRaw === "string"
        ? (JSON.parse(evidenceRefsRaw) as string[])
        : ((evidenceRefsRaw as string[]) ?? []),
    deadline: String(row.deadline),
    approvalClass: row.approvalClass as ActionCommitment["approvalClass"],
    status: row.status as ActionStatus,
    policyDecisions:
      typeof policyRaw === "string"
        ? (JSON.parse(policyRaw) as PolicyDecision[])
        : ((policyRaw as PolicyDecision[]) ?? []),
    verification,
    createdAt: String(row.createdAt),
    decidedAt:
      row.decidedAt === null || row.decidedAt === undefined ? null : String(row.decidedAt),
    decidedBy:
      row.decidedBy === null || row.decidedBy === undefined ? null : String(row.decidedBy),
  };
}

export function sweepToRow(s: SweepRun): SweepRow {
  return {
    id: s.id,
    asOfDate: s.asOfDate,
    startedAt: s.startedAt,
    siteCount: s.siteCount,
    proposedActions: s.proposedActions,
    blockedActions: s.blockedActions,
    notes: JSON.stringify(s.notes),
  };
}

export function rowToSweep(row: Record<string, unknown>): SweepRun {
  const notesRaw = row.notes;
  return {
    id: String(row.id),
    asOfDate: String(row.asOfDate),
    startedAt: String(row.startedAt),
    siteCount: Number(row.siteCount),
    proposedActions: Number(row.proposedActions),
    blockedActions: Number(row.blockedActions),
    notes:
      typeof notesRaw === "string"
        ? (JSON.parse(notesRaw) as string[])
        : ((notesRaw as string[]) ?? []),
  };
}

// ---------------------------------------------------------------------------
// D1 implementation
// ---------------------------------------------------------------------------

const ACTION_COLS =
  "id, siteId, sweepId, kind, title, description, rmImpact, kwhImpact, confidence, evidenceRefs, deadline, approvalClass, status, policyDecisions, verification, createdAt, decidedAt, decidedBy";

const ACTION_PLACEHOLDERS = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";

export class D1Ledger implements ActionLedger {
  constructor(private readonly db: D1Like) {}

  async saveAction(a: ActionCommitment): Promise<void> {
    const r = actionToRow(a);
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO actions (${ACTION_COLS}) VALUES (${ACTION_PLACEHOLDERS})`,
      )
      .bind(
        r.id,
        r.siteId,
        r.sweepId,
        r.kind,
        r.title,
        r.description,
        r.rmImpact,
        r.kwhImpact,
        r.confidence,
        r.evidenceRefs,
        r.deadline,
        r.approvalClass,
        r.status,
        r.policyDecisions,
        r.verification,
        r.createdAt,
        r.decidedAt,
        r.decidedBy,
      )
      .run();
  }

  async getAction(id: string): Promise<ActionCommitment | null> {
    const row = await this.db
      .prepare(`SELECT ${ACTION_COLS} FROM actions WHERE id = ?`)
      .bind(id)
      .first();
    return row ? rowToAction(row) : null;
  }

  async listActions(filter: ActionListFilter = {}): Promise<ActionCommitment[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.siteId !== undefined) {
      clauses.push("siteId = ?");
      params.push(filter.siteId);
    }
    if (filter.status !== undefined) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.sweepId !== undefined) {
      clauses.push("sweepId = ?");
      params.push(filter.sweepId);
    }
    let sql = `SELECT ${ACTION_COLS} FROM actions`;
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += " ORDER BY createdAt DESC";
    if (filter.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(filter.limit);
    }
    const { results } = await this.db.prepare(sql).bind(...params).all();
    return results.map(rowToAction);
  }

  async transitionAction(
    id: string,
    next: ActionStatus,
    meta?: TransitionMeta,
  ): Promise<ActionCommitment> {
    const current = await this.getAction(id);
    if (!current) {
      throw new LedgerError("not_found", `Unknown action '${id}'`);
    }
    assertLegalTransition(current.status, next, meta);
    const updated: ActionCommitment = {
      ...current,
      status: next,
      decidedBy: meta?.decidedBy !== undefined ? meta.decidedBy : current.decidedBy,
      decidedAt: meta?.decidedAt !== undefined ? meta.decidedAt : current.decidedAt,
      policyDecisions:
        meta?.policyDecisions !== undefined
          ? meta.policyDecisions.map((p) => ({ ...p }))
          : current.policyDecisions,
    };
    await this.saveAction(updated);
    return updated;
  }

  async setVerification(
    id: string,
    v: ActionVerification,
  ): Promise<ActionCommitment> {
    const current = await this.getAction(id);
    if (!current) {
      throw new LedgerError("not_found", `Unknown action '${id}'`);
    }
    assertCanSetVerification(current.status);
    const updated: ActionCommitment = { ...current, verification: { ...v } };
    await this.saveAction(updated);
    return updated;
  }

  async saveSweep(s: SweepRun): Promise<void> {
    const r = sweepToRow(s);
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO sweeps (id, asOfDate, startedAt, siteCount, proposedActions, blockedActions, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        r.id,
        r.asOfDate,
        r.startedAt,
        r.siteCount,
        r.proposedActions,
        r.blockedActions,
        r.notes,
      )
      .run();
  }

  async listSweeps(limit?: number): Promise<SweepRun[]> {
    let sql =
      "SELECT id, asOfDate, startedAt, siteCount, proposedActions, blockedActions, notes FROM sweeps ORDER BY startedAt DESC";
    const params: unknown[] = [];
    if (limit !== undefined) {
      sql += " LIMIT ?";
      params.push(limit);
    }
    const { results } = await this.db.prepare(sql).bind(...params).all();
    return results.map(rowToSweep);
  }

  async latestSweep(): Promise<SweepRun | null> {
    const row = await this.db
      .prepare(
        "SELECT id, asOfDate, startedAt, siteCount, proposedActions, blockedActions, notes FROM sweeps ORDER BY startedAt DESC LIMIT 1",
      )
      .bind()
      .first();
    return row ? rowToSweep(row) : null;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Fixed demo clock so the module singleton seed is deterministic across reloads. */
const DEMO_SEED_NOW = "2026-07-01T00:00:00+08:00";

let memorySingleton: InMemoryLedger | null = null;

function hasKreditLedgerBinding(env: unknown): env is { KREDIT_LEDGER: D1Like } {
  if (env === null || typeof env !== "object") return false;
  const binding = (env as { KREDIT_LEDGER?: unknown }).KREDIT_LEDGER;
  return (
    binding !== null &&
    typeof binding === "object" &&
    typeof (binding as D1Like).prepare === "function"
  );
}

/**
 * Resolve the action ledger.
 *
 * - When `env.KREDIT_LEDGER` is a D1-like binding → D1Ledger.
 * - Otherwise → process-wide InMemoryLedger seeded with buildDemoSeed.
 *
 * Workers runtime path (not wired in this increment):
 * the D1 binding is read from `getCloudflareContext().env` exported by
 * `@opennextjs/cloudflare` (v1.20.1; see node_modules/@opennextjs/cloudflare/dist/api/index.js
 * re-exporting cloudflare-context.js). Callers in a later increment should pass
 * that env object into getLedger — do not import the helper here yet.
 */
export function getLedger(env?: unknown): ActionLedger {
  if (hasKreditLedgerBinding(env)) {
    return new D1Ledger(env.KREDIT_LEDGER);
  }
  if (!memorySingleton) {
    const seed = buildDemoSeed(DEMO_SEED_NOW);
    memorySingleton = new InMemoryLedger({
      actions: seed.actions,
      sweeps: seed.sweeps,
    });
  }
  return memorySingleton;
}

/** Test-only: reset the in-memory singleton (not for production callers). */
export function _resetLedgerSingletonForTests(): void {
  memorySingleton = null;
}
