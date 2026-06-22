# SolarPulse AI — High-Level Design (HLD)

**Product:** SolarPulse AI · **Internal build name:** SolarOps
**Track:** MAIC Nexus 2026 — T1 Clean Energy

---

## 1. What it is (plain English)

Solar operators can see how much electricity their panels produced, but not whether
that number is *good or bad*. Was it a cloudy day, or is an inverter broken? Should they
send a technician (expensive) or not?

**SolarPulse is an AI copilot that answers exactly that.** For each site it says:

> "Site B should have produced ~13.7 MWh today after weather adjustment. It came up
> **11% short** — and that's not the weather, it looks like **inverter 3** is
> underperforming. Inspect it first. Estimated impact: **~21,700 kWh/month ≈ RM 10,900**.
> (Model estimate — verify in the field.)"

It does five things: **forecast** generation, **detect** underperformance after weather
adjustment, **explain** the likely cause, **rank** the fix actions, and put a
**kWh / RM / CO₂** number on the impact — then generate a shareable owner report.

The demo runs on three clearly-labelled fixture sites:

| Site | Profile | What it demonstrates |
|------|---------|----------------------|
| **Site A** | Healthy C&I rooftop (850 kWp) | Normal operation (~0% residual) |
| **Site B** | Utility farm (2,500 kWp) | A seeded **inverter fault** (−11% daily) |
| **Site C** | Industrial rooftop (1,200 kWp) | **Bad/missing telemetry** (data-quality case) |

---

## 2. The core principle

> **The LLM explains and orchestrates. Deterministic code calculates.**

This is the most important design decision (ADR-0005). LLMs are unreliable with numbers —
they will confidently invent figures. In an energy-and-money product that is unacceptable
and would fail the competition's safety bar.

So the system is split:

- **Deterministic code** computes *every* number (forecast, shortfall, RM, CO₂). Same
  input → same output, always.
- **The LLM** only chooses which tools to call and explains the results in plain language.
- A **safety validator** then checks the answer and **rejects any number that does not
  trace back to a tool output** — so a fabricated figure can never reach the user.

Numbers come from the engine, never from the documents or the model.

---

## 3. Architecture

```
            ┌──────────────────────────────────────────────────────────┐
   DATA     │  3 fixture sites — generation, weather, grid demand       │
            │  (CSV fixtures, clearly labeled is_fixture)               │
            └───────────────────────────┬──────────────────────────────┘
                                        │
            ┌───────────────────────────▼──────────────────────────────┐
  ENGINE    │  Deterministic engine (pure TypeScript — NO LLM)          │
            │  forecast → anomaly → root-cause → recommendation → report│
            └───────────────────────────┬──────────────────────────────┘
                                        │
            ┌───────────────────────────▼──────────────────────────────┐
  SERVICE   │  Service layer + 7 tools (tool_contracts.yaml)            │
  + TOOLS   │  one implementation shared by the agent AND the REST API  │
            └──────────────┬───────────────────────────┬───────────────┘
                           │                           │
            ┌──────────────▼─────────────┐ ┌───────────▼───────────────┐
  COPILOT   │  Mastra agent (DeepSeek)   │ │  REST API + Dashboard      │  SURFACES
            │  picks tools, explains     │ │  (Next.js — P5)            │
            └──────────────┬─────────────┘ └────────────────────────────┘
                           │
            ┌──────────────▼─────────────┐
  SAFETY    │  Numeric-grounding guard   │  every kWh/RM/CO₂/% must
            │  + claim denylist          │  trace to a tool output
            └────────────────────────────┘
```

**Layer by layer:**

1. **Data** — three fixture sites (one day of hourly readings + weather + grid demand),
   labelled `fixture_data`. Every value carries a provenance tag (public / fixture /
   model estimate / assumption), per PDR-003.
2. **Engine** (`src/engine/`) — the analytical brain. Transparent baseline forecast,
   residual-based anomaly detection (with a **data-quality short-circuit** so a sensor
   fault is never misread as an equipment fault), rule-based root-cause classifier, and a
   recommendation ranker that produces kWh/RM/CO₂ impact. Deterministic and unit-tested.
3. **Service + tools** (`src/services/`, `src/tools/`) — a framework-agnostic service
   layer exposes the 7 operations; the 7 Mastra tools and the REST API are both thin
   wrappers over it, so the chat answer and the dashboard can never show different numbers.
