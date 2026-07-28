/**
 * KREDIT action ledger tests (I4 / I4b).
 * Covers InMemoryLedger, transition guard, boundary attacks L1–L5,
 * D1Ledger via FakeD1, getLedger routing, buildDemoSeed, migration drift.
 * No Workers runtime required.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  actionId,
  dateKeyCompact,
  sweepId,
  type ActionCommitment,
  type ActionStatus,
  type ActionVerification,
  type SweepRun,
} from "../domain/actions";
import {
  _resetLedgerSingletonForTests,
  ACTION_COLS,
  buildDemoSeed,
  D1Ledger,
  getLedger,
  InMemoryLedger,
  LedgerError,
  SWEEP_COLS,
  type ActionLedger,
  type D1Like,
  type D1PreparedStatement,
} from "../data/ledger";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseAction(overrides: Partial<ActionCommitment> = {}): ActionCommitment {
  return {
    id: actionId("site_a", "2026-06-20", 1),
    siteId: "site_a",
    sweepId: sweepId("2026-06-20", 1),
    kind: "load_shift",
    title: "Shift load earlier",
    description: "Move chiller peak before noon export window",
    rmImpact: 100,
    kwhImpact: 400,
    confidence: "medium",
    evidenceRefs: ["test_ref"],
    deadline: "2026-06-20",
    approvalClass: "human_signature",
    status: "proposed",
    policyDecisions: [],
    verification: null,
    createdAt: "2026-06-20T08:00:00+08:00",
    decidedAt: null,
    decidedBy: null,
    ...overrides,
  };
}

function baseSweep(overrides: Partial<SweepRun> = {}): SweepRun {
  return {
    id: sweepId("2026-06-20", 1),
    asOfDate: "2026-06-20",
    startedAt: "2026-06-20T07:00:00+08:00",
    siteCount: 3,
    proposedActions: 1,
    blockedActions: 0,
    notes: ["test"],
    ...overrides,
  };
}

async function expectLedgerError(
  p: Promise<unknown>,
  code: LedgerError["code"],
): Promise<void> {
  await expect(p).rejects.toSatisfy((err: unknown) => {
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).code).toBe(code);
    return true;
  });
}

/** Fixture seed for non-proposed rows — not the public saveAction path. */
async function seedAction(
  ledger: InMemoryLedger | D1Ledger,
  a: ActionCommitment,
): Promise<void> {
  await ledger.seedAction(a);
}

/** Walk a proposed action to issued with a real signature (polite path). */
async function issueViaLegalPath(
  ledger: ActionLedger,
  a: ActionCommitment,
  decidedBy = "alice",
): Promise<ActionCommitment> {
  await ledger.saveAction({
    ...a,
    status: "proposed",
    verification: null,
    decidedAt: null,
    decidedBy: null,
  });
  await ledger.transitionAction(a.id, "awaiting_approval");
  await ledger.transitionAction(a.id, "approved", {
    decidedBy,
    decidedAt: "2026-06-20T10:00:00+08:00",
  });
  return ledger.transitionAction(a.id, "issued");
}

// ---------------------------------------------------------------------------
// FakeD1 — stores rows per table from bound params; answers SELECTs simply
// ---------------------------------------------------------------------------

class FakeD1 implements D1Like {
  readonly tables = new Map<string, Map<string, Record<string, unknown>>>();

  private table(name: string): Map<string, Record<string, unknown>> {
    let t = this.tables.get(name);
    if (!t) {
      t = new Map();
      this.tables.set(name, t);
    }
    return t;
  }

  prepare(sql: string): D1PreparedStatement {
    const normalized = sql.replace(/\s+/g, " ").trim();
    const self = this;

    return {
      bind(...values: unknown[]) {
        return {
          async run() {
            // Public create path: pure INSERT (no OR REPLACE)
            if (/^INSERT INTO actions/i.test(normalized) && !/OR REPLACE/i.test(normalized)) {
              const cols = ACTION_COLS.split(", ");
              const row: Record<string, unknown> = {};
              for (let i = 0; i < cols.length; i++) {
                row[cols[i]!] = values[i] ?? null;
              }
              const id = String(row.id);
              if (self.table("actions").has(id)) {
                throw new Error(`FakeD1: UNIQUE constraint failed on actions.id=${id}`);
              }
              self.table("actions").set(id, row);
              return { success: true };
            }
            if (/^INSERT OR REPLACE INTO actions/i.test(normalized)) {
              const cols = ACTION_COLS.split(", ");
              const row: Record<string, unknown> = {};
              for (let i = 0; i < cols.length; i++) {
                row[cols[i]!] = values[i] ?? null;
              }
              self.table("actions").set(String(row.id), row);
              return { success: true };
            }
            if (/^INSERT OR REPLACE INTO sweeps/i.test(normalized)) {
              const cols = SWEEP_COLS.split(", ");
              const row: Record<string, unknown> = {};
              for (let i = 0; i < cols.length; i++) {
                row[cols[i]!] = values[i] ?? null;
              }
              self.table("sweeps").set(String(row.id), row);
              return { success: true };
            }
            throw new Error(`FakeD1: unsupported run SQL: ${normalized}`);
          },
          async all() {
            return { results: self.select(normalized, values) };
          },
          async first() {
            const rows = self.select(normalized, values);
            return rows[0] ?? null;
          },
        };
      },
    };
  }

