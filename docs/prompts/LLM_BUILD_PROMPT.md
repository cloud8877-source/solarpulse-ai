# LLM Build Prompt — SolarPulse AI / SolarOps

You are the coding agent for the MAIC T1 Clean Energy project.

## Read first

Read these files in order:

1. `README.md`
2. `source_manifest.md`
3. all `pdr/*.md`
4. all `adr/*.md`
5. `schemas/solarops_schema.sql`
6. `schemas/tool_contracts.yaml`

If working inside the existing AI Smith repo, also read root `AGENTS.md`, `CLAUDE.md`, and `docs/VISION.md` before code changes.

## Product to build

Build **SolarPulse AI**, an AI copilot for solar asset performance and grid intelligence.

MVP flow:

```text
fixture data -> forecast -> anomaly detection -> root cause -> action ranking -> report -> agent answer -> dashboard
```

## Hard rules

- Do not install packages unless explicitly approved.
- Do not rewrite the existing runtime.
- Do not make global prompt hacks.
- Do not let the LLM invent kWh/RM/CO2 values.
- Deterministic tools calculate numbers.
- The LLM only explains and orchestrates tool outputs.
- All outputs must include assumptions and source provenance.
- Fixture/synthetic data must be labeled.
- No autonomous dispatch, grid control, inverter control, energy trading, or guaranteed savings.

## First implementation phase

Start with Phase 1 only:

1. Add fixture data loader for 3 sites.
2. Add forecast baseline function.
3. Add anomaly detector.
4. Add root-cause classifier.
5. Add recommendation ranker.
6. Add unit tests proving:
   - Site A healthy,
   - Site B anomaly,
   - Site C data issue.

After Phase 1, stop and summarize.

## Expected implementation shape

Prefer these modules, adapted to the repo conventions:

```text
solarops/
  data/
  forecast/
  anomalies/
  recommendations/
  reports/
  tools/
  evals/
```

If integrating with AI Smith, map these into the existing TypeScript data plane and dashboard conventions. Keep SolarOps tenant/skill-gated.

## CE evals to implement later

- CE1 underperformance triage
- CE2 day-ahead forecast + demand context
- CE3 missing/noisy telemetry fallback
- CE4 prompt injection / overclaim resistance
- CE5 report provenance

## Output expectation

Before editing code, produce:

1. files you plan to create/change,
2. build sequence,
3. tests to run,
4. any assumptions or blockers.

Then implement one phase at a time.
