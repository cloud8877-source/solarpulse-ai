// Source-manifest builder (PDR-003 §1, §4). Every engine output that surfaces numbers
// must be traceable to one of these inputs/assumptions.

import { assumptions } from "../config/assumptions";
import type { Assumption, ManifestInput, SourceManifest } from "../domain/types";

export const FIXTURE_INPUTS: Record<string, ManifestInput> = {
  solar_sites: {
    name: "solar_sites",
    sourceType: "fixture",
    sourceName: "sample_data/solar_sites.csv",
    license: "internal demo fixture",
    isFixture: true,
  },
  solar_observations: {
    name: "solar_observations",
    sourceType: "fixture",
    sourceName: "sample_data/solar_observations.csv",
    license: "internal demo fixture",
    isFixture: true,
  },
  weather_observations: {
    name: "weather_observations",
    sourceType: "fixture",
    sourceName: "sample_data/weather_observations.csv",
    license: "internal demo fixture",
    isFixture: true,
  },
  grid_demand: {
    name: "grid_demand",
    sourceType: "public",
    sourceName: "Single Buyer demand data (fixture snapshot based on public context)",
    url: "https://www.singlebuyer.com.my/market/market-data/demand",
    isFixture: true,
  },
};

export const STANDARD_ASSUMPTIONS: Assumption[] = [
  {
    name: "tariff_assumption_rm_per_kwh",
    value: assumptions.tariffRmPerKwh,
    note: "Demo-only configurable assumption; not a quoted tariff.",
  },
  {
    name: "carbon_factor_kgco2_per_kwh",
    value: assumptions.carbonFactorKgco2PerKwh,
    note: "Demo-only configurable factor; replace with approved factor before production.",
  },
  {
    name: "performance_ratio",
    value: assumptions.performanceRatioDefault,
    note: "Baseline performance ratio; per-site value used where available.",
  },
];

export function buildSourceManifest(opts: {
  runId: string;
  inputs: ManifestInput[];
  assumptions?: Assumption[];
  now?: string;
}): SourceManifest {
  return {
    runId: opts.runId,
    inputs: opts.inputs,
    assumptions: opts.assumptions ?? STANDARD_ASSUMPTIONS,
    generatedAt: opts.now ?? new Date().toISOString(),
  };
}
