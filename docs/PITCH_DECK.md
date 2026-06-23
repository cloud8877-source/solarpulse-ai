# SolarPulse AI — Pitch Deck

**MAIC Nexus 2026 · T1 Clean Energy** · max 12 slides
*Speaker content per slide. Numbers are from the working demo (fixture data, clearly labeled). Build these as slides; keep the labels honest — the artifact shows exactly these figures.*

---

## Slide 1 — Title

**SolarPulse AI**
*An AI Copilot for Solar Asset Performance & Grid Intelligence*

MAIC Nexus 2026 — T1 Clean Energy
Live demo + public repo: github.com/cloud8877-source/solarpulse-ai

> Speaker: We help solar operators recover lost clean energy by telling them *which* asset is underperforming, *why*, and *what action* is worth taking.

---

## Slide 2 — The problem

Solar monitoring tells operators **what was produced**. It does **not** tell them what *should* have been produced.

- Was today's dip the **weather**, or a **broken inverter**?
- Operators waste field visits chasing weather, and miss real faults for weeks.
- Underperformance is **invisible money**: lost kWh, lost revenue, lost CO₂ savings.

> Speaker: Existing dashboards say "Site B made 12.2 MWh." They don't say whether that's good or bad.

---

## Slide 3 — The solution

**SolarPulse sits *above* monitoring as an intelligence + action layer:**

`forecast → detect underperformance (weather-adjusted) → explain cause → rank actions → quantify kWh / RM / CO₂ → owner report`

It turns *"Site B made 12.2 MWh"* into:

> *"Site B should have made 13.7 MWh after weather adjustment — it came up **11% short**. That's **inverter 3**, not weather. Inspect it first. Worth ~**21,700 kWh/month ≈ RM 10,900**. (Model estimate — verify in the field.)"*

---

## Slide 4 — Why it's trustworthy (the core design)

**The LLM explains and orchestrates. Deterministic code calculates every number.**

- Every kWh / RM / CO₂ / % comes from a **deterministic tool**, never the model's imagination.
- A **safety validator** rejects any number that doesn't trace to a tool output, and blocks fake "crew dispatched" / "guaranteed savings" claims.
- Every output carries **source provenance + assumptions**; fixture data is always labeled.

> Speaker: This is what makes an AI energy product credible instead of a hallucination risk.

---

## Slide 5 — Live demo (it works today)

Three monitored sites; one click each:

| Site | Result | What it proves |
|---|---|---|
| Klang Valley rooftop | **Healthy** (+0.2%) | normal operation |
| Northern Solar Farm | **Anomaly −11.0%** → inverter 3 | weather-adjusted fault detection |
| Penang rooftop | **Data issue** | bad telemetry ≠ equipment fault |

Dashboard: portfolio KPIs → forecast-vs-actual chart → AI copilot (real tool calls) → owner report.

> Speaker: [show the Site B forecast chart — the observed line visibly dips below expected at midday].

---

## Slide 6 — Load-bearing AI, proven by evals

Not a chatbot bolted on — the AI orchestrates **5–7 deterministic tool calls** per question, then explains.

- **CE1–CE5 eval pack passes 5/5 against the live model** (triage, forecast+demand, noisy-telemetry fallback, **prompt-injection resistance**, report provenance).
- **41 automated tests**; deterministic engine is unit-tested on every scenario.
- Repeatable eval gate → the artifact doesn't regress.

> Speaker: We can prove the AI behaves — including refusing to fabricate savings under prompt injection.

---

## Slide 7 — Industry relevance & Malaysia policy fit

Directly on **T1 Clean Energy** keywords: asset monitoring, long-term yield forecasting, smart-grid integration.

- Aligns with **NETR**: renewable-energy share targets **31% (2025) → 40% (2035) → 70% (2050)**, net zero 2050.
- Uses **Single Buyer** demand context for grid-aware operations.
- Built on credible references: NREL PV O&M best practices, pvlib, NREL PVDAQ.

---

## Slide 8 — Customer & buyer (commercial viability)

**Primary ICP:** solar O&M / asset-operations teams managing rooftop + utility-scale PV portfolios.
**Secondary:** C&I rooftop owners; **Tertiary:** EPCs wanting post-install performance transparency.

Pain → value: they know actual generation but not *expected*; SolarPulse separates weather from equipment and produces owner-ready reports.

Partner/ICP proxy: integrated solar providers (e.g. Solarvest-class C&I + asset management).

---

## Slide 9 — Business model

- **Starter:** RM per monitored **site / month** (small portfolios).
- **Portfolio:** RM per **MW / month**.
- **Add-ons:** automated reporting · predictive maintenance · ESG / REC / carbon reporting.
- **Enterprise:** integration with inverter telemetry + O&M workflows.

> Speaker: Recurring, per-asset revenue that scales with installed capacity.

---

## Slide 10 — Scalability & economics

- **Modular vertical skill** — one deterministic engine powers both the API and the AI tools; drops into a portfolio of any size.
- **Cheap to run at scale:** DeepSeek **V4-flash** model + **77–95% prompt-cache hit rate** (cached tokens ~10× cheaper) → low per-query cost.
- **Expansion path:** BESS / EV-charging optimization, project-development siting intelligence, demand response — same intelligence layer.

---

## Slide 11 — Impact (ESG & national)

Every recovered fault is **recovered clean energy**:

- Demo Site B alone: **~21,700 kWh/month** recoverable ≈ **RM 10,900** ≈ **~14,100 kg CO₂/month** avoided (model estimate; tariff/carbon factors are configurable demo assumptions).
- Across a real portfolio this compounds — more clean kWh delivered, higher grid confidence, faster progress to NETR targets.

> Speaker: We don't build new capacity — we recover the clean energy existing assets are silently losing.

---

## Slide 12 — Status, roadmap & the ask

**Working today:** deterministic engine, 7 agent tools, live DeepSeek-V4 copilot (5/5 evals), Next.js dashboard, public repo, honest fixture data.

**Next:** anonymized partner telemetry → pvlib/PVWatts physical model → inverter-pattern ML → O&M outcome feedback.

**The ask:** a **pilot solar partner** (anonymized generation + maintenance logs) to validate on real assets, and support to deploy.

> Closing: *Recover lost clean energy. Improve grid confidence. Accelerate Malaysia's clean-energy future.*
