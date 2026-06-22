# MAIC T1 SolarPulse AI — PDR + ADR Builder Package

**Product:** SolarPulse AI  
**Internal build name:** SolarOps  
**Contest track:** MAIC Nexus Challenge 2026 — T1 Clean Energy  
**Purpose of this package:** Send these docs to a coding LLM / implementation agent so it can build the MVP with clear product, architecture, data, tool, UX, eval, and safety requirements.

## Product decision

Build **SolarPulse AI: an AI Copilot for Solar Asset Performance & Grid Intelligence**.

The winning wedge is **not** a generic energy chatbot and not only a dashboard. The product must answer:

> Which solar asset is underperforming, why is it likely underperforming, what action should the operator take, and what kWh / RM / CO2 impact is at stake?

## Why this product

MAIC T1 asks for clean-energy deployment, smart grid integration, clean-energy asset monitoring, and long-term performance forecasting. SolarPulse directly fits those keywords while remaining demoable with public data + fixture telemetry.

## Package contents

### PDRs

- `pdr/PDR-001-product-strategy.md` — research-backed product decision, market wedge, ICP, alternatives rejected.
- `pdr/PDR-002-mvp-scope-and-user-stories.md` — MVP, user stories, acceptance criteria, non-goals.
- `pdr/PDR-003-data-model-and-source-manifest.md` — datasets, schema, provenance, fixture strategy.
- `pdr/PDR-004-forecast-anomaly-recommendation-engine.md` — model logic, metrics, root-cause rules, impact estimates.
- `pdr/PDR-005-agent-tools-api-contracts.md` — deterministic tool and API contracts.
- `pdr/PDR-006-ux-demo-reporting.md` — dashboard, report, demo script, slide/demo alignment.
- `pdr/PDR-007-eval-safety-and-acceptance.md` — eval pack, safety checks, acceptance tests.
- `pdr/PDR-008-implementation-plan.md` — build sequence for an LLM/coding agent.

### ADRs

- `adr/ADR-0001-product-wedge-solar-asset-performance.md`
- `adr/ADR-0002-platform-vertical-skill.md`
- `adr/ADR-0003-data-provenance-fixture-first.md`
- `adr/ADR-0004-forecasting-method-baseline-first.md`
- `adr/ADR-0005-deterministic-tools-over-llm-calculation.md`
- `adr/ADR-0006-safety-no-control-no-trading-no-guaranteed-savings.md`
- `adr/ADR-0007-demo-eval-gate.md`

### Build aids

- `prompts/LLM_BUILD_PROMPT.md` — paste this into your coding LLM.
- `schemas/solarops_schema.sql` — proposed DB tables.
- `schemas/tool_contracts.yaml` — tool contracts and response schemas.
- `sample_data/*.csv` — starter fixture dataset shape.
- `source_manifest.md` — research links and data anchors.

## Build principle

The LLM explains and orchestrates. Deterministic code calculates forecasts, anomalies, recommendations, RM value, and CO2 estimates.

The first product demo should show:
1. solar portfolio dashboard,
2. day-ahead forecast,
3. underperformance event,
4. AI explanation with tool evidence,
5. ranked O&M action,
6. report with assumptions and source provenance.
