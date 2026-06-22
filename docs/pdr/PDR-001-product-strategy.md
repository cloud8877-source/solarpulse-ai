# PDR-001 — Product Strategy and Research Decision

**Status:** Ready for build  
**Product:** SolarPulse AI  
**Internal build name:** SolarOps  
**Track:** MAIC T1 Clean Energy

## 1. Decision

Build **SolarPulse AI**, an AI Copilot for Solar Asset Performance & Grid Intelligence.

The product helps solar asset owners, EPC/O&M teams, and C&I energy managers:

1. forecast solar generation,
2. detect underperformance after weather adjustment,
3. explain likely root causes,
4. rank O&M actions,
5. estimate kWh, RM, and CO2 impact,
6. generate an owner/operator report with assumptions and provenance.

## 2. Why this is the best product for T1

MAIC T1 explicitly asks for AI across clean-energy deployment, project development, smart-grid integration, asset monitoring, and long-term yield/performance forecasting. SolarPulse hits the strongest overlap:

- **Clean-energy asset monitoring:** underperformance detection and site health.
- **Long-term yield forecasting:** day-ahead, week-ahead, and portfolio forecast.
- **Smart-grid integration:** Single Buyer demand context and demand-window awareness.
- **Clean-energy intelligence:** AI report and recommendation layer.
- **Commercial viability:** clear buyer with solar asset owners, EPCs, O&M providers, and C&I operators.

## 3. Product alternatives researched

| Product idea | Fit to T1 | Data availability | Demo feasibility | Commercial clarity | Risk | Decision |
|---|---:|---:|---:|---:|---|---|
| Solar asset performance + O&M copilot | Very high | High with fixture/open PV + public grid context | High | High | Needs honest fixture labeling | **Build** |
| Grid demand forecasting only | High | Medium/high | Medium | Medium | Commodity; hard to prove buyer | Reject as core; use as context module |
| Project development / siting AI | High | Medium | Medium | High | Needs geospatial, land, tariff, interconnection data | Later module |
| BESS/EV charging optimizer | High | Medium | Medium | Medium/high | Control/data complexity; harder MVP | Later module |
| ESG report generator | Medium | High | High | Medium | More T6 than T1; crowded | Output feature only |
| Generic clean-energy chatbot | Low | High | High | Low | Not load-bearing AI | Reject |

## 4. Ideal customer profile

### Primary ICP

**Solar O&M / asset operations team** managing a portfolio of rooftop and utility-scale PV sites.

Pain:
- knows actual generation but not what generation should have been,
- struggles to separate weather from equipment issues,
- loses time manually comparing dashboards and CSVs,
- needs credible reports for asset owners.

### Secondary ICP

**Commercial & industrial rooftop solar owner / energy manager** who wants to know whether their rooftop system is performing and whether the O&M provider is doing enough.

### Tertiary ICP

**EPC / clean-energy developer** who wants post-install performance transparency and a future project-development intelligence module.

## 5. Buyer and pricing hypothesis

Buyer:
- asset owner,
- O&M provider,
- solar EPC,
- C&I energy manager.

Pricing:
- per monitored site/month,
- or per MW/month,
- add-on for automated reports,
- add-on for predictive maintenance,
- add-on for ESG/REC/carbon reporting.

Initial pricing hypothesis for demo deck:
- Starter: RM/site/month for small portfolios,
- Portfolio: RM/MW/month,
- Enterprise: custom integration for inverter telemetry and O&M workflows.

## 6. Product narrative

SolarPulse does not replace solar monitoring systems. It sits above them as an intelligence and action layer.

Existing monitoring tells operators:  
> “Site B produced 1.92 MWh today.”

SolarPulse tells them:  
> “Site B should have produced 2.21 MWh after weather adjustment. The 13.1% shortfall is likely inverter/string underperformance, not weather. Inspect inverter 3 first. Estimated recoverable energy is 420 kWh/month, subject to field verification.”

## 7. Success metrics

### Competition metrics

- Demo shows real tool calls and calculations.
- Forecast vs actual chart is visible.
- One anomaly is detected with evidence.
- AI answer includes confidence and assumptions.
- Report includes kWh/RM/CO2 estimates.
- Safety eval prevents fake savings and fake dispatch.

### Product metrics

- Forecast WAPE/MAPE improves over naive baseline.
- Anomaly detection catches seeded defects.
- Mean time to detect underperformance is reduced.
- Estimated lost kWh is quantified.
- Report generation time is reduced.

## 8. Non-negotiables

- Do not overclaim real-world performance without partner validation.
- Do not hide fixture/synthetic data.
- Do not let the LLM invent numbers.
- Do not perform autonomous physical dispatch or grid control.
- Do not position this as a generic ESG tool.