  private select(sql: string, values: unknown[]): Record<string, unknown>[] {
    const fromActions = /FROM actions/i.test(sql);
    const fromSweeps = /FROM sweeps/i.test(sql);
    const tableName = fromActions ? "actions" : fromSweeps ? "sweeps" : null;
    if (!tableName) throw new Error(`FakeD1: unsupported select: ${sql}`);

    let rows = [...this.table(tableName).values()].map((r) => ({ ...r }));

    // Equality filters from WHERE col = ?
    const whereMatch = sql.match(/WHERE (.+?)(?: ORDER BY| LIMIT|$)/i);
    if (whereMatch) {
      const clause = whereMatch[1]!;
      const parts = clause.split(/\s+AND\s+/i);
      let vi = 0;
      for (const part of parts) {
        const m = part.trim().match(/^(\w+)\s*=\s*\?$/);
        if (!m) continue;
        const col = m[1]!;
        const expected = values[vi++];
        rows = rows.filter((r) => r[col] === expected);
      }
      // remaining values after WHERE are for LIMIT
      values = values.slice(vi);
    }

    const orderMatch = sql.match(/ORDER BY (\w+) (ASC|DESC)/i);
    if (orderMatch) {
      const col = orderMatch[1]!;
      const dir = orderMatch[2]!.toUpperCase();
      rows.sort((a, b) => {
        const av = String(a[col] ?? "");
        const bv = String(b[col] ?? "");
        if (av < bv) return dir === "ASC" ? -1 : 1;
        if (av > bv) return dir === "ASC" ? 1 : -1;
        return 0;
      });
    }

    const limitMatch = sql.match(/LIMIT \?/i);
    if (limitMatch) {
      const lim = Number(values[values.length - 1]);
      rows = rows.slice(0, lim);
    } else {
      const litLimit = sql.match(/LIMIT (\d+)/i);
      if (litLimit) rows = rows.slice(0, Number(litLimit[1]));
    }

    return rows;
  }
}

// ---------------------------------------------------------------------------
// Domain id helpers
// ---------------------------------------------------------------------------

describe("action/sweep id helpers", () => {
  it("builds deterministic compact ids without randomness", () => {
    expect(dateKeyCompact("2026-06-20")).toBe("20260620");
    expect(dateKeyCompact("20260620")).toBe("20260620");
    expect(actionId("site_a", "2026-06-20", 1)).toBe("act_site_a_20260620_1");
    expect(actionId("site_a", "20260620", 2)).toBe("act_site_a_20260620_2");
    expect(sweepId("2026-06-20")).toBe("swp_20260620");
    expect(sweepId("2026-06-20", 3)).toBe("swp_20260620_3");
  });
});

// ---------------------------------------------------------------------------
// buildDemoSeed shape pin
// ---------------------------------------------------------------------------

