import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURE_CSV } from "../data/fixtures.gen";
import { loadGridSnapshots, loadObservations, loadSites, loadWeather } from "../data/loader";
import { InMemoryStore } from "../data/store";
import { round } from "../engine/math";

describe("fixture loader (P1 data spine)", () => {
  it("embeds every CSV fixture present on disk", () => {
    const fixturesDir = join(process.cwd(), "src", "data", "fixtures");
    const csvFiles = readdirSync(fixturesDir).filter((name) => name.endsWith(".csv"));
    expect(csvFiles.length).toBeGreaterThan(0);
    for (const file of csvFiles) {
      expect(FIXTURE_CSV).toHaveProperty(file);
      // Exact content match: catches an edited CSV whose re-embed was forgotten,
      // not just a missing key. Regenerate with `npm run embed:fixtures`.
      expect(FIXTURE_CSV[file]).toBe(readFileSync(join(fixturesDir, file), "utf8"));
    }
    // No orphaned embeds for deleted CSVs either.
    expect(Object.keys(FIXTURE_CSV).sort()).toEqual(csvFiles.sort());
  });

  it("loads exactly 3 labeled sites with expected capacities", () => {
    const sites = loadSites();
    expect(sites.map((s) => s.id).sort()).toEqual(["site_a", "site_b", "site_c"]);
    expect(sites.every((s) => s.isFixture)).toBe(true);
    const byId = Object.fromEntries(sites.map((s) => [s.id, s]));
    expect(byId.site_a!.capacityKwp).toBe(850);
    expect(byId.site_b!.capacityKwp).toBe(2500);
    expect(byId.site_c!.capacityKwp).toBe(1200);
    expect(byId.site_a!.performanceRatio).toBeCloseTo(0.78);
  });

  it("loads 3 sites × 11 hours × 4 days of solar and weather observations", () => {
    expect(loadObservations().length).toBe(3 * 11 * 4);
    expect(loadWeather().length).toBe(3 * 11 * 4);
    for (const id of ["site_a", "site_b", "site_c"]) {
      expect(loadObservations().filter((o) => o.siteId === id).length).toBe(44);
      expect(loadWeather().filter((w) => w.siteId === id).length).toBe(44);
    }
  });

  it("preserves Site B seeded inverter_3 underperformance signal", () => {
    const seeded = loadObservations().filter(
      (o) => o.siteId === "site_b" && o.qualityFlags.includes("seeded_inverter_underperformance"),
    );
    expect(seeded.length).toBeGreaterThanOrEqual(5);
    expect(seeded.every((o) => o.inverterId === "inverter_3")).toBe(true);
    expect(seeded.every((o) => o.generationKwh !== null)).toBe(true);
  });

  it("preserves Site C missing generation as null (never coerced to 0)", () => {
    const siteC = loadObservations().filter((o) => o.siteId === "site_c");
    const missing = siteC.filter((o) => o.qualityFlags.includes("missing_generation"));
    expect(missing.length).toBeGreaterThanOrEqual(3);
    expect(missing.every((o) => o.generationKwh === null)).toBe(true);
    // and noisy intervals exist with real values
    const noisy = siteC.filter((o) => o.qualityFlags.includes("generation_noisy"));
    expect(noisy.length).toBeGreaterThan(0);
    expect(noisy.every((o) => o.generationKwh !== null)).toBe(true);
  });

  it("preserves load/import/export empty fields as null (never coerced to 0)", () => {
    const all = loadObservations();
    // site_c missing-generation rows: generation null, export empty → null; load may be present
    const missingGen = all.filter(
      (o) => o.siteId === "site_c" && o.qualityFlags.includes("missing_generation"),
    );
    expect(missingGen.length).toBeGreaterThanOrEqual(3);
    for (const o of missingGen) {
      expect(o.generationKwh).toBeNull();
      expect(o.exportKwh).toBeNull();
      // load may still be present while generation is null
      expect(o.loadKwh).not.toBeNull();
      expect(o.importKwh).not.toBeNull();
    }
    // Every populated energy triple has finite numbers (not accidental zeros from empty cells)
    const withGen = all.filter((o) => o.generationKwh != null);
    expect(withGen.every((o) => o.loadKwh != null && o.importKwh != null && o.exportKwh != null)).toBe(
      true,
    );
  });

  it("enforces energy-balance invariant on every row with non-null generation", () => {
    const rows = loadObservations().filter((o) => o.generationKwh != null);
    expect(rows.length).toBeGreaterThan(0);
    for (const o of rows) {
      expect(o.loadKwh).not.toBeNull();
      expect(o.importKwh).not.toBeNull();
      expect(o.exportKwh).not.toBeNull();
      expect(o.exportKwh!).toBeLessThanOrEqual(o.generationKwh! + 1e-9);
      expect(o.importKwh!).toBeLessThanOrEqual(o.loadKwh! + 1e-9);
      const selfFromGen = round(o.generationKwh! - o.exportKwh!, 3);
      const selfFromLoad = round(o.loadKwh! - o.importKwh!, 3);
      expect(selfFromGen).toBe(selfFromLoad);
      expect(selfFromGen).toBeGreaterThanOrEqual(0);
    }
  });

  it("loads public-context grid snapshots (unchanged)", () => {
    const grid = loadGridSnapshots();
    expect(grid.length).toBe(4);
    expect(grid.every((g) => g.region === "peninsular_malaysia")).toBe(true);
  });

  it("store seeds from fixtures and returns observations sorted by timestamp", () => {
    const store = new InMemoryStore();
    expect(store.listSites().length).toBe(3);
    const obs = store.getObservations("site_b");
    expect(obs.length).toBe(44);
    const timestamps = obs.map((o) => o.timestamp);
    expect(timestamps).toEqual([...timestamps].sort());
  });
});
