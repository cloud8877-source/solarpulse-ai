# SolarPulse AI — AI Disclosure

**MAIC Nexus 2026 · T1 Clean Energy**

This document discloses how AI is used **inside the product** and **to build the product**, in the spirit of the project's own principle: be transparent and do not overclaim.

## 1. AI inside the product

SolarPulse uses a large language model (**DeepSeek V4**, via the Mastra agent framework) as an **AI copilot** that answers operator questions in natural language.

**What the AI does:** it interprets the question, decides which deterministic tools to call, orchestrates them (typically 5–7 tool calls per question), and explains the results in a structured answer.

**What the AI does *not* do — by design:** it never calculates or invents operational numbers. Every forecast, residual, kWh, RM, and CO₂ figure is produced by **deterministic, unit-tested code**, not by the model. A deterministic **safety validator** runs on every answer and removes any quantitative claim that does not trace to a tool output, and blocks unsafe statements (e.g. fabricated savings, "a crew was dispatched"). If the model's draft contains an ungrounded figure, the answer is replaced with the tool-grounded version. This is verified by a repeatable evaluation pack (CE1–CE5), including an explicit prompt-injection / overclaim-resistance test, which passes against the live model.

The AI is therefore **load-bearing but constrained**: it provides the language and orchestration; deterministic code provides the truth.

## 2. AI used to build the product

The codebase was developed with the assistance of **Claude Code (Anthropic's Claude Opus 4.8)** acting as a coding assistant under human direction. AI assisted with writing application code, tests, and documentation drafts (including this pitch deck and summary, generated from the actual working artifact).

All product, architecture, and scope decisions are recorded by the team in the design corpus under `docs/` (8 PDRs and 7 ADRs, human-authored). The AI executed against those decisions; it did not set product direction. Every AI-assisted change was reviewed, tested (41 automated tests), and verified to run before inclusion.

## 3. Data and honesty disclosures

- The demo runs on **clearly labeled fixture (synthetic) data** — no real customer or partner telemetry is used. Every value in the dashboard, copilot answer, and report carries a provenance tag (fixture / public / model estimate / assumption).
- Financial and carbon figures use **configurable demo assumptions** (tariff RM 0.50/kWh, carbon factor 0.65 kgCO₂/kWh, performance ratio 0.78) — these are explicitly not quoted tariffs or approved factors.
- Public context (e.g. Single Buyer demand) is referenced as public/open data; technical references (NREL, pvlib) are cited in `docs/source_manifest.md`.
- Reported metrics (e.g. forecast `fixture_wape`) are **in-sample fixture backtests**, labeled as such, not real-world accuracy claims.

## 4. Summary

AI makes SolarPulse's interface natural and its orchestration autonomous, but the **numbers, safety, and provenance are deterministic and auditable**. The product is at a labeled fixture/demo stage; real-world performance requires validation on partner data.