describe("buildDemoSeed", () => {
  it("pins a prior sweep + 3 labeled historical actions", () => {
    const seed = buildDemoSeed("2026-07-01T00:00:00+08:00");
    expect(seed.sweeps).toHaveLength(1);
    expect(seed.actions).toHaveLength(3);

    const sweep = seed.sweeps[0]!;
    expect(sweep.notes).toContain("seed_fixture");
    expect(sweep.id).toBe(sweepId("2026-06-24", 1));

    const [verified, falsified, denied] = seed.actions;
    expect(verified!.status).toBe("issued");
    expect(verified!.verification?.outcome).toBe("verified");
    expect(verified!.evidenceRefs).toContain("seed_fixture");
    expect(verified!.id).toBe(actionId("site_a", "2026-06-24", 1));

    expect(falsified!.status).toBe("issued");
    expect(falsified!.verification?.outcome).toBe("falsified");
    expect(falsified!.evidenceRefs).toContain("seed_fixture");

    expect(denied!.status).toBe("denied_by_policy");
    expect(denied!.verification).toBeNull();
    expect(denied!.evidenceRefs).toContain("seed_fixture");
  });

  it("loads historical fixtures via constructor seed, not public saveAction", async () => {
    const seed = buildDemoSeed("2026-07-01T00:00:00+08:00");
    const ledger = new InMemoryLedger({
      actions: seed.actions,
      sweeps: seed.sweeps,
    });
    expect((await ledger.listActions()).length).toBe(3);
    const verified = await ledger.getAction(seed.actions[0]!.id);
    expect(verified?.status).toBe("issued");
    expect(verified?.verification?.outcome).toBe("verified");
    // public saveAction still refuses non-proposed even when seed has them
    await expectLedgerError(
      ledger.saveAction(baseAction({ status: "issued" })),
      "invalid_initial_status",
    );
  });
});

// ---------------------------------------------------------------------------
// N11 — migration ↔ mapping drift guard
// ---------------------------------------------------------------------------

describe("N11 migration ↔ mapping column drift guard", () => {
  function columnsFromCreateTable(sql: string, table: string): string[] {
    const re = new RegExp(
      `CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([^;]+?)\\)\\s*;`,
      "is",
    );
    const m = sql.match(re);
    if (!m) throw new Error(`CREATE TABLE ${table} not found in migration`);
    const body = m[1]!;
    return body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("--"))
      .map((line) => line.replace(/,$/, "").trim())
      .map((line) => line.split(/\s+/)[0]!)
      .filter((name) => name.length > 0);
  }

  it("actions/sweeps columns match ACTION_COLS / SWEEP_COLS exactly", () => {
    const sql = readFileSync(
      join(process.cwd(), "migrations/0001_action_ledger.sql"),
      "utf8",
    );
    const actionCols = columnsFromCreateTable(sql, "actions");
    const sweepCols = columnsFromCreateTable(sql, "sweeps");
    expect(actionCols.join(", ")).toBe(ACTION_COLS);
    expect(sweepCols.join(", ")).toBe(SWEEP_COLS);
    // N12 indexes present
    expect(sql).toMatch(/idx_actions_createdAt/);
    expect(sql).toMatch(/idx_sweeps_startedAt/);
  });
});

// ---------------------------------------------------------------------------
// InMemoryLedger
// ---------------------------------------------------------------------------

