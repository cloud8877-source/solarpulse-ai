import { describe, expect, it } from "vitest";
import { CE_CASES } from "../evals/cases";
import { runCase } from "../evals/harness";

// Runs the CE pack against the deterministic offline path (no API key needed) as a CI gate.
// The live-agent evaluation runs via `npm run eval` with DEEPSEEK_API_KEY set.
describe("CE eval pack (offline deterministic path)", () => {
  for (const c of CE_CASES) {
    it(`${c.id} — ${c.title}`, async () => {
      const outcome = await runCase(c, "offline");
      expect(outcome.reasons).toEqual([]);
      expect(outcome.pass).toBe(true);
    });
  }
});
