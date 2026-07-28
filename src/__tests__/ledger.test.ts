/**
 * KREDIT action ledger tests (I4).
 * Covers InMemoryLedger, transition guard, D1Ledger via FakeD1, getLedger routing,
 * and buildDemoSeed shape. No Workers runtime required.
 */
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
  buildDemoSeed,
  D1Ledger,
  getLedger,
  InMemoryLedger,
  LedgerError,
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
            if (/^INSERT OR REPLACE INTO actions/i.test(normalized)) {
              const cols = [
                "id",
                "siteId",
                "sweepId",
                "kind",
                "title",
                "description",
                "rmImpact",
                "kwhImpact",
                "confidence",
                "evidenceRefs",
                "deadline",
                "approvalClass",
                "status",
                "policyDecisions",
                "verification",
                "createdAt",
                "decidedAt",
                "decidedBy",
              ];
              const row: Record<string, unknown> = {};
              for (let i = 0; i < cols.length; i++) {
                row[cols[i]!] = values[i] ?? null;
              }
              self.table("actions").set(String(row.id), row);
              return { success: true };
            }
            if (/^INSERT OR REPLACE INTO sweeps/i.test(normalized)) {
              const cols = [
                "id",
                "asOfDate",
                "startedAt",
                "siteCount",
                "proposedActions",
                "blockedActions",
                "notes",
              ];
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
    await ledger.saveAction(newer);
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
        await ledger.saveAction(a);
        const next = await ledger.transitionAction(a.id, path.to, path.meta);
        expect(next.status).toBe(path.to);
        if (path.to === "approved") {
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
      await ledger.saveAction(baseAction({ status: "awaiting_approval" }));
      await expectLedgerError(
        ledger.transitionAction(actionId("site_a", "2026-06-20", 1), "issued", {
          decidedBy: "alice",
        }),
        "illegal_transition",
      );
    });

    it("rejects approved WITHOUT decidedBy", async () => {
      const ledger = new InMemoryLedger();
      await ledger.saveAction(baseAction({ status: "awaiting_approval" }));
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
        await ledger.saveAction(
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
      await ledger.saveAction(issued);
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

    // set verification after issue path
    await ledger.saveAction({
      ...action,
      status: "issued",
      decidedBy: "alice",
      decidedAt: "2026-06-20T10:00:00+08:00",
    });
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
    });
    const a3 = baseAction({
      id: actionId("site_b", "2026-06-22", 1),
      siteId: "site_b",
      createdAt: "2026-06-22T08:00:00+08:00",
      status: "proposed",
    });
    await ledger.saveAction(a1);
    await ledger.saveAction(a2);
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
  });
});