describe("InMemoryLedger", () => {
  it("CRUD: save, get, list newest-first, filters, sweeps", async () => {
    const ledger = new InMemoryLedger();
    const older = baseAction({
      id: actionId("site_a", "2026-06-20", 1),
      createdAt: "2026-06-20T08:00:00+08:00",
      siteId: "site_a",
      status: "proposed",
    });
    const newer = baseAction({
      id: actionId("site_b", "2026-06-21", 1),
      createdAt: "2026-06-21T08:00:00+08:00",
      siteId: "site_b",
      status: "issued",
      sweepId: sweepId("2026-06-21", 1),
      decidedBy: "op",
      decidedAt: "2026-06-21T09:00:00+08:00",
    });
    const sameSite = baseAction({
      id: actionId("site_a", "2026-06-22", 1),
      createdAt: "2026-06-22T08:00:00+08:00",
      siteId: "site_a",
      status: "proposed",
      sweepId: sweepId("2026-06-20", 1),
    });

    await ledger.saveAction(older);
    // issued row is fixture-seeded (public saveAction rejects non-proposed)
    await seedAction(ledger, newer);
    await ledger.saveAction(sameSite);

    expect(await ledger.getAction(older.id)).toEqual(older);
    expect(await ledger.getAction("missing")).toBeNull();

    const all = await ledger.listActions();
    expect(all.map((a) => a.id)).toEqual([sameSite.id, newer.id, older.id]);

    const bySite = await ledger.listActions({ siteId: "site_a" });
    expect(bySite.map((a) => a.id)).toEqual([sameSite.id, older.id]);

    const byStatus = await ledger.listActions({ status: "issued" });
    expect(byStatus).toHaveLength(1);
    expect(byStatus[0]!.id).toBe(newer.id);

    const bySweep = await ledger.listActions({ sweepId: sweepId("2026-06-20", 1) });
    expect(bySweep.map((a) => a.id).sort()).toEqual([older.id, sameSite.id].sort());

    const limited = await ledger.listActions({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]!.id).toBe(sameSite.id);

    const sw1 = baseSweep({
      id: sweepId("2026-06-20", 1),
      startedAt: "2026-06-20T07:00:00+08:00",
    });
    const sw2 = baseSweep({
      id: sweepId("2026-06-21", 1),
      asOfDate: "2026-06-21",
      startedAt: "2026-06-21T07:00:00+08:00",
    });
    await ledger.saveSweep(sw1);
    await ledger.saveSweep(sw2);
    expect((await ledger.listSweeps()).map((s) => s.id)).toEqual([sw2.id, sw1.id]);
    expect(await ledger.latestSweep()).toEqual(sw2);
    expect(await ledger.listSweeps(1)).toHaveLength(1);
  });

  it("constructor accepts optional seed", async () => {
    const a = baseAction();
    const s = baseSweep();
    const ledger = new InMemoryLedger({ actions: [a], sweeps: [s] });
    expect(await ledger.getAction(a.id)).toEqual(a);
    expect(await ledger.latestSweep()).toEqual(s);
  });

  it("nextSeq returns max+1 for site+day (empty → 1)", async () => {
    const ledger = new InMemoryLedger();
    expect(await ledger.nextSeq("site_a", "2026-06-20")).toBe(1);
    await ledger.saveAction(baseAction({ id: actionId("site_a", "2026-06-20", 1) }));
    await ledger.saveAction(
      baseAction({
        id: actionId("site_a", "2026-06-20", 3),
        siteId: "site_a",
      }),
    );
    await ledger.saveAction(
      baseAction({
        id: actionId("site_b", "2026-06-20", 9),
        siteId: "site_b",
      }),
    );
    await ledger.saveAction(
      baseAction({
        id: actionId("site_a", "2026-06-21", 5),
        siteId: "site_a",
      }),
    );
    expect(await ledger.nextSeq("site_a", "2026-06-20")).toBe(4);
    expect(await ledger.nextSeq("site_b", "2026-06-20")).toBe(10);
    expect(await ledger.nextSeq("site_a", "2026-06-21")).toBe(6);
  });

  describe("transition guard", () => {
    const legalPaths: Array<{
      from: ActionStatus;
      to: ActionStatus;
      meta?: { decidedBy?: string; decidedAt?: string };
    }> = [
      { from: "proposed", to: "awaiting_approval" },
      { from: "proposed", to: "denied_by_policy" },
      {
        from: "awaiting_approval",
        to: "approved",
        meta: { decidedBy: "alice", decidedAt: "2026-06-20T10:00:00+08:00" },
      },
      { from: "awaiting_approval", to: "denied_by_policy" },
      { from: "awaiting_approval", to: "expired" },
      {
        from: "approved",
        to: "issued",
        meta: { decidedBy: "alice", decidedAt: "2026-06-20T10:00:00+08:00" },
      },
    ];

    for (const path of legalPaths) {
      it(`allows ${path.from} -> ${path.to}`, async () => {
        const ledger = new InMemoryLedger();
        const a = baseAction({
          status: path.from,
          decidedBy: path.from === "approved" ? "alice" : null,
          decidedAt: path.from === "approved" ? "2026-06-20T10:00:00+08:00" : null,
        });
        // Non-proposed starting points go through fixture seed, not saveAction.
        if (path.from === "proposed") {
          await ledger.saveAction(a);
        } else {
          await seedAction(ledger, a);
        }
        const next = await ledger.transitionAction(a.id, path.to, path.meta);
        expect(next.status).toBe(path.to);
        if (path.to === "approved") {
          expect(next.decidedBy).toBe("alice");
        }
        if (path.to === "issued") {
          // L4: signature stays the one set at approval, not issue-time meta alone
          expect(next.decidedBy).toBe("alice");
        }
      });
    }

    it("rejects proposed -> issued", async () => {
      const ledger = new InMemoryLedger();
      await ledger.saveAction(baseAction({ status: "proposed" }));
      await expectLedgerError(
        ledger.transitionAction(actionId("site_a", "2026-06-20", 1), "issued"),
        "illegal_transition",
      );
    });

    it("rejects awaiting_approval -> issued", async () => {
      const ledger = new InMemoryLedger();
      await seedAction(ledger, baseAction({ status: "awaiting_approval" }));
      await expectLedgerError(
        ledger.transitionAction(actionId("site_a", "2026-06-20", 1), "issued", {
          decidedBy: "alice",
        }),
        "illegal_transition",
      );
    });

    it("rejects approved WITHOUT decidedBy", async () => {
      const ledger = new InMemoryLedger();
      await seedAction(ledger, baseAction({ status: "awaiting_approval" }));
      await expectLedgerError(
        ledger.transitionAction(actionId("site_a", "2026-06-20", 1), "approved"),
        "illegal_transition",
      );
      await expectLedgerError(
        ledger.transitionAction(actionId("site_a", "2026-06-20", 1), "approved", {
          decidedBy: "   ",
        }),
        "illegal_transition",
      );
    });

    it("rejects issued -> anything and denied/expired terminals", async () => {
      const ledger = new InMemoryLedger();
      for (const terminal of ["issued", "denied_by_policy", "expired"] as const) {
        const id = actionId("site_a", "2026-06-20", terminal === "issued" ? 1 : 2);
        await seedAction(
          ledger,
          baseAction({
            id,
            status: terminal,
            decidedBy: "alice",
            decidedAt: "2026-06-20T10:00:00+08:00",
          }),
        );
        await expectLedgerError(
          ledger.transitionAction(id, "proposed"),
          "illegal_transition",
        );
      }
    });

    it("rejects verification on non-issued; allows falsified on issued", async () => {
      const ledger = new InMemoryLedger();
      const proposed = baseAction({ status: "proposed" });
      await ledger.saveAction(proposed);
      const v: ActionVerification = {
        outcome: "falsified",
        measuredRm: 1,
        note: "no lift",
        verifiedAt: "2026-06-25T10:00:00+08:00",
      };
      await expectLedgerError(
        ledger.setVerification(proposed.id, v),
        "verification_not_allowed",
      );

      const issued = baseAction({
        id: actionId("site_a", "2026-06-20", 9),
        status: "issued",
        decidedBy: "alice",
        decidedAt: "2026-06-20T10:00:00+08:00",
      });
      await seedAction(ledger, issued);
      const updated = await ledger.setVerification(issued.id, v);
      expect(updated.verification).toEqual(v);
      // round-trip
      expect((await ledger.getAction(issued.id))!.verification).toEqual(v);
    });

    it("full happy path proposed → awaiting → approved → issued + verified", async () => {
      const ledger = new InMemoryLedger();
      const a = baseAction();
      await ledger.saveAction(a);
      await ledger.transitionAction(a.id, "awaiting_approval");
      await ledger.transitionAction(a.id, "approved", {
        decidedBy: "bob",
        decidedAt: "2026-06-20T11:00:00+08:00",
        policyDecisions: [
          {
            policyId: "pol_x",
            outcome: "require_approval",
            reason: "threshold",
          },
        ],
      });
      const issued = await ledger.transitionAction(a.id, "issued");
      expect(issued.status).toBe("issued");
      expect(issued.decidedBy).toBe("bob");
      const verified = await ledger.setVerification(a.id, {
        outcome: "verified",
        measuredRm: 98,
        note: "ok",
        verifiedAt: "2026-06-27T12:00:00+08:00",
      });
      expect(verified.verification?.outcome).toBe("verified");
    });
  });
});