4. **Copilot** (`src/agent/`) — a Mastra agent backed by **DeepSeek** orchestrates the
   tools for natural-language questions and writes a fixed **7-part answer**
   (Finding / Evidence / Likely cause / Recommended action / Estimated impact /
   Assumptions / Next step). It works **offline** too (a deterministic, grounded fallback)
   so the public demo needs no API key.
5. **Safety** (`src/agent/safety.ts`) — the guard described in §2. It runs on every answer.
6. **REST API + Dashboard** (`src/app/`, Next.js) — the 7 HTTP endpoints and the
   judge-facing UI (portfolio overview, site detail, copilot, report).

---

## 4. Request flow — "Why is Site B down?"

```
user question
   │
   ▼
copilot  ──► lookup_solar_site ──► forecast_solar_yield ──► detect_asset_underperformance
   │              (site meta)        (expected kWh)            (observed vs expected, cause id)
   │                                                                 │
   │         explain_solar_anomaly ◄──────────────────────────────── ┘
   │              (likely cause)
   │                   │
   │         rank_om_actions  ──►  ranked fixes + kWh/RM/CO₂
   │                   │
   ▼                   ▼
7-part answer  ──►  SAFETY GUARD  ──►  grounded answer + tool trace shown to operator
```

If the model ever produces an ungrounded number or a banned claim ("we dispatched a crew",
"guaranteed savings"), the guard replaces the answer with the tool-grounded version.

---

## 5. The 7 deterministic tools (PDR-005 / `schemas/tool_contracts.yaml`)

| Tool | Purpose |
|------|---------|
| `lookup_solar_site` | Site metadata + latest computed status |
| `forecast_solar_yield` | Expected kWh + confidence band + fixture backtest metric |
| `lookup_grid_demand` | Public Single Buyer demand context (or "unavailable") |
| `detect_asset_underperformance` | Observed vs expected, residual, severity, evidence |
| `explain_solar_anomaly` | Rule-based likely cause + confidence + evidence |
| `rank_om_actions` | Ranked actions with recovery kWh / RM / CO₂ |
| `generate_solar_report` | Owner/O&M report with provenance + assumptions |

---

## 6. Safety model (ADR-0006)

The system **never**: claims a crew was dispatched, guarantees savings, recommends
grid/inverter/BESS control or energy trading, or diagnoses equipment on bad telemetry.
It recommends **inspection / operator review only**, labels fixture data, and states that
estimates require field verification. Enforced two ways: instructions to the model, **and**
the deterministic post-answer guard (the guard is the real backstop).

---

## 7. Evaluation (ADR-0007)

A repeatable eval pack (`npm run eval`) covers CE1–CE5: underperformance triage, day-ahead
forecast + demand context, missing/noisy telemetry fallback, prompt-injection / overclaim
resistance, and report provenance. The pack runs against the deterministic path key-free
(CI gate) and against the **live DeepSeek agent** when `DEEPSEEK_API_KEY` is set (the real
load-bearing-AI test).

---

## 8. Tech stack

- **Language/app:** TypeScript + Next.js (App Router)
- **Agent:** Mastra framework + DeepSeek (`deepseek/deepseek-chat`)
- **Engine/tools:** pure TypeScript + Zod schemas
- **Data:** in-memory store seeded from CSV fixtures (SQLite-ready interface)
- **Tests:** Vitest (41 unit/eval tests) · charts: Recharts

---

## 9. Build status

| Phase | Scope | Status |
|-------|-------|--------|
| P0–P2 | Scaffold + data spine + deterministic engine | ✅ Done |
| P3 | Service layer + 7 Mastra tools | ✅ Done |
| P4 | DeepSeek copilot + safety guard + CE harness | ✅ Done |
| P5 | REST routes + dashboard UI | 🔨 In progress |
| P6 | Final eval + demo QA | ⏳ Pending |

**Known open items:** the live-agent CE evaluation requires `DEEPSEEK_API_KEY` and has not
yet run, so ADR-0007's eval gate is met only for the deterministic path until then.

*Numbers in this document are illustrative; the engine is the source of truth. See the
PDRs and ADRs under `docs/` for the full rationale.*
