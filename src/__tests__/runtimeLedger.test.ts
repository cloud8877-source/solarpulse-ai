/**
 * getRuntimeLedger — production D1 wiring entry point (I8-hotfix).
 * Outside Workers runtime: falls back to in-memory singleton, never throws.
 * Regression guard: agent routes/pages must not call getLedger() bare.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetLedgerSingletonForTests,
  getLedger,
  InMemoryLedger,
} from "../data/ledger";
import { getRuntimeLedger } from "../data/runtimeLedger";

const ROOT = join(__dirname, "..");

describe("getRuntimeLedger", () => {
  afterEach(() => {
    _resetLedgerSingletonForTests();
  });

  it("outside Workers runtime returns the in-memory singleton and never throws", () => {
    expect(() => getRuntimeLedger()).not.toThrow();
    const a = getRuntimeLedger();
    const b = getLedger();
    expect(a).toBeInstanceOf(InMemoryLedger);
    expect(a).toBe(b);
    // stable across calls
    expect(getRuntimeLedger()).toBe(a);
  });
});

describe("I8 regression: no bare getLedger() on request paths", () => {
  const guarded = [
    "app/api/agent/sweep/route.ts",
    "app/api/agent/actions/[id]/decision/route.ts",
    "app/api/agent/verify/route.ts",
    "app/agent/page.tsx",
  ];

  it.each(guarded)("%s imports getRuntimeLedger and has no bare getLedger()", (rel) => {
    const src = readFileSync(join(ROOT, rel), "utf8");
    expect(src).toMatch(/getRuntimeLedger/);
    // bare call: getLedger( with optional whitespace — not getRuntimeLedger
    expect(src).not.toMatch(/(?<![\w.])getLedger\s*\(/);
    // must not import getLedger from ledger for this path
    expect(src).not.toMatch(/from\s+["']@\/data\/ledger["']/);
  });
});