// ---------------------------------------------------------------------------
// D1Ledger + FakeD1
// ---------------------------------------------------------------------------

describe("D1Ledger (FakeD1)", () => {
  it("round-trips actions and sweeps including JSON columns", async () => {
    const db = new FakeD1();
    const ledger = new D1Ledger(db);

    const action = baseAction({
      evidenceRefs: ["e1", "e2"],
      policyDecisions: [
        { policyId: "p1", outcome: "allow", reason: "ok" },
        { policyId: "p2", outcome: "require_approval", reason: "rm" },
      ],
      verification: null,
      rmImpact: null,
      kwhImpact: 12.5,
    });
    await ledger.saveAction(action);
    const got = await ledger.getAction(action.id);
    expect(got).toEqual(action);

    // issue via legal path (public saveAction cannot set status issued)
    await ledger.transitionAction(action.id, "awaiting_approval");
    await ledger.transitionAction(action.id, "approved", {
      decidedBy: "alice",
      decidedAt: "2026-06-20T10:00:00+08:00",
    });
    await ledger.transitionAction(action.id, "issued");
    const withV = await ledger.setVerification(action.id, {
      outcome: "falsified",
      measuredRm: null,
      note: "seed check",
      verifiedAt: "2026-06-28T00:00:00+08:00",
    });
    expect(withV.verification?.outcome).toBe("falsified");
    expect(withV.verification?.measuredRm).toBeNull();
    expect((await ledger.getAction(action.id))!.verification).toEqual(withV.verification);

    const sweep = baseSweep({
      notes: ["n1", "json_round_trip"],
      proposedActions: 4,
      blockedActions: 1,
    });
    await ledger.saveSweep(sweep);
    expect(await ledger.latestSweep()).toEqual(sweep);
    expect(await ledger.listSweeps()).toEqual([sweep]);
  });

  it("enforces the SAME transition guard", async () => {
    const ledger = new D1Ledger(new FakeD1());
    await ledger.saveAction(baseAction({ status: "proposed" }));
    await expectLedgerError(
      ledger.transitionAction(actionId("site_a", "2026-06-20", 1), "issued"),
      "illegal_transition",
    );
    await expectLedgerError(
      ledger.transitionAction(actionId("site_a", "2026-06-20", 1), "approved"),
      "illegal_transition",
    );
    await ledger.transitionAction(actionId("site_a", "2026-06-20", 1), "awaiting_approval");
    const approved = await ledger.transitionAction(
      actionId("site_a", "2026-06-20", 1),
      "approved",
      { decidedBy: "carol", decidedAt: "2026-06-20T12:00:00+08:00" },
    );
    expect(approved.status).toBe("approved");
    const issued = await ledger.transitionAction(actionId("site_a", "2026-06-20", 1), "issued");
    expect(issued.status).toBe("issued");
    expect(issued.decidedBy).toBe("carol");
  });

  it("listActions filter and newest-first order", async () => {
    const ledger = new D1Ledger(new FakeD1());
    const a1 = baseAction({
      id: actionId("site_a", "2026-06-20", 1),
      siteId: "site_a",
      createdAt: "2026-06-20T08:00:00+08:00",
      status: "proposed",
    });
    const a2 = baseAction({
      id: actionId("site_a", "2026-06-21", 1),
      siteId: "site_a",
      createdAt: "2026-06-21T08:00:00+08:00",
      status: "issued",
      sweepId: sweepId("2026-06-21"),
      decidedBy: "op",
      decidedAt: "2026-06-21T09:00:00+08:00",
    });
    const a3 = baseAction({
      id: actionId("site_b", "2026-06-22", 1),
      siteId: "site_b",
      createdAt: "2026-06-22T08:00:00+08:00",
      status: "proposed",
    });
    await ledger.saveAction(a1);
    await seedAction(ledger, a2);
    await ledger.saveAction(a3);

    expect((await ledger.listActions()).map((a) => a.id)).toEqual([a3.id, a2.id, a1.id]);
    expect((await ledger.listActions({ siteId: "site_a" })).map((a) => a.id)).toEqual([
      a2.id,
      a1.id,
    ]);
    expect((await ledger.listActions({ status: "proposed" })).map((a) => a.id)).toEqual([
      a3.id,
      a1.id,
    ]);
    expect((await ledger.listActions({ limit: 2 })).map((a) => a.id)).toEqual([a3.id, a2.id]);
  });

  it("nextSeq matches InMemory (max+1)", async () => {
    const ledger = new D1Ledger(new FakeD1());
    expect(await ledger.nextSeq("site_a", "2026-06-20")).toBe(1);
    await ledger.saveAction(baseAction({ id: actionId("site_a", "2026-06-20", 2) }));
    await ledger.saveAction(
      baseAction({ id: actionId("site_a", "2026-06-20", 5), siteId: "site_a" }),
    );
    expect(await ledger.nextSeq("site_a", "2026-06-20")).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// N14 — L1–L5 boundary attacks (both backends)
// ---------------------------------------------------------------------------

describe("N14 boundary attacks (L1–L5) on both backends", () => {
  const backends: Array<{
    name: string;
    fresh: () => InMemoryLedger | D1Ledger;
  }> = [
    { name: "InMemoryLedger", fresh: () => new InMemoryLedger() },
    { name: "D1Ledger", fresh: () => new D1Ledger(new FakeD1()) },
  ];

  for (const { name, fresh } of backends) {
    describe(name, () => {

      // L1: cannot create an action born issued with a self-authored grade
      it("L1: saveAction rejects status=issued with verification grade", async () => {
        const ledger = fresh();
        await expectLedgerError(
          ledger.saveAction(
            baseAction({
              status: "issued",
              decidedBy: null,
              verification: {
                outcome: "verified",
                measuredRm: 100,
                note: "self-authored",
                verifiedAt: "2026-06-20T12:00:00+08:00",
              },
            }),
          ),
          "invalid_initial_status",
        );
      });

      it("L1: saveAction rejects non-proposed statuses and pre-set decision fields", async () => {
        const ledger = fresh();
        for (const status of [
          "awaiting_approval",
          "approved",
          "issued",
          "denied_by_policy",
          "expired",
        ] as const) {
          await expectLedgerError(
            ledger.saveAction(baseAction({ status })),
            "invalid_initial_status",
          );
        }
        await expectLedgerError(
          ledger.saveAction(
            baseAction({
              status: "proposed",
              verification: {
                outcome: "verified",
                measuredRm: 1,
                note: "x",
                verifiedAt: "2026-06-20T12:00:00+08:00",
              },
            }),
          ),
          "invalid_initial_status",
        );
        await expectLedgerError(
          ledger.saveAction(baseAction({ decidedBy: "sneaky" })),
          "invalid_initial_status",
        );
        await expectLedgerError(
          ledger.saveAction(baseAction({ decidedAt: "2026-06-20T09:00:00+08:00" })),
          "invalid_initial_status",
        );
      });

      // L2: saveAction with existing id cannot clobber (issued+falsified → proposed)
      it("L2: saveAction rejects duplicate id (no silent clobber of issued+graded)", async () => {
        const ledger = fresh();
        const id = actionId("site_a", "2026-06-20", 1);
        await seedAction(
          ledger,
          baseAction({
            id,
            status: "issued",
            decidedBy: "alice",
            decidedAt: "2026-06-20T10:00:00+08:00",
            verification: {
              outcome: "falsified",
              measuredRm: 0,
              note: "failed",
              verifiedAt: "2026-06-27T10:00:00+08:00",
            },
          }),
        );
        await expectLedgerError(
          ledger.saveAction(
            baseAction({
              id,
              status: "proposed",
              verification: null,
              decidedBy: null,
              decidedAt: null,
            }),
          ),
          "already_exists",
        );
        const still = await ledger.getAction(id);
        expect(still!.status).toBe("issued");
        expect(still!.verification?.outcome).toBe("falsified");
        expect(still!.decidedBy).toBe("alice");
      });

      // L3: setVerification cannot re-grade falsified → verified
      it("L3: setVerification rejects when grade already set (verification_already_set)", async () => {
        const ledger = fresh();
        const id = actionId("site_a", "2026-06-20", 1);
        await seedAction(
          ledger,
          baseAction({
            id,
            status: "issued",
            decidedBy: "alice",
            decidedAt: "2026-06-20T10:00:00+08:00",
            verification: {
              outcome: "falsified",
              measuredRm: 0,
              note: "failed",
              verifiedAt: "2026-06-27T10:00:00+08:00",
            },
          }),
        );
        await expectLedgerError(
          ledger.setVerification(id, {
            outcome: "verified",
            measuredRm: 999,
            note: "re-grade attack",
            verifiedAt: "2026-06-28T10:00:00+08:00",
          }),
          "verification_already_set",
        );
        const still = await ledger.getAction(id);
        expect(still!.verification?.outcome).toBe("falsified");
        expect(still!.verification?.measuredRm).toBe(0);
      });

      // L4: transitionAction(id,'issued',{decidedBy:'',decidedAt:''}) cannot blank signature
      it("L4: issue-time meta cannot blank or rewrite decidedBy/decidedAt", async () => {
        const ledger = fresh();
        const a = baseAction({ id: actionId("site_a", "2026-06-20", 1) });
        await issueViaLegalPath(ledger, a, "signed_operator");
        // re-issue is illegal (already issued); test blanking on the issue step itself
        const ledger2 = fresh();
        const a2 = baseAction({ id: actionId("site_a", "2026-06-20", 2) });
        await ledger2.saveAction(a2);
        await ledger2.transitionAction(a2.id, "awaiting_approval");
        await ledger2.transitionAction(a2.id, "approved", {
          decidedBy: "signed_operator",
          decidedAt: "2026-06-20T10:00:00+08:00",
        });
        const issued = await ledger2.transitionAction(a2.id, "issued", {
          decidedBy: "",
          decidedAt: "",
        });
        expect(issued.status).toBe("issued");
        expect(issued.decidedBy).toBe("signed_operator");
        expect(issued.decidedAt).toBe("2026-06-20T10:00:00+08:00");

        // also: approved row with blank decidedBy cannot issue
        const ledger3 = fresh();
        await seedAction(
          ledger3,
          baseAction({
            id: actionId("site_a", "2026-06-20", 3),
            status: "approved",
            decidedBy: "",
            decidedAt: "2026-06-20T10:00:00+08:00",
          }),
        );
        await expectLedgerError(
          ledger3.transitionAction(actionId("site_a", "2026-06-20", 3), "issued", {
            decidedBy: "attacker",
            decidedAt: "2026-06-20T11:00:00+08:00",
          }),
          "illegal_transition",
        );
      });

      // L5: seq collisions throw (already_exists) + nextSeq allocates safely
      it("L5: seq collision throws already_exists; nextSeq allocates next free seq", async () => {
        const ledger = fresh();
        const dateKey = "2026-06-20";
        const seq = await ledger.nextSeq("site_a", dateKey);
        expect(seq).toBe(1);
        const id = actionId("site_a", dateKey, seq);
        await ledger.saveAction(baseAction({ id, siteId: "site_a" }));
        // collision on same id
        await expectLedgerError(
          ledger.saveAction(baseAction({ id, siteId: "site_a" })),
          "already_exists",
        );
        const next = await ledger.nextSeq("site_a", dateKey);
        expect(next).toBe(2);
        await ledger.saveAction(
          baseAction({ id: actionId("site_a", dateKey, next), siteId: "site_a" }),
        );
        expect(await ledger.nextSeq("site_a", dateKey)).toBe(3);
      });

      // polite path still fully green
      it("polite path: proposed → awaiting → approved → issued → verified", async () => {
        const ledger = fresh();
        const a = baseAction({ id: actionId("site_a", "2026-06-20", 7) });
        const issued = await issueViaLegalPath(ledger, a, "carol");
        expect(issued.status).toBe("issued");
        expect(issued.decidedBy).toBe("carol");
        expect(issued.verification).toBeNull();
        const verified = await ledger.setVerification(a.id, {
          outcome: "verified",
          measuredRm: 95,
          note: "ok",
          verifiedAt: "2026-06-27T12:00:00+08:00",
        });
        expect(verified.verification?.outcome).toBe("verified");
        // second grade still blocked
        await expectLedgerError(
          ledger.setVerification(a.id, {
            outcome: "falsified",
            measuredRm: 0,
            note: "nope",
            verifiedAt: "2026-06-28T12:00:00+08:00",
          }),
          "verification_already_set",
        );
      });
    });
  }

  it("covers both backends", () => {
    expect(backends.map((x) => x.name)).toEqual(["InMemoryLedger", "D1Ledger"]);
  });
});

// ---------------------------------------------------------------------------
// getLedger routing
// ---------------------------------------------------------------------------

describe("getLedger", () => {
  afterEach(() => {
    _resetLedgerSingletonForTests();
  });

  it("returns InMemory when env absent or empty", () => {
    const a = getLedger();
    const b = getLedger({});
    const c = getLedger({ KREDIT_LEDGER: null });
    const d = getLedger({ KREDIT_LEDGER: {} });
    expect(a).toBeInstanceOf(InMemoryLedger);
    expect(b).toBe(a); // singleton
    expect(c).toBe(a);
    expect(d).toBe(a);
  });

  it("returns D1Ledger when structural binding is present", () => {
    const fake = new FakeD1();
    const ledger = getLedger({ KREDIT_LEDGER: fake });
    expect(ledger).toBeInstanceOf(D1Ledger);
    // does not replace memory singleton
    expect(getLedger()).toBeInstanceOf(InMemoryLedger);
  });

  it("seeds the in-memory singleton with demo fixtures", async () => {
    const ledger = getLedger();
    const actions = await ledger.listActions();
    expect(actions.length).toBe(3);
    expect(actions.every((a) => a.evidenceRefs.includes("seed_fixture"))).toBe(true);
    const sweep = await ledger.latestSweep();
    expect(sweep?.notes).toContain("seed_fixture");
    // demo seed still has issued+graded rows (constructor path, not saveAction)
    const issued = actions.filter((a) => a.status === "issued");
    expect(issued.length).toBe(2);
    expect(issued.some((a) => a.verification?.outcome === "verified")).toBe(true);
    expect(issued.some((a) => a.verification?.outcome === "falsified")).toBe(true);
  });
});
