# SolarPulse AI — Project Summary

**MAIC Nexus 2026 · T1 Clean Energy**

Solar monitoring systems tell operators how much electricity their panels produced, but not how much they *should* have produced. When a site underperforms, operators cannot easily tell whether the cause is weather or a fault — so they waste field visits chasing weather and leave real equipment problems undetected for weeks. That gap is invisible money: lost kilowatt-hours, lost revenue, and lost CO₂ savings.

**SolarPulse AI is an AI copilot that closes the gap.** It sits above existing monitoring as an intelligence and action layer that forecasts expected generation, detects underperformance *after weather adjustment*, explains the likely cause, ranks the maintenance actions worth taking, quantifies the kWh / RM / CO₂ at stake, and generates an owner-ready report. It turns "Site B produced 12.2 MWh" into "Site B came up 11% short after weather adjustment — that's inverter 3, not weather; inspect it first; worth about 21,700 kWh per month, roughly RM 10,900 (model estimate, verify in the field)."

**What makes it credible is the architecture: the AI explains and orchestrates, while deterministic code calculates every number.** Each forecast, residual, ringgit and carbon figure is produced by a deterministic tool — never invented by the language model. A safety layer rejects any number in an answer that does not trace back to a tool output, and blocks unsafe claims such as fabricated savings or "a crew was dispatched." Every result carries its source provenance and assumptions, and fixture data is always labeled. This is the difference between a trustworthy energy product and a hallucination risk.

**It works today.** The demo runs three sites — a healthy rooftop, a utility farm with a seeded inverter fault (−11%), and a site with faulty telemetry that is correctly flagged as a data issue rather than misdiagnosed as equipment failure. The live copilot orchestrates five to seven deterministic tool calls per question and passes a repeatable CE1–CE5 evaluation pack 5/5 against the live model, including prompt-injection resistance; 41 automated tests cover the engine.

**It fits Malaysia's priorities.** SolarPulse targets T1 keywords — asset monitoring, long-term yield forecasting, smart-grid integration — and aligns with the National Energy Transition Roadmap's renewable-energy targets (31% by 2025, rising to 70% by 2050). It uses public Single Buyer demand context for grid-aware operations.

**The business is recurring and scalable:** priced per monitored site or per megawatt per month, with add-ons for automated reporting, predictive maintenance, and ESG/carbon reporting. One deterministic engine serves any portfolio size, and an efficient model with a 77–95% prompt-cache hit rate keeps per-query cost low. The expansion path covers BESS, EV charging, and project-development intelligence.

**Impact:** SolarPulse does not build new capacity — it recovers the clean energy existing assets silently lose, delivering more renewable kWh and improving grid confidence. We are seeking a pilot solar partner to validate on real assets.

*Stack: TypeScript/Next.js; the in-product copilot uses DeepSeek V4. Demo figures use labeled fixture data and configurable assumptions.*
